from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from hospital_tender_monitor.cli import main
from hospital_tender_monitor.http import HttpError, HttpResponse
from hospital_tender_monitor.runner import MonitorRunner
from hospital_tender_monitor.progress import (
    MAX_PROGRESS_BYTES, configuration_digest, load_collection_progress, validate_collection_progress,
)
from hospital_tender_monitor.sources.jining import JiningAdapter
from hospital_tender_monitor.storage import Repository


NOW = datetime(2026, 10, 24, tzinfo=timezone.utc)
SOURCE = {
    "id": "jining-progress", "adapter": "jining", "name": "fixture",
    "url": "https://example.test/list", "tenant": "test",
    "categories": ["55100101", "553001"],
    "hospital_names": ["Example Hospital A", "Example Hospital B"],
}


class FrozenRunner(MonitorRunner):
    def _sources(self):
        sources = super()._sources()
        for _source, adapter in sources:
            adapter.clock = lambda: NOW
        return sources


def listing(key, count=1):
    return "".join(
        f'<li class="list-group-item"><span class="time">2026-10-24</span>'
        f'<a href="/Posts/Detail?id={key}-{index}">Example Hospital A HIS procurement {key}</a></li>'
        for index in range(count)
    )


class FixtureHttp:
    def __init__(self, fail_at=None):
        self.fail_at = fail_at
        self.calls = []
        self.budgets = []

    def request_budget(self, seconds):
        from contextlib import nullcontext
        self.budgets.append(seconds)
        return nullcontext()

    def request(self, method, url, **kwargs):
        query = parse_qs(urlsplit(url).query)
        position = (
            SOURCE["categories"].index(query["cat"][0]),
            SOURCE["hospital_names"].index(query["filter"][0]),
            int(query.get("pn", [1])[0]),
        )
        self.calls.append(position)
        if position == self.fail_at:
            raise HttpError("fixture timeout; private response must not escape")
        # A full first page forces pagination. Other combinations deliberately
        # repeat one announcement so replay must preserve its database identity.
        body = listing("first", 20) if position == (0, 0, 1) else listing("overlap")
        return HttpResponse(url, 200, body.encode())


