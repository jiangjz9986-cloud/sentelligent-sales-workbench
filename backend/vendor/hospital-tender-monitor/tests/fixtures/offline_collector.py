"""Test-only process entry point; every source request is served in memory."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

from hospital_tender_monitor import cli
from hospital_tender_monitor.http import HttpError, HttpResponse
from hospital_tender_monitor.progress import load_collection_progress
from hospital_tender_monitor.runner import MonitorRunner


NOW = datetime(2026, 10, 24, tzinfo=timezone.utc)
SOURCE = {
    "id": "offline-process-source", "name": "Offline process fixture", "adapter": "jining",
    "url": "https://example.test/list", "tenant": "fixture",
    "categories": ["55100101", "551003"],
}


class OfflineHttp:
    def __init__(self, resuming):
        self.resuming = resuming

    def request(self, method, url, **kwargs):
        if "/55100101/" in url:
            item_id = "head"
        elif "/551003/" in url:
            if not self.resuming:
                raise HttpError("offline tail timeout")
            item_id = "tail"
        else:
            return HttpResponse(url, 200, b"")
        body = json.dumps([{
            "id": item_id, "url": item_id,
            "title": "\u793a\u4f8b\u533b\u9662 HIS \u91c7\u8d2d\u516c\u544a", "date": "2026-10-24",
        }]).encode()
        return HttpResponse(url, 200, body)


def main():
    resume_path = next((arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--resume-progress=")), None)
    progress = load_collection_progress(Path(resume_path)) if resume_path else []
    config = SimpleNamespace(
        sources=(SOURCE,), project_root=Path(__file__).resolve().parents[2],
        database_path=Path(os.environ["HOSPITAL_TENDER_MONITOR_DATA_DIR"]) / "offline.sqlite3",
        customer_hospitals=(), timeout_seconds=1, retries=1, stale_after_hours=48,
    )
    runner = MonitorRunner(config, http_client=OfflineHttp(bool(progress)), clock=lambda: NOW)
    with patch.object(cli, "load_config", return_value=config), \
            patch.object(cli, "MonitorRunner", return_value=runner), \
            patch("socket.socket.connect", side_effect=AssertionError("network disabled")):
        return cli.main(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
