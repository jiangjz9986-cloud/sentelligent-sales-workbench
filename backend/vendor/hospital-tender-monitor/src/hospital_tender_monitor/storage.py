"""SQLite persistence for notices, revisions, delivery, source health, and runs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from typing import Iterable

from .models import ClassifiedNotice, NoticeType, RelevanceLevel, SourceHealth, TenderNotice


@dataclass(frozen=True, slots=True)
class SaveOutcome:
    notice_id: int
    revision_id: int
    inserted: bool
    revised: bool
    duplicate: bool


@dataclass(frozen=True, slots=True)
class PendingNotification:
    revision_id: int
    notice_id: int
    classified: ClassifiedNotice
    first_seen_at: datetime
    revision_seen_at: datetime


@dataclass(frozen=True, slots=True)
class RunRecord:
    run_id: int
    started_at: datetime
    finished_at: datetime | None
    success: bool
    source_count: int
    successful_source_count: int
    failed_source_count: int
    notice_count: int
    inserted_count: int
    revised_count: int
    error: str = ""


@dataclass(frozen=True, slots=True)
class SourceHealthSnapshot:
    source_id: str
    last_checked_at: datetime | None
    last_success_at: datetime | None
    last_success: bool | None
    item_count: int | None
    error: str
    stale: bool


@dataclass(frozen=True, slots=True)
class QuickCheckResult:
    ok: bool
    messages: tuple[str, ...]


class RepositoryError(RuntimeError):
    """Safe, stable error raised for repository setup and health failures."""


_SAFE_ERROR_CATEGORIES = frozenset(
    {
        "invalid source response",
        "transport failure",
        "timeout",
        "http failure",
        "response too large",
        "invalid response",
        "business failure",
        "database failure",
        "configuration failure",
        "lock busy",
        "source failure",
        "run failure",
    }
)


def _require_aware_datetime(value: datetime, field_name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be timezone-aware")
    return value


def _to_db_timestamp(value: datetime) -> str:
    _require_aware_datetime(value, "timestamp")
    utc = value.astimezone(timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


def _from_db_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("stored timestamp is not timezone-aware")
    return parsed.astimezone(timezone.utc)


def _json_array(values: Iterable[str]) -> str:
    return json.dumps(list(values), ensure_ascii=False, sort_keys=False, separators=(",", ":"), allow_nan=False)


def _decode_array(value: str) -> tuple[str, ...]:
    data = json.loads(value)
    if not isinstance(data, list) or any(not isinstance(x, str) for x in data):
        raise ValueError("stored JSON array is invalid")
    return tuple(data)


def _canonical(payload: dict[str, object]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _revision_fingerprint(notice: TenderNotice) -> str:
    return _canonical({
        "fingerprint_version": 1,
        "source_id": notice.source_id,
        "source_name": notice.source_name,
        "city": notice.city,
        "title": notice.title,
        "url": notice.url,
        "published_at": _to_db_timestamp(notice.published_at),
        "notice_type": notice.notice_type.value,
        "purchaser": notice.purchaser,
        "project_code": notice.project_code,
        "budget_text": notice.budget_text,
        "deadline_text": notice.deadline_text,
        "content_text": notice.content_text,
        "hospital_names": list(notice.hospital_names),
        "content_sha256": notice.content_sha256,
    })


def _safe_error(error: str, default: str = "source failure") -> str:
    if default not in _SAFE_ERROR_CATEGORIES:
        default = "source failure"
    if not isinstance(error, str) or not error:
        return ""
    normalized = " ".join(error.split()).casefold()
    return normalized if normalized in _SAFE_ERROR_CATEGORIES else default


class Repository:
    _SCHEMA_VERSION = 1
    _EXPECTED_TABLES = frozenset(
        {
            "schema_migrations",
            "sources",
            "notices",
            "notice_revisions",
            "source_health_history",
            "runs",
        }
    )
    _EXPECTED_INDEXES = frozenset(
        {"notices_source_last_seen", "revisions_delivery", "source_health_lookup"}
    )

    def __init__(self, database_path: Path, *, busy_timeout_ms: int = 5_000):
        self.database_path = Path(database_path)
        if type(busy_timeout_ms) is not int or busy_timeout_ms < 0:
            raise ValueError("busy_timeout_ms must be a non-negative integer")
        self.busy_timeout_ms = busy_timeout_ms

    def _connect(self) -> sqlite3.Connection:
        try:
            self.database_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.database_path, timeout=self.busy_timeout_ms / 1000, isolation_level=None)
        except Exception:
            raise RepositoryError("database connection failed") from None
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute(f"PRAGMA busy_timeout = {self.busy_timeout_ms}")
            journal = conn.execute("PRAGMA journal_mode = WAL").fetchone()
            foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()
            busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()
            current_journal = conn.execute("PRAGMA journal_mode").fetchone()
            if not foreign_keys or int(foreign_keys[0]) != 1:
                raise RuntimeError("foreign keys are disabled")
            if not busy_timeout or int(busy_timeout[0]) != self.busy_timeout_ms:
                raise RuntimeError("busy timeout is not configured")
            journal_name = str((journal or current_journal or ("",))[0]).casefold()
            current_name = str((current_journal or ("",))[0]).casefold()
            if journal_name != "wal" or current_name != "wal":
                raise RuntimeError("WAL is not enabled")
            return conn
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            raise RepositoryError("database pragma configuration failed") from None

    @staticmethod
    def _close(conn: sqlite3.Connection | None) -> None:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def _schema_tables(self, conn: sqlite3.Connection) -> set[str]:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        return {str(row[0]) for row in rows}

    def _schema_is_complete(self, conn: sqlite3.Connection) -> bool:
        tables = self._schema_tables(conn)
        if not self._EXPECTED_TABLES <= tables:
            return False
        indexes = {
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()
        }
        if not self._EXPECTED_INDEXES <= indexes:
            return False
        required_columns = {
            "schema_migrations": {"version", "applied_at"},
            "sources": {"source_id", "source_name", "city", "updated_at"},
            "notices": {"id", "identity_key", "identity_sha256", "notice_type", "source_id", "first_seen_at", "last_seen_at"},
            "notice_revisions": {
                "id",
                "notice_id",
                "revision_sha256",
                "revision_number",
                "observed_at",
                "published_at",
                "source_name",
                "city",
                "title",
                "url",
                "source_item_id",
                "purchaser",
                "project_code",
                "budget_text",
                "deadline_text",
                "content_text",
                "hospital_names_json",
                "content_sha256",
                "score",
                "level",
                "matched_terms_json",
                "reasons_json",
                "delivery_state",
                "delivered_at",
            },
            "source_health_history": {"id", "source_id", "checked_at", "success", "item_count", "error"},
            "runs": {"id", "started_at", "finished_at", "success", "source_count", "successful_source_count", "failed_source_count", "notice_count", "inserted_count", "revised_count", "error"},
        }
        for table, expected in required_columns.items():
            columns = {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if not expected <= columns:
                return False
        return True

    def initialize(self) -> None:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            tables = self._schema_tables(conn)
            if "schema_migrations" not in tables:
                if tables & (self._EXPECTED_TABLES - {"schema_migrations"}):
                    raise RuntimeError("partial database schema")
                conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
                versions: set[int] = set()
            else:
                columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(schema_migrations)").fetchall()}
                if not {"version", "applied_at"} <= columns:
                    raise RuntimeError("invalid migration table")
                versions = {int(row[0]) for row in conn.execute("SELECT version FROM schema_migrations")}
            unknown = versions - set(range(1, self._SCHEMA_VERSION + 1))
            if unknown:
                raise RuntimeError("unsupported database schema version")
            if 1 not in versions:
                if tables & (self._EXPECTED_TABLES - {"schema_migrations"}):
                    raise RuntimeError("partial database schema")
                schema_sql = """
                    CREATE TABLE sources (
                        source_id TEXT PRIMARY KEY,
                        source_name TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
                    );
                    CREATE TABLE notices (
                        id INTEGER PRIMARY KEY, identity_key TEXT NOT NULL, identity_sha256 TEXT NOT NULL,
                        notice_type TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(source_id),
                        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
                        UNIQUE(identity_key, notice_type)
                    );
                    CREATE INDEX notices_source_last_seen ON notices(source_id, last_seen_at);
                    CREATE TABLE notice_revisions (
                        id INTEGER PRIMARY KEY, notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
                        revision_sha256 TEXT NOT NULL, revision_number INTEGER NOT NULL, observed_at TEXT NOT NULL,
                        published_at TEXT NOT NULL, source_name TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
                        title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', source_item_id TEXT NOT NULL DEFAULT '', purchaser TEXT NOT NULL DEFAULT '',
                        project_code TEXT NOT NULL DEFAULT '', budget_text TEXT NOT NULL DEFAULT '', deadline_text TEXT NOT NULL DEFAULT '',
                        content_text TEXT NOT NULL DEFAULT '', hospital_names_json TEXT NOT NULL DEFAULT '[]', content_sha256 TEXT NOT NULL,
                        score INTEGER NOT NULL, level TEXT NOT NULL, matched_terms_json TEXT NOT NULL DEFAULT '[]', reasons_json TEXT NOT NULL DEFAULT '[]',
                        delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','delivered')),
                        delivered_at TEXT,
                        UNIQUE(notice_id, revision_sha256), UNIQUE(notice_id, revision_number),
                        CHECK((delivery_state='pending' AND delivered_at IS NULL) OR (delivery_state='delivered' AND delivered_at IS NOT NULL))
                    );
                    CREATE INDEX revisions_delivery ON notice_revisions(delivery_state, level, published_at, id);
                    CREATE TABLE source_health_history (
                        id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id), checked_at TEXT NOT NULL,
                        success INTEGER NOT NULL CHECK(success IN (0,1)), item_count INTEGER NOT NULL CHECK(item_count >= 0), error TEXT NOT NULL DEFAULT ''
                    );
                    CREATE INDEX source_health_lookup ON source_health_history(source_id, checked_at DESC, id DESC);
                    CREATE TABLE runs (
                        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
                        success INTEGER NOT NULL CHECK(success IN (0,1)), source_count INTEGER NOT NULL CHECK(source_count >= 0),
                        successful_source_count INTEGER NOT NULL CHECK(successful_source_count >= 0), failed_source_count INTEGER NOT NULL CHECK(failed_source_count >= 0),
                        notice_count INTEGER NOT NULL CHECK(notice_count >= 0), inserted_count INTEGER NOT NULL CHECK(inserted_count >= 0), revised_count INTEGER NOT NULL CHECK(revised_count >= 0), error TEXT NOT NULL DEFAULT ''
                    );
                """
                for statement in schema_sql.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute("INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)", (_to_db_timestamp(datetime.now(timezone.utc)),))
            elif not self._schema_is_complete(conn):
                raise RuntimeError("partial database schema")
            conn.commit()
        except RepositoryError:
            self._rollback_quietly(conn)
            raise
        except Exception:
            self._rollback_quietly(conn)
            raise RepositoryError("database initialization failed") from None
        finally:
            self._close(conn)

    @staticmethod
    def _rollback_quietly(conn: sqlite3.Connection) -> None:
        try:
            conn.rollback()
        except Exception:
            pass

    def _open_for(self, message: str) -> sqlite3.Connection:
        try:
            return self._connect()
        except RepositoryError:
            raise
        except Exception:
            raise RepositoryError(message) from None

    def _insert_revision(self, conn: sqlite3.Connection, notice_id: int, item: ClassifiedNotice, seen_at: datetime, revision_sha: str, revision_number: int) -> int:
        n = item.notice
        cur = conn.execute("""INSERT INTO notice_revisions
            (notice_id, revision_sha256, revision_number, observed_at, published_at, source_name, city, title, url, source_item_id, purchaser, project_code, budget_text, deadline_text, content_text, hospital_names_json, content_sha256, score, level, matched_terms_json, reasons_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (notice_id, revision_sha, revision_number, _to_db_timestamp(seen_at), _to_db_timestamp(n.published_at), n.source_name, n.city, n.title, n.url, n.source_item_id, n.purchaser, n.project_code, n.budget_text, n.deadline_text, n.content_text, _json_array(n.hospital_names), n.content_sha256, item.score, item.level.value, _json_array(item.matched_terms), _json_array(item.reasons)))
        return int(cur.lastrowid)

    def save_notice(self, item: ClassifiedNotice, *, seen_at: datetime | None = None) -> SaveOutcome:
        seen_at = datetime.now(timezone.utc) if seen_at is None else seen_at
        _require_aware_datetime(seen_at, "seen_at")
        seen_ts = _to_db_timestamp(seen_at)
        n = item.notice
        revision_sha = _revision_fingerprint(n)
        identity_sha = hashlib.sha256(n.identity_key.encode("utf-8")).hexdigest()
        conn: sqlite3.Connection | None = None
        try:
            conn = self._open_for("database notice save failed")
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT INTO sources(source_id,source_name,city,updated_at) VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET source_name=excluded.source_name, city=excluded.city, updated_at=excluded.updated_at", (n.source_id, n.source_name, n.city, seen_ts))
            row = conn.execute("SELECT * FROM notices WHERE identity_key=? AND notice_type=?", (n.identity_key, n.notice_type.value)).fetchone()
            if row is None:
                cur = conn.execute("INSERT INTO notices(identity_key,identity_sha256,notice_type,source_id,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)", (n.identity_key, identity_sha, n.notice_type.value, n.source_id, seen_ts, seen_ts))
                notice_id = int(cur.lastrowid)
                revision_id = self._insert_revision(conn, notice_id, item, seen_at, revision_sha, 1)
                conn.commit()
                return SaveOutcome(notice_id, revision_id, True, False, False)
            notice_id = int(row["id"])
            current = conn.execute("SELECT * FROM notice_revisions WHERE notice_id=? ORDER BY revision_number DESC LIMIT 1", (notice_id,)).fetchone()
            conn.execute("UPDATE notices SET last_seen_at=MAX(last_seen_at, ?) WHERE id=?", (seen_ts, notice_id))
            matching = conn.execute("SELECT * FROM notice_revisions WHERE notice_id=? AND revision_sha256=?", (notice_id, revision_sha)).fetchone()
            if matching:
                conn.execute("UPDATE notice_revisions SET score=?, level=?, matched_terms_json=?, reasons_json=? WHERE id=?", (item.score, item.level.value, _json_array(item.matched_terms), _json_array(item.reasons), matching["id"]))
                conn.commit()
                return SaveOutcome(notice_id, int(matching["id"]), False, False, True)
            revision_number = int(current["revision_number"]) + 1 if current else 1
            revision_id = self._insert_revision(conn, notice_id, item, seen_at, revision_sha, revision_number)
            conn.commit()
            return SaveOutcome(notice_id, revision_id, False, True, False)
        except sqlite3.Error:
            self._rollback_quietly(conn)
            raise RepositoryError("database notice save failed") from None
        except Exception:
            self._rollback_quietly(conn)
            raise
        finally:
            self._close(conn)

    def _hydrate(self, row: sqlite3.Row) -> ClassifiedNotice:
        n = TenderNotice(source_id=row["source_id"], source_name=row["source_name"], city=row["city"], title=row["title"], url=row["url"], published_at=_from_db_timestamp(row["published_at"]), notice_type=NoticeType(row["notice_type"]), purchaser=row["purchaser"], project_code=row["project_code"], budget_text=row["budget_text"], deadline_text=row["deadline_text"], content_text=row["content_text"], hospital_names=_decode_array(row["hospital_names_json"]), source_item_id=row["source_item_id"])
        object.__setattr__(n, "content_sha256", row["content_sha256"])
        return ClassifiedNotice(n, int(row["score"]), RelevanceLevel(row["level"]), _decode_array(row["matched_terms_json"]), _decode_array(row["reasons_json"]))

    def pending_notifications(self, *, levels: tuple[RelevanceLevel, ...] = (RelevanceLevel.HIGH,)) -> tuple[PendingNotification, ...]:
        if not levels:
            return ()
        vals = tuple(level.value for level in levels)
        marks = ",".join("?" for _ in vals)
        conn: sqlite3.Connection | None = None
        try:
            conn = self._open_for("database notification query failed")
            rows = conn.execute(f"""SELECT r.*, n.source_id, n.first_seen_at, n.notice_type FROM notice_revisions r JOIN notices n ON n.id=r.notice_id WHERE r.revision_number=(SELECT MAX(r2.revision_number) FROM notice_revisions r2 WHERE r2.notice_id=r.notice_id) AND r.delivery_state='pending' AND r.level IN ({marks}) ORDER BY r.published_at, r.id""", vals).fetchall()
            return tuple(PendingNotification(int(row["id"]), int(row["notice_id"]), self._hydrate(row), _from_db_timestamp(row["first_seen_at"]), _from_db_timestamp(row["observed_at"])) for row in rows)
        except sqlite3.Error:
            self._rollback_quietly(conn)
            raise RepositoryError("database notification query failed") from None
        except (AttributeError, KeyError, TypeError, ValueError):
            self._rollback_quietly(conn)
            raise RepositoryError("database notification query failed") from None
        finally:
            self._close(conn)

    def mark_delivered(self, revision_ids: Iterable[int], *, delivered_at: datetime | None = None) -> int:
        ids = list(revision_ids)
        if not ids or any(type(i) is not int or i <= 0 for i in ids):
            raise ValueError("revision_ids must contain positive integers")
        ids = list(dict.fromkeys(ids))
        delivered_at = datetime.now(timezone.utc) if delivered_at is None else delivered_at
        _require_aware_datetime(delivered_at, "delivered_at")
        stamp = _to_db_timestamp(delivered_at)
        conn: sqlite3.Connection | None = None
        try:
            conn = self._open_for("database delivery update failed")
            conn.execute("BEGIN IMMEDIATE")
            marks = ",".join("?" for _ in ids)
            cur = conn.execute(f"UPDATE notice_revisions SET delivery_state='delivered', delivered_at=? WHERE id IN ({marks}) AND delivery_state='pending'", (stamp, *ids))
            conn.commit()
            return cur.rowcount
        except sqlite3.Error:
            self._rollback_quietly(conn)
            raise RepositoryError("database delivery update failed") from None
        except Exception:
            self._rollback_quietly(conn)
            raise
        finally:
            self._close(conn)

    def record_source_health(self, health: SourceHealth) -> None:
        if type(health.success) is not bool or type(health.item_count) is not int or health.item_count < 0:
            raise ValueError("invalid source health")
        _require_aware_datetime(health.checked_at, "checked_at")
        stamp = _to_db_timestamp(health.checked_at)
        conn: sqlite3.Connection | None = None
        try:
            conn = self._open_for("database source health write failed")
            conn.execute("BEGIN")
            conn.execute("INSERT INTO sources(source_id,updated_at) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET updated_at=excluded.updated_at", (health.source_id, stamp))
            conn.execute("INSERT INTO source_health_history(source_id,checked_at,success,item_count,error) VALUES(?,?,?,?,?)", (health.source_id, stamp, int(health.success), health.item_count, _safe_error(health.error, "source failure")))
            conn.commit()
        except sqlite3.Error:
            self._rollback_quietly(conn)
            raise RepositoryError("database source health write failed") from None
        except Exception:
            self._rollback_quietly(conn)
            raise
        finally:
            self._close(conn)

    def record_run(self, run: RunRecord) -> int:
        fields = ("source_count", "successful_source_count", "failed_source_count", "notice_count", "inserted_count", "revised_count")
        try:
            started_at = _require_aware_datetime(run.started_at, "started_at")
            finished_at = _require_aware_datetime(run.finished_at, "finished_at")
        except (TypeError, ValueError):
            raise ValueError("invalid run summary") from None
        if (
            type(run.success) is not bool
            or any(type(getattr(run, f)) is not int or getattr(run, f) < 0 for f in fields)
            or finished_at < started_at
            or run.successful_source_count + run.failed_source_count != run.source_count
            or run.inserted_count + run.revised_count > run.notice_count
            or (run.success and run.failed_source_count != 0)
        ):
            raise ValueError("invalid run summary")
        conn: sqlite3.Connection | None = None
        try:
            conn = self._open_for("database run write failed")
            conn.execute("BEGIN")
            cur = conn.execute("INSERT INTO runs(started_at,finished_at,success,source_count,successful_source_count,failed_source_count,notice_count,inserted_count,revised_count,error) VALUES(?,?,?,?,?,?,?,?,?,?)", (_to_db_timestamp(started_at), _to_db_timestamp(finished_at), int(run.success), run.source_count, run.successful_source_count, run.failed_source_count, run.notice_count, run.inserted_count, run.revised_count, _safe_error(run.error, "run failure")))
            conn.commit(); return int(cur.lastrowid)
        except sqlite3.Error:
            self._rollback_quietly(conn)
            raise RepositoryError("database run write failed") from None
        except Exception:
            self._rollback_quietly(conn)
            raise
        finally:
            self._close(conn)

    def health_snapshot(self, source_ids: Iterable[str], *, now: datetime, stale_after: timedelta = timedelta(hours=48)) -> tuple[SourceHealthSnapshot, ...]:
        _require_aware_datetime(now, "now")
        if not isinstance(stale_after, timedelta) or stale_after < timedelta(0):
            raise ValueError("stale_after must be a non-negative timedelta")
        now = now.astimezone(timezone.utc)
        unique = tuple(dict.fromkeys(source_ids))
        conn: sqlite3.Connection | None = None
        try:
            conn = self._open_for("database health snapshot failed")
            output = []
            for source_id in unique:
                latest = conn.execute("SELECT * FROM source_health_history WHERE source_id=? ORDER BY checked_at DESC,id DESC LIMIT 1", (source_id,)).fetchone()
                success = conn.execute("SELECT checked_at FROM source_health_history WHERE source_id=? AND success=1 ORDER BY checked_at DESC,id DESC LIMIT 1", (source_id,)).fetchone()
                last_success_at = _from_db_timestamp(success[0]) if success else None
                output.append(SourceHealthSnapshot(source_id, _from_db_timestamp(latest["checked_at"]) if latest else None, last_success_at, bool(latest["success"]) if latest else None, int(latest["item_count"]) if latest else None, latest["error"] if latest else "", last_success_at is None or last_success_at < now - stale_after))
            return tuple(output)
        except sqlite3.Error:
            self._rollback_quietly(conn)
            raise RepositoryError("database health snapshot failed") from None
        except (KeyError, TypeError, ValueError):
            self._rollback_quietly(conn)
            raise RepositoryError("database health snapshot failed") from None
        finally:
            self._close(conn)

    def export_snapshot(self, *, now: datetime | None = None, limit: int = 500) -> dict[str, object]:
        """Export a bounded, credential-free snapshot for an external consumer.

        The export intentionally contains only normalized notice fields already
        persisted by the monitor.  Raw HTTP responses, PushPlus credentials,
        delivery state, and SQLite details never cross this boundary.
        """
        now = datetime.now(timezone.utc) if now is None else now
        _require_aware_datetime(now, "now")
        if type(limit) is not int or limit < 1 or limit > 500:
            raise ValueError("limit must be an integer between 1 and 500")
        now = now.astimezone(timezone.utc)
        conn: sqlite3.Connection | None = None
        try:
            conn = self._open_for("database snapshot export failed")
            rows = conn.execute(
                """
                SELECT r.*, n.source_id, n.first_seen_at, n.notice_type
                FROM notice_revisions r
                JOIN notices n ON n.id = r.notice_id
                WHERE r.revision_number = (
                  SELECT MAX(r2.revision_number)
                  FROM notice_revisions r2
                  WHERE r2.notice_id = r.notice_id
                )
                ORDER BY r.published_at DESC, r.id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            notices = []
            for row in rows:
                item = self._hydrate(row)
                notice = item.notice
                notices.append({
                    "identityKey": notice.identity_key,
                    "sourceId": notice.source_id,
                    "sourceName": notice.source_name,
                    "city": notice.city,
                    "title": notice.title,
                    "url": notice.url,
                    "publishedAt": _to_db_timestamp(notice.published_at),
                    "noticeType": notice.notice_type.value,
                    "purchaser": notice.purchaser,
                    "projectCode": notice.project_code,
                    "budgetText": notice.budget_text,
                    "deadlineText": notice.deadline_text,
                    "contentText": notice.content_text,
                    "hospitalNames": list(notice.hospital_names),
                    "sourceItemId": notice.source_item_id,
                    "contentSha256": notice.content_sha256,
                    "relevance": item.level.value,
                })

            sources = []
            source_rows = conn.execute("SELECT source_id, source_name FROM sources ORDER BY source_id").fetchall()
            for source in source_rows:
                latest = conn.execute(
                    "SELECT checked_at, success, item_count, error FROM source_health_history WHERE source_id=? ORDER BY checked_at DESC, id DESC LIMIT 1",
                    (source["source_id"],),
                ).fetchone()
                success = conn.execute(
                    "SELECT checked_at FROM source_health_history WHERE source_id=? AND success=1 ORDER BY checked_at DESC, id DESC LIMIT 1",
                    (source["source_id"],),
                ).fetchone()
                status = "unknown"
                if latest:
                    status = "healthy" if bool(latest["success"]) else "error"
                sources.append({
                    "sourceId": source["source_id"],
                    "sourceName": source["source_name"] or source["source_id"],
                    "status": status,
                    "lastRunAt": latest["checked_at"] if latest else None,
                    "lastSuccessAt": success["checked_at"] if success else None,
                    "lastItemCount": int(latest["item_count"]) if latest else 0,
                    "lastUpsertedCount": 0,
                    "lastRejectedCount": 0,
                    "lastError": latest["error"] if latest and latest["error"] else None,
                })

            runs = []
            for row in conn.execute("SELECT * FROM runs ORDER BY finished_at DESC, id DESC LIMIT 20").fetchall():
                runs.append({
                    "id": f"run-{row['id']}",
                    "sourceId": "aggregate",
                    "startedAt": row["started_at"],
                    "finishedAt": row["finished_at"],
                    "status": "success" if bool(row["success"]) else "failed",
                    "fetchedCount": int(row["notice_count"]),
                    "upsertedCount": int(row["inserted_count"] + row["revised_count"]),
                    "rejectedCount": int(row["failed_source_count"]),
                    "errorText": row["error"] or None,
                })
            return {
                "schemaVersion": "hospital-tender-snapshot-v1",
                "generatedAt": _to_db_timestamp(now),
                "notices": notices,
                "sources": sources,
                "runs": runs,
            }
        except RepositoryError:
            raise
        except (sqlite3.Error, KeyError, TypeError, ValueError):
            self._rollback_quietly(conn)
            raise RepositoryError("database snapshot export failed") from None
        finally:
            self._close(conn)

    def quick_check(self) -> QuickCheckResult:
        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            messages = tuple(str(row[0]) for row in conn.execute("PRAGMA quick_check").fetchall())
            if messages == ("ok",):
                return QuickCheckResult(True, messages)
            return QuickCheckResult(False, ("database check failed",))
        except RepositoryError:
            raise
        except Exception:
            raise RepositoryError("database quick check failed") from None
        finally:
            self._close(conn)
