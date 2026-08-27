from __future__ import annotations

from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory
from pathlib import Path
from time import monotonic
from unittest import TestCase

from hospital_tender_monitor.models import (
    ClassifiedNotice,
    NoticeType,
    RelevanceLevel,
    SourceHealth,
    TenderNotice,
)
from hospital_tender_monitor.storage import Repository, RunRecord


def _classified(index: int) -> ClassifiedNotice:
    notice = TenderNotice(
        source_id="bulk-source",
        source_name="批量来源",
        city="青岛",
        title=f"医院信息化采购公告 {index}",
        url=f"https://example.test/notices/{index}",
        published_at=datetime(2026, 8, 17, tzinfo=timezone.utc) + timedelta(seconds=index),
        notice_type=NoticeType.PROCUREMENT,
        content_text=f"医院 HIS PACS 采购 {index}",
    )
    return ClassifiedNotice(
        notice,
        100,
        RelevanceLevel.HIGH,
        ("医院",),
        ("强匹配",),
    )


class SnapshotHealthTests(TestCase):
    def test_bulk_notice_persistence_is_one_connection_and_preserves_deduplication(self) -> None:
        with TemporaryDirectory(prefix="hospital-tender-storage-bulk-") as root:
            repository = Repository(Path(root) / "collector.sqlite3")
            repository.initialize()
            original_connect = repository._connect
            connection_count = 0

            def counted_connect():
                nonlocal connection_count
                connection_count += 1
                return original_connect()

            repository._connect = counted_connect
            items = tuple(_classified(index) for index in range(562))
            started = monotonic()
            first = repository.save_notices(items, seen_at=datetime(2026, 8, 18, tzinfo=timezone.utc))
            elapsed = monotonic() - started

            self.assertEqual(connection_count, 1)
            self.assertEqual(len(first), 562)
            self.assertTrue(all(outcome.inserted for outcome in first))
            self.assertLess(elapsed, 5.0)

            connection_count = 0
            repeated = repository.save_notices(items, seen_at=datetime(2026, 8, 19, tzinfo=timezone.utc))
            self.assertEqual(connection_count, 1)
            self.assertEqual(len(repeated), 562)
            self.assertTrue(all(outcome.duplicate for outcome in repeated))

    def test_partial_collector_run_exports_partial_health_without_raw_errors(self) -> None:
        with TemporaryDirectory(prefix="hospital-tender-storage-") as root:
            repository = Repository(Path(root) / "collector.sqlite3")
            repository.initialize()
            now = datetime(2026, 8, 17, tzinfo=timezone.utc)
            repository.record_source_health(SourceHealth("healthy", now, True, 2, "", "济宁公共资源", "济宁"))
            repository.record_source_health(SourceHealth("failed", now, False, 0, "provider detail", "失败来源", "东营"))
            repository.record_run(RunRecord(
                0,
                now,
                now,
                False,
                2,
                1,
                1,
                2,
                0,
                0,
                "source failure",
            ))

            snapshot = repository.export_snapshot(now=now)

        self.assertEqual(snapshot["runs"][0]["status"], "partial")
        self.assertEqual({row["status"] for row in snapshot["sources"]}, {"healthy", "error"})
        failed = next(row for row in snapshot["sources"] if row["sourceId"] == "failed")
        self.assertEqual(failed["sourceName"], "失败来源")
        self.assertEqual(failed["lastError"], "source failure")
        self.assertNotIn("provider detail", str(snapshot))
