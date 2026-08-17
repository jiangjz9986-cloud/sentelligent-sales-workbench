from __future__ import annotations

from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from hospital_tender_monitor.cli import main
from hospital_tender_monitor.models import SourceHealth
from hospital_tender_monitor.runner import RunSummary
from hospital_tender_monitor.storage import Repository, RunRecord


class _PartialRunner:
    def __init__(self, repository: Repository) -> None:
        self.repository = repository

    def run(self, *, include_possible: bool = False) -> RunSummary:
        del include_possible
        now = datetime(2026, 8, 17, tzinfo=timezone.utc)
        return RunSummary(
            started_at=now,
            finished_at=now,
            success=True,
            source_count=2,
            successful_source_count=1,
            failed_source_count=1,
            notice_count=1,
            error="source failure",
        )


class CliPartialExportTests(TestCase):
    def test_run_and_export_keeps_partial_status_while_exiting_successfully(self) -> None:
        with TemporaryDirectory(prefix="hospital-tender-cli-") as root:
            repository = Repository(Path(root) / "collector.sqlite3")
            repository.initialize()
            now = datetime(2026, 8, 17, tzinfo=timezone.utc)
            repository.record_source_health(SourceHealth("healthy", now, True, 1, "", "可用来源", "济宁"))
            repository.record_source_health(SourceHealth("failed", now, False, 0, "provider detail", "失败来源", "东营"))
            repository.record_run(RunRecord(0, now, now, False, 2, 1, 1, 1, 1, 0, "source failure"))
            output = Path(root) / "snapshot.json"
            stdout = io.StringIO()
            runner = _PartialRunner(repository)

            with patch("hospital_tender_monitor.cli.load_config", return_value=object()), \
                    patch("hospital_tender_monitor.cli.MonitorRunner", return_value=runner), \
                    redirect_stdout(stdout):
                exit_code = main(["--project-root", root, "run-and-export", "--output", str(output)])

            self.assertEqual(exit_code, 0)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["runs"][0]["status"], "partial")
            self.assertTrue(json.loads(stdout.getvalue())["run"]["success"])
