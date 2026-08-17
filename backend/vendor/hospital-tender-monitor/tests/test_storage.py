from __future__ import annotations

from datetime import datetime, timezone
from tempfile import TemporaryDirectory
from pathlib import Path
from unittest import TestCase

from hospital_tender_monitor.models import SourceHealth
from hospital_tender_monitor.storage import Repository, RunRecord


class SnapshotHealthTests(TestCase):
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
