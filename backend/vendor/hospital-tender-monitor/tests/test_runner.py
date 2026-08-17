from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from hospital_tender_monitor.models import NoticeType, TenderNotice
from hospital_tender_monitor.runner import MonitorRunner
from hospital_tender_monitor.sources.base import SourceResult


class _Config:
    # Resolve from the fixture itself so the suite is independent of the
    # caller's cwd (backend root, collector root, or repository root).
    project_root = Path(__file__).resolve().parents[1]
    database_path = Path("monitor.sqlite3")
    timeout_seconds = 1
    retries = 2
    stale_after_hours = 48
    notify_possible = False
    pushplus_token = ""
    sources = ()


class _Repository:
    def __init__(self) -> None:
        self.saved = []
        self.health = []
        self.runs = []

    def initialize(self) -> None:
        pass

    def save_notice(self, item, *, seen_at=None):
        self.saved.append(item)
        return SimpleNamespace(inserted=True, revised=False)

    def pending_notifications(self, *, levels=()):
        return ()

    def record_source_health(self, health) -> None:
        self.health.append(health)

    def record_run(self, run) -> int:
        self.runs.append(run)
        return len(self.runs)


class _Adapter:
    def __init__(self, result: SourceResult) -> None:
        self.result = result

    def fetch(self) -> SourceResult:
        return self.result


def _notice(source_id: str) -> TenderNotice:
    return TenderNotice(
        source_id=source_id,
        source_name="公开来源",
        city="济宁",
        title="示例医院 HIS 采购公告",
        url=f"https://example.test/{source_id}",
        published_at=datetime(2026, 8, 17, tzinfo=timezone.utc),
        notice_type=NoticeType.PROCUREMENT,
        content_text="HIS 采购",
    )


class RunnerIsolationTests(TestCase):
    def test_partial_source_failure_keeps_a_usable_snapshot_run(self) -> None:
        config = _Config()
        config.sources = (
            {"id": "healthy", "adapter": "fixture", "enabled": True},
            {"id": "failed", "adapter": "fixture", "enabled": True},
        )
        repository = _Repository()
        adapters = {
            "healthy": _Adapter(SourceResult(notices=(_notice("healthy"),))),
            "failed": _Adapter(SourceResult(success=False, error="fixture failure")),
        }
        with patch("hospital_tender_monitor.runner.source_factory", side_effect=lambda source, _http: adapters[source["id"]]):
            runner = MonitorRunner(
                config,
                repository=repository,
                http_client=object(),
                lock_path=Path("/tmp/hospital-tender-runner-isolation.lock"),
            )
            summary = runner.run()

        self.assertTrue(summary.success)
        self.assertEqual(summary.successful_source_count, 1)
        self.assertEqual(summary.failed_source_count, 1)
        self.assertEqual(len(repository.saved), 1)
        self.assertEqual([row.success for row in repository.health], [True, False])
        self.assertFalse(repository.runs[0].success)
        self.assertEqual(repository.runs[0].error, "source failure")

    def test_configured_retries_are_the_total_http_attempt_budget(self) -> None:
        config = _Config()
        config.retries = 4
        config.sources = ()
        runner = MonitorRunner(
            config,
            repository=_Repository(),
            http_client=None,
            lock_path=Path("/tmp/hospital-tender-runner-attempt-budget.lock"),
        )
        self.assertEqual(runner.http_client.max_attempts, 4)
        self.assertEqual(runner.http_client.min_interval_seconds, 0.2)

    def test_all_sources_failed_is_not_a_usable_snapshot_run(self) -> None:
        config = _Config()
        config.sources = ({"id": "failed", "adapter": "fixture", "enabled": True},)
        repository = _Repository()
        with patch(
            "hospital_tender_monitor.runner.source_factory",
            return_value=_Adapter(SourceResult(success=False, error="fixture failure")),
        ):
            runner = MonitorRunner(
                config,
                repository=repository,
                http_client=object(),
                lock_path=Path("/tmp/hospital-tender-runner-all-failed.lock"),
            )
            summary = runner.run()

        self.assertFalse(summary.success)
        self.assertEqual(summary.successful_source_count, 0)
        self.assertEqual(summary.failed_source_count, 1)
