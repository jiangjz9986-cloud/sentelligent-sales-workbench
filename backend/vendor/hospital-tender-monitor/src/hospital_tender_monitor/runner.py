"""Run-once orchestration for source collection, classification, persistence, and delivery."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import fcntl
import logging
from pathlib import Path
from typing import Callable, Iterator, Mapping

from .classifier import classify, load_keyword_rules
from .config import AppConfig
from .http import HttpClient
from .models import ClassifiedNotice, RelevanceLevel, SourceHealth
from .notifier import DeliveryResult, PushPlusNotifier
from .sources import (
    DongyingAdapter,
    HospitalHtmlAdapter,
    JiaozhouCentralHospitalAdapter,
    JiningAdapter,
    QingdaoAdapter,
)
from .sources.base import SourceResult
from .storage import Repository, RepositoryError, RunRecord


logger = logging.getLogger(__name__)
DEFAULT_REQUEST_INTERVAL_SECONDS = 0.2


class LockBusyError(RuntimeError):
    """Another monitor process currently owns the run lock."""


class SourceConfigurationError(ValueError):
    """A source entry cannot be mapped to a supported adapter."""


class MissingSourceAdapterError(SourceConfigurationError):
    """A source entry omitted its adapter name."""


def source_factory(source: Mapping[str, object], http_client: HttpClient):
    """Build the configured public adapter; indirect coverage entries are skipped."""
    adapter = str(source.get("adapter", "")).strip().casefold()
    if adapter in {"indirect", "disabled"}:
        return None
    if not adapter:
        raise MissingSourceAdapterError("source adapter is required")
    if adapter == "dongying":
        return DongyingAdapter(source, http_client)
    if adapter == "jining":
        return JiningAdapter(source, http_client)
    if adapter in {"qingdao", "qingdao_html", "qingdao-html"}:
        return QingdaoAdapter(source, http_client)
    if adapter in {
        "jiaozhou_central_hospital",
        "jiaozhou-central-hospital",
        "jiaozhou_hospital",
        "qdjzch",
    }:
        return JiaozhouCentralHospitalAdapter(source, http_client)
    if adapter in {"hospital", "hospital_html", "hospital-html", "generic_html"}:
        return HospitalHtmlAdapter(source, http_client)
    raise SourceConfigurationError("unsupported source adapter")


@dataclass(frozen=True, slots=True)
class RunSummary:
    started_at: datetime
    finished_at: datetime
    success: bool
    source_count: int
    successful_source_count: int
    failed_source_count: int
    notice_count: int
    inserted_count: int = 0
    revised_count: int = 0
    notification_sent: bool = False
    notification_count: int = 0
    dry_run: bool = False
    error: str = ""


def _safe_source_error(_: BaseException | str) -> str:
    return "source failure"


class MonitorRunner:
    """Coordinate one bounded monitor invocation. No listener or background task is created."""

    def __init__(
        self,
        config: AppConfig,
        *,
        repository: Repository | None = None,
        http_client: HttpClient | None = None,
        notifier: PushPlusNotifier | None = None,
        clock: Callable[[], datetime] | None = None,
        lock_path: Path | None = None,
    ) -> None:
        self.config = config
        self.repository = repository or Repository(config.database_path)
        self.http_client = http_client or HttpClient(
            config.timeout_seconds,
            max_attempts=min(5, max(1, config.retries)),
            min_interval_seconds=DEFAULT_REQUEST_INTERVAL_SECONDS,
        )
        self.notifier = notifier or (
            PushPlusNotifier(self.http_client, config.pushplus_token)
            if config.pushplus_token
            else None
        )
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.lock_path = Path(lock_path or (Path(config.database_path).with_suffix(".lock")))

    @contextmanager
    def _run_lock(self) -> Iterator[None]:
        handle = None
        try:
            self.lock_path.parent.mkdir(parents=True, exist_ok=True)
            handle = self.lock_path.open("a+")
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (BlockingIOError, OSError) as exc:
                raise LockBusyError("another monitor run is already running") from exc
            yield
        finally:
            if handle is not None:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
                handle.close()

    def _now(self) -> datetime:
        value = self.clock()
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("clock must return timezone-aware datetime")
        return value.astimezone(timezone.utc)

    def _sources(self) -> list[tuple[Mapping[str, object], object]]:
        output = []
        for source in self.config.sources:
            if source.get("enabled", True) is False:
                continue
            try:
                adapter = source_factory(source, self.http_client)
            except SourceConfigurationError:
                raise
            except Exception:
                raise SourceConfigurationError("invalid source adapter configuration") from None
            if adapter is not None:
                output.append((source, adapter))
        return output

    def _rules(self):
        terms: list[str] = []
        seen: set[str] = set()
        for target in getattr(self.config, "customer_hospitals", ()):
            if not isinstance(target, Mapping):
                continue
            candidates = (target.get("name", ""), *(target.get("aliases", ()) or ()))
            for candidate in candidates:
                if not isinstance(candidate, str) or not candidate.strip():
                    continue
                normalized = " ".join(candidate.casefold().split())
                if normalized not in seen:
                    seen.add(normalized)
                    terms.append(candidate.strip())
        return load_keyword_rules(
            Path(self.config.project_root) / "config" / "keywords.json",
            extra_context=tuple(terms),
        )

    def run(self, *, include_possible: bool | None = None, dry_run: bool = False) -> RunSummary:
        """Collect and process all enabled direct sources once."""
        started = self._now()
        include_possible = self.config.notify_possible if include_possible is None else bool(include_possible)
        with self._run_lock():
            if not dry_run:
                self.repository.initialize()
            rules = self._rules()
            sources = self._sources()
            successful = failed = notice_count = inserted = revised = 0
            classified_items: list[ClassifiedNotice] = []
            health_rows: list[SourceHealth] = []
            for source, adapter in sources:
                source_id = str(source.get("id", ""))
                try:
                    result = adapter.fetch()
                    raw_success = getattr(result, "success", None)
                    if type(raw_success) is not bool:
                        raise RuntimeError("source failure")
                    if not isinstance(result, SourceResult):
                        # Duck-typed adapters remain usable in tests/integrations.
                        result = SourceResult(
                            notices=tuple(getattr(result, "notices", ()) or ()),
                            success=raw_success,
                            error=str(getattr(result, "error", "")),
                        )
                    if not result.success:
                        raise RuntimeError("source failure")
                    successful += 1
                    notices = tuple(result.notices)
                    notice_count += len(notices)
                    for notice in notices:
                        item = classify(notice, rules)
                        if item.level is RelevanceLevel.IRRELEVANT:
                            continue
                        classified_items.append(item)
                        if not dry_run:
                            outcome = self.repository.save_notice(item, seen_at=self._now())
                            inserted += int(outcome.inserted)
                            revised += int(outcome.revised)
                    health = SourceHealth(
                        source_id,
                        self._now(),
                        True,
                        len(notices),
                        "",
                        str(source.get("name", "")).strip(),
                        str(source.get("city", "")).strip(),
                    )
                except Exception as exc:
                    failed += 1
                    health = SourceHealth(
                        source_id,
                        self._now(),
                        False,
                        0,
                        _safe_source_error(exc),
                        str(source.get("name", "")).strip(),
                        str(source.get("city", "")).strip(),
                    )
                    logger.warning("source failed source_id=%s error=%s", source_id, health.error)
                health_rows.append(health)
                if not dry_run:
                    self.repository.record_source_health(health)

            notification_sent = False
            notification_count = 0
            notification_failed = False
            if not dry_run and self.notifier is not None:
                levels = (RelevanceLevel.HIGH, RelevanceLevel.POSSIBLE) if include_possible else (RelevanceLevel.HIGH,)
                pending = self.repository.pending_notifications(levels=levels)
                if pending:
                    try:
                        result = self.notifier.send(tuple(item.classified for item in pending), title="医院IT招标监测")
                        delivered = type(getattr(result, "success", False)) is bool and result.success
                    except Exception:
                        delivered = False
                    if delivered:
                        ids = [item.revision_id for item in pending]
                        notification_count = self.repository.mark_delivered(ids, delivered_at=self._now())
                        notification_sent = True
                    else:
                        notification_failed = True
                        logger.warning("notification failed pending_count=%s", len(pending))
            finished = self._now()
            usable_collection = failed == 0 or successful > 0
            success = usable_collection and not notification_failed
            error = "notification failure" if notification_failed else ("source failure" if failed else "")
            if not dry_run:
                self.repository.record_run(RunRecord(
                    run_id=0,
                    started_at=started,
                    finished_at=finished,
                    # The persisted collector run describes complete source
                    # health.  A partially usable snapshot remains a failed
                    # collector run and is exported to the main system as
                    # partial, while RunSummary.success permits the snapshot.
                    success=failed == 0 and not notification_failed,
                    source_count=len(sources),
                    successful_source_count=successful,
                    failed_source_count=failed,
                    notice_count=notice_count,
                    inserted_count=inserted,
                    revised_count=revised,
                    error="run failure" if notification_failed else error,
                ))
            return RunSummary(started, finished, success, len(sources), successful, failed, notice_count, inserted, revised, notification_sent, notification_count, dry_run, error)

    def health(self):
        """Return persisted source health in UTC; presentation belongs to the CLI."""
        with self._run_lock():
            self.repository.initialize()
            now = self._now()
            ids = [str(source.get("id", "")) for source in self.config.sources if source.get("enabled", True) is not False]
            return self.repository.health_snapshot(ids, now=now, stale_after=timedelta(hours=self.config.stale_after_hours))

    def db_check(self):
        with self._run_lock():
            self.repository.initialize()
            return self.repository.quick_check()


def run_once(
    config: AppConfig,
    *,
    include_possible: bool | None = None,
    dry_run: bool = False,
    **runner_kwargs,
) -> RunSummary:
    """Convenience API used by service wrappers and integrations."""
    return MonitorRunner(config, **runner_kwargs).run(include_possible=include_possible, dry_run=dry_run)


build_source_adapter = source_factory