class CollectionProgressTests(TestCase):
    def runner(self, root, client, source=None):
        config = SimpleNamespace(
            sources=(source or SOURCE,), project_root=Path(__file__).resolve().parents[1],
            database_path=Path(root) / "collector.sqlite3", customer_hospitals=(),
            timeout_seconds=1, retries=1, stale_after_hours=48,
        )
        return FrozenRunner(config, http_client=client, clock=lambda: NOW)

    def test_jining_keeps_earlier_categories_hospitals_and_pages_on_timeout(self):
        for failed_position in ((1, 0, 1), (0, 1, 1), (0, 0, 2)):
            with self.subTest(failed_position=failed_position):
                result = JiningAdapter(SOURCE, FixtureHttp(failed_position), clock=lambda: NOW).fetch()
                self.assertFalse(result.success)
                self.assertGreaterEqual(len(result.notices), 20)
                self.assertEqual(result.cursor, dict(zip(
                    ("categoryIndex", "hospitalIndex", "page"), failed_position,
                )))

    def test_partial_snapshot_resume_replay_and_configuration_reset(self):
        with TemporaryDirectory() as root:
            first_http = FixtureHttp((0, 0, 2))
            first = self.runner(root, first_http)
            summary = first.run()
            self.assertTrue(summary.success)
            self.assertEqual(summary.failed_source_count, 1)
            self.assertEqual(summary.inserted_count, 20)
            snapshot = first.repository.export_snapshot(now=NOW)
            self.assertEqual(snapshot["sources"][0]["status"], "degraded")
            self.assertEqual(snapshot["runs"][0]["status"], "partial")
            progress = snapshot["collectionProgress"]
            self.assertEqual(progress[0]["cursor"], {"categoryIndex": 0, "hospitalIndex": 0, "page": 2})
            self.assertRegex(progress[0]["configurationDigest"], r"^[0-9a-f]{64}$")
            self.assertNotIn("https", json.dumps(progress))
            self.assertNotIn("private response", json.dumps(snapshot))

            # A fresh collector database models Node's per-invocation scratch DB.
            with TemporaryDirectory() as resumed_root:
                resumed_http = FixtureHttp()
                resumed = self.runner(resumed_root, resumed_http)
                self.assertTrue(resumed.run(collection_progress=progress).success)
                self.assertEqual(resumed_http.calls[0], (0, 0, 2))
                self.assertEqual(resumed.repository.export_snapshot(now=NOW)["collectionProgress"][0]["cursor"], {})

            replay_http = FixtureHttp()
            replay = self.runner(root, replay_http)
            replay.run(collection_progress=progress)
            replay.run(collection_progress=progress)
            with sqlite3.connect(first.config.database_path) as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM notices").fetchone()[0], 21)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM notice_revisions").fetchone()[0], 21)
                self.assertEqual(conn.execute("PRAGMA quick_check").fetchone()[0], "ok")
                self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])

            changed_http = FixtureHttp()
            changed = self.runner(root, changed_http, {**SOURCE, "tenant": "changed"})
            changed.run(collection_progress=progress)
            self.assertEqual(changed_http.calls[0], (0, 0, 1))
            self.assertEqual(first_http.budgets, [45.0])

    def test_cli_accepts_private_resume_file_and_exports_degraded_snapshot(self):
        with TemporaryDirectory() as root:
            runner = self.runner(root, FixtureHttp((0, 1, 1)))
            resume = Path(root) / "resume.json"
            resume.write_text("[]")
            resume.chmod(0o600)
            output = Path(root) / "snapshot.json"
            with patch("hospital_tender_monitor.cli.load_config", return_value=runner.config), \
                    patch("hospital_tender_monitor.cli.MonitorRunner", return_value=runner), \
                    redirect_stdout(io.StringIO()):
                code = main(["--project-root", root, "run-and-export", "--output", str(output),
                             f"--resume-progress={resume}"])
            self.assertEqual(code, 0)
            snapshot = json.loads(output.read_text())
            self.assertEqual(snapshot["sources"][0]["status"], "degraded")
            self.assertEqual(snapshot["collectionProgress"][0]["cursor"]["hospitalIndex"], 1)

    def test_invalid_resume_input_is_rejected_before_fetch_or_database_writes(self):
        valid = {"sourceId": SOURCE["id"], "configurationDigest": "a" * 64, "cursor": {"page": 2}}
        invalid = [
            {}, [valid] * 201, [valid, valid],
            [{**valid, "configurationDigest": "A" * 64}],
            [{**valid, "sourceId": "x" * 201}],
            [{**valid, "sourceId": "x\u0085"}],
            [{**valid, "sourceId": "\U0001f600" * 101}],
            [{**valid, "cursor": {"url": "https://example.test"}}],
            [{**valid, "cursor": {"page": True}}],
            [{**valid, "cursor": {"page": -1}}],
            [{**valid, "cursor": {"page": 1_000_001}}],
            [{**valid, "cursor": {"page": 1.5}}],
        ]
        for index, value in enumerate(invalid):
            with self.subTest(case=index), TemporaryDirectory() as root:
                runner = self.runner(root, FixtureHttp())
                with self.assertRaisesRegex(ValueError, "invalid collection progress"):
                    runner.run(collection_progress=value)
                self.assertFalse(runner.config.database_path.exists())
                self.assertEqual(runner.http_client.calls, [])

    def test_invalid_cli_resume_is_safe_and_has_no_side_effects(self):
        with TemporaryDirectory() as root:
            runner = self.runner(root, FixtureHttp())
            resume = Path(root) / "resume.json"
            resume.write_text('[{"secret":"test-secret"}]')
            resume.chmod(0o600)
            error = io.StringIO()
            with patch("hospital_tender_monitor.cli.load_config", return_value=runner.config), \
                    patch("hospital_tender_monitor.cli.MonitorRunner", return_value=runner), \
                    redirect_stderr(error):
                code = main(["--project-root", root, "run-and-export", "--output", str(Path(root) / "out"),
                             f"--resume-progress={resume}"])
            self.assertEqual(code, 2)
            self.assertNotIn("test-secret", error.getvalue())
            self.assertFalse(runner.config.database_path.exists())

    def test_all_six_position_keys_and_numeric_bounds_match_node_contract(self):
        cursor = {key: 1_000_000 for key in (
            "categoryIndex", "hospitalIndex", "page", "pageIndex", "branchIndex", "itemIndex",
        )}
        entry = {"sourceId": "x", "configurationDigest": "f" * 64, "cursor": cursor}
        self.assertEqual(validate_collection_progress([entry]), [entry])
        self.assertEqual(validate_collection_progress([{**entry, "cursor": {}}])[0]["cursor"], {})

    def test_resume_file_rejects_symlink_permissions_duplicate_keys_and_unbounded_data(self):
        with TemporaryDirectory() as root:
            path = Path(root) / "progress.json"
            path.write_text("[]")
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "invalid collection progress"):
                load_collection_progress(path)
            path.chmod(0o600)
            link = Path(root) / "link.json"
            link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "invalid collection progress"):
                load_collection_progress(link)
            for payload in (
                b"[" * 2000,
                b" " * (MAX_PROGRESS_BYTES + 1),
                b"\xff",
                ('[{"sourceId":"x","configurationDigest":"' + "a" * 64 + '","cursor":{"page":1,"page":2}}]').encode(),
            ):
                path.write_bytes(payload)
                with self.assertRaisesRegex(ValueError, "invalid collection progress"):
                    load_collection_progress(path)

    def test_local_repository_progress_recovers_without_external_input(self):
        with TemporaryDirectory() as root:
            runner = self.runner(root, FixtureHttp((0, 0, 2)))
            runner.run()
            next_http = FixtureHttp()
            next_runner = self.runner(root, next_http)
            next_runner.run()
            self.assertEqual(next_http.calls[0], (0, 0, 2))
            self.assertEqual(next_runner.repository.collection_progress()[0]["cursor"], {})

    def test_invalid_dimension_position_resets_to_start(self):
        with TemporaryDirectory() as root:
            client = FixtureHttp()
            runner = self.runner(root, client)
            runner.run(collection_progress=[{
                "sourceId": SOURCE["id"], "configurationDigest": configuration_digest(SOURCE),
                "cursor": {"categoryIndex": 999, "hospitalIndex": 999, "page": 0},
            }])
            self.assertEqual(client.calls[0], (0, 0, 1))

    def test_collector_deadline_preserves_unattempted_source_position(self):
        with TemporaryDirectory() as root:
            client = FixtureHttp()
            runner = self.runner(root, client)
            other = {**SOURCE, "id": "later-source"}
            runner.config.sources = (SOURCE, other)
            runner.monotonic = iter((0, 0, 270.0)).__next__
            summary = runner.run(collection_progress=[{
                "sourceId": other["id"], "configurationDigest": configuration_digest(other),
                "cursor": {"categoryIndex": 1, "hospitalIndex": 0, "page": 2},
            }])
            self.assertTrue(summary.success)
            self.assertEqual(summary.failed_source_count, 1)
            self.assertEqual(client.budgets, [45.0])
            progress = {entry["sourceId"]: entry for entry in runner.repository.collection_progress()}
            self.assertEqual(progress[other["id"]]["cursor"]["page"], 2)

    def test_remaining_collector_budget_caps_source_budget(self):
        with TemporaryDirectory() as root:
            client = FixtureHttp()
            runner = self.runner(root, client)
            runner.monotonic = iter((0, 260)).__next__
            self.assertTrue(runner.run().success)
            self.assertEqual(client.budgets, [10.0])

    def test_private_collector_schema_migrates_v1_without_losing_notices(self):
        with TemporaryDirectory() as root:
            runner = self.runner(root, FixtureHttp())
            runner.run()
            database = runner.config.database_path
            with sqlite3.connect(database) as conn:
                conn.execute("DROP TABLE collection_progress")
                conn.execute("ALTER TABLE source_health_history DROP COLUMN partial")
                conn.execute("ALTER TABLE runs DROP COLUMN partial_source_count")
                conn.execute("DELETE FROM schema_migrations WHERE version=2")
                old_ids = conn.execute("SELECT id, identity_key FROM notices ORDER BY id").fetchall()
            repository = Repository(database)
            repository.initialize()
            repository.initialize()
            with sqlite3.connect(database) as conn:
                self.assertEqual(conn.execute("SELECT id, identity_key FROM notices ORDER BY id").fetchall(), old_ids)
                self.assertEqual(conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall(), [(1,), (2,)])
                self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertTrue(repository.quick_check().ok)
            self.assertEqual(repository.export_snapshot(now=NOW)["collectionProgress"], [])

    def test_resume_file_accepts_maximum_contract_shape_with_unicode_ids(self):
        cursor = {key: 1_000_000 for key in (
            "categoryIndex", "hospitalIndex", "page", "pageIndex", "branchIndex", "itemIndex",
        )}
        entries = [{"sourceId": "\u533b" * 197 + f"{index:03d}", "configurationDigest": "a" * 64, "cursor": cursor}
                   for index in range(200)]
        with TemporaryDirectory() as root:
            path = Path(root) / "progress.json"
            path.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
            path.chmod(0o600)
            self.assertEqual(load_collection_progress(path), entries)

    def test_deleted_source_progress_is_pruned_when_configured_sources_change(self):
        with TemporaryDirectory() as root:
            first = self.runner(root, FixtureHttp((0, 0, 2)))
            first.run()
            replacement = {**SOURCE, "id": "replacement-source"}
            next_runner = self.runner(root, FixtureHttp(), replacement)
            next_runner.run()
            self.assertEqual([entry["sourceId"] for entry in next_runner.repository.collection_progress()], [replacement["id"]])

    def test_consecutive_partial_runs_advance_across_pages_and_hospitals(self):
        with TemporaryDirectory() as root:
            first = self.runner(root, FixtureHttp((0, 0, 2)))
            first.run()
            second_http = FixtureHttp((0, 1, 1))
            second = self.runner(root, second_http)
            second.run()
            self.assertEqual(second_http.calls[0], (0, 0, 2))
            self.assertEqual(second.repository.collection_progress()[0]["cursor"],
                             {"categoryIndex": 0, "hospitalIndex": 1, "page": 1})
            third_http = FixtureHttp()
            third = self.runner(root, third_http)
            third.run()
            self.assertEqual(third_http.calls[0], (0, 1, 1))
            self.assertEqual(third.repository.collection_progress()[0]["cursor"], {})

    def test_jining_page_cap_preserves_next_uncollected_page(self):
        client = FixtureHttp()
        with patch("hospital_tender_monitor.sources.jining._MAX_PAGES", 1):
            result = JiningAdapter(SOURCE, client, clock=lambda: NOW).fetch()
        self.assertFalse(result.success)
        self.assertEqual(len(result.notices), 20)
        self.assertEqual(result.cursor, {"categoryIndex": 0, "hospitalIndex": 0, "page": 2})
        self.assertEqual(client.calls, [(0, 0, 1)])
