from contextlib import contextmanager
from datetime import datetime, timezone
from email.message import Message
from io import BytesIO
from pathlib import Path
import socket
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from urllib.parse import parse_qs, urlsplit

from hospital_tender_monitor.http import HttpClient
from hospital_tender_monitor.runner import MonitorRunner
from hospital_tender_monitor.storage import Repository


NOW = datetime(2026, 10, 24, tzinfo=timezone.utc)
TITLE = "Example Hospital HIS \u533b\u9662\u91c7\u8d2d\u516c\u544a"
DATE = "2026-10-14"


class Clock:
    def __init__(self):
        self.value = 0.0

    def now(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class Response:
    def __init__(self, url, text):
        self.url = url
        self.body = BytesIO(text.encode())
        self.headers = Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"

    def read(self, size):
        return self.body.read(size)

    def geturl(self):
        return self.url

    def getcode(self):
        return 200

    def close(self):
        pass


class OfflineClient(HttpClient):
    def __init__(self, clock):
        self.clock = clock
        self.calls = []
        self.allocations = []
        super().__init__(
            timeout_seconds=45, max_attempts=3, min_interval_seconds=0.2,
            monotonic=clock.now, sleeper=clock.sleep, opener=self.open,
            resolver=lambda _host, port, **_: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))],
        )

    @contextmanager
    def request_budget(self, seconds):
        self.allocations.append(seconds)
        with super().request_budget(seconds):
            yield

    def open(self, request, timeout):
        parts = urlsplit(request.full_url)
        source_id = parts.path.strip("/").split("/")[0]
        page = int(parse_qs(parts.query).get("pn", [1])[0])
        self.calls.append((source_id, page, timeout, self.clock.now()))
        if source_id.startswith("public-"):
            if page > 1:
                # A real HttpClient timeout consumes the adapter's shared
                # budget, including retry/backoff and successive-page checks.
                self.clock.sleep(timeout)
                raise TimeoutError("offline slow page")
            body = "".join(
                f'<li class="list-group-item"><span class="time">{DATE}</span>'
                f'<a href="/{source_id}/Posts/Detail?id={index}">{TITLE} {index}</a></li>'
                for index in range(20)
            )
        else:
            body = f'<ul><li><a href="/{source_id}/notice/1">{TITLE}</a><span>{DATE}</span></li></ul>'
        self.clock.sleep(0.01)
        return Response(request.full_url, body)


class FrozenRunner(MonitorRunner):
    def _sources(self):
        sources = super()._sources()
        for _source, adapter in sources:
            if hasattr(adapter, "clock"):
                adapter.clock = lambda: NOW
        return sources


def public_sources(count):
    return [{
        "id": f"public-{index}", "name": f"Public fixture {index}", "adapter": "jining",
        "url": f"https://example.test/public-{index}/list", "tenant": f"public-{index}",
        "categories": ["55100101"], "hospital_names": ["Example Hospital"],
    } for index in range(count)]


def hospital_source(index):
    return {
        "id": f"hospital-{index}", "name": f"Hospital fixture {index}", "adapter": "hospital_html",
        "url": f"https://example.test/hospital-{index}/list", "title_terms": ["HIS"],
    }


class SourceFairnessTests(TestCase):
    def collect(self, root, sources, progress, *, persistence_seconds=0):
        clock = Clock()
        client = OfflineClient(clock)
        repository = Repository(Path(root) / "collector.sqlite3")
        record_progress = repository.record_collection_progress

        def persist(entry):
            record_progress(entry)
            clock.sleep(persistence_seconds)

        repository.record_collection_progress = persist
        config = SimpleNamespace(
            sources=tuple(sources), project_root=Path(__file__).resolve().parents[1],
            database_path=repository.database_path, customer_hospitals=(),
            timeout_seconds=45, retries=3, stale_after_hours=48,
        )
        runner = FrozenRunner(config, repository=repository, http_client=client,
                              clock=lambda: NOW, monotonic=clock.now)
        summary = runner.run(collection_progress=progress)
        return summary, repository.export_snapshot(now=NOW), client, clock

    def test_later_hospitals_are_requested_every_round_after_eight_slow_public_sources(self):
        public = public_sources(8)
        hospitals = [hospital_source(0), hospital_source(1)]
        # The configured first hospital must still follow all public sources.
        sources = [hospitals[0], *public, hospitals[1]]
        expected_order = [source["id"] for source in [*public, *hospitals]]
        progress = []
        with TemporaryDirectory() as root:
            for round_index in range(3):
                with self.subTest(round=round_index):
                    summary, snapshot, client, clock = self.collect(Path(root) / str(round_index), sources, progress)
                    attempted = list(dict.fromkeys(call[0] for call in client.calls))
                    self.assertEqual(attempted, expected_order)
                    self.assertTrue(summary.success)
                    self.assertEqual(summary.successful_source_count, 2)
                    self.assertEqual(summary.failed_source_count, 8)
                    self.assertTrue(all(0 < allocation <= 45 for allocation in client.allocations))
                    self.assertAlmostEqual(client.allocations[0], 27.0)
                    self.assertAlmostEqual(client.allocations[-1], 45.0)
                    self.assertLessEqual(clock.value, 270.0)
                    states = {row["sourceId"]: row["status"] for row in snapshot["sources"]}
                    self.assertEqual([states[source["id"]] for source in hospitals], ["healthy", "healthy"])
                    self.assertTrue({source["id"] for source in hospitals} <= {row["sourceId"] for row in snapshot["notices"]})
                    progress = snapshot["collectionProgress"]
                    self.assertEqual([entry["cursor"] for entry in progress if entry["sourceId"].startswith("hospital-")], [{}, {}])
                    self.assertTrue(all(entry["cursor"]["page"] == 2 for entry in progress if entry["sourceId"].startswith("public-")))

    def test_all_slow_sources_are_requested_repeatedly_up_to_the_200_source_contract_limit(self):
        for source_count in (8, 64, 200):
            sources = public_sources(source_count)
            expected_order = [source["id"] for source in sources]
            progress = []
            with self.subTest(source_count=source_count), TemporaryDirectory() as root:
                for round_index in range(3):
                    summary, snapshot, client, clock = self.collect(
                        Path(root) / str(round_index), sources, progress, persistence_seconds=0.1,
                    )
                    self.assertEqual(list(dict.fromkeys(call[0] for call in client.calls)), expected_order)
                    self.assertEqual(len(client.allocations), source_count)
                    self.assertTrue(all(0 < allocation <= 45 for allocation in client.allocations))
                    if source_count == 200:
                        self.assertLess(client.allocations[-1], 1.0)
                    self.assertTrue(all(call[3] < 270 for call in client.calls))
                    self.assertLessEqual(clock.value, 270.100001)
                    self.assertEqual(summary.failed_source_count, source_count)
                    if round_index == 0:
                        self.assertTrue(summary.success)
                        self.assertEqual(summary.inserted_count, 20 * source_count)
                        self.assertEqual({row["status"] for row in snapshot["sources"]}, {"degraded"})
                    else:
                        self.assertTrue(all(call[1] == 2 for call in client.calls))
                    progress = snapshot["collectionProgress"]
                    self.assertEqual(len(progress), source_count)
                    self.assertTrue(all(entry["cursor"]["page"] == 2 for entry in progress))
