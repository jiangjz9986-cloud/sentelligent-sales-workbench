"""Command-line entry points for one-shot monitoring and health checks."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

from .config import load_config
from .runner import LockBusyError, MonitorRunner
from .storage import RepositoryError
from .sync import SyncError, build_snapshot, post_snapshot, run_and_sync


def _environment():
    return dict(os.environ)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hospital-tender-monitor", description="Run the hospital IT tender monitor once")
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check-config", help="validate configuration without contacting sources")
    sub.add_parser("list-sources", help="list enabled configured sources")
    sub.add_parser("list-customers", help="list configured customer hospitals and coverage states")
    sub.add_parser("dry-run", help="fetch and classify without database or notification writes")
    run = sub.add_parser("run", help="collect, persist, and notify once")
    run.add_argument("--possible", action="store_true", help="include possible matches in notifications")
    sub.add_parser("health", help="show persisted source health")
    sub.add_parser("db-check", help="initialize and run SQLite quick_check")
    export = sub.add_parser("export-snapshot", help="write a normalized snapshot for an external consumer")
    export.add_argument("--output", type=Path, required=True)
    run_export = sub.add_parser("run-and-export", help="collect once and write a normalized snapshot")
    run_export.add_argument("--output", type=Path, required=True)
    run_export.add_argument("--possible", action="store_true", help="include possible matches in notifications")
    sync = sub.add_parser("sync", help="send the persisted snapshot to Sentelligent")
    sync.add_argument("--endpoint", default=os.environ.get("SENTELLIGENT_HOSPITAL_TENDER_SYNC_URL", ""))
    run_sync = sub.add_parser("run-and-sync", help="collect once, then send the normalized snapshot to Sentelligent")
    run_sync.add_argument("--endpoint", default=os.environ.get("SENTELLIGENT_HOSPITAL_TENDER_SYNC_URL", ""))
    run_sync.add_argument("--possible", action="store_true", help="include possible matches in notifications")
    optional_sync = sub.add_parser("run-and-sync-if-configured", help="collect once and sync when the bridge is configured")
    optional_sync.add_argument("--endpoint", default=os.environ.get("SENTELLIGENT_HOSPITAL_TENDER_SYNC_URL", ""))
    optional_sync.add_argument("--possible", action="store_true", help="include possible matches in notifications")
    return parser


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _present(value):
    """Render aware datetimes for operators in the configured presentation zone."""
    if isinstance(value, datetime) and value.tzinfo is not None:
        return value.astimezone(ZoneInfo("Asia/Shanghai")).isoformat()
    if isinstance(value, dict):
        return {key: _present(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_present(item) for item in value]
    return value


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)
    try:
        config = load_config(_environment(), args.project_root)
        if args.command == "check-config":
            # Validate adapter names and the complete keyword schema without
            # opening the database or contacting any source.
            checker = MonitorRunner(config)
            checker._sources()
            checker._rules()
            print("configuration ok")
            return 0
        if args.command == "list-sources":
            for source in config.sources:
                print(_json({"id": source.get("id", ""), "name": source.get("name", ""), "city": source.get("city", ""), "adapter": source.get("adapter", ""), "enabled": bool(source.get("enabled", True))}))
            return 0
        if args.command == "list-customers":
            for target in config.customer_hospitals:
                print(_json({
                    "id": target.get("id", ""),
                    "name": target.get("name", ""),
                    "city": target.get("city", ""),
                    "region": target.get("region", ""),
                    "status": target.get("status", ""),
                    "aliases": target.get("aliases", ()),
                }))
            return 0
        runner = MonitorRunner(config)
        if args.command == "dry-run":
            summary = runner.run(dry_run=True)
            print(_json(_present(asdict(summary))))
            return 0 if summary.success else 1
        if args.command == "run":
            summary = runner.run(include_possible=args.possible)
            print(_json(_present(asdict(summary))))
            return 0 if summary.success else 1
        if args.command == "health":
            print(_json(_present([asdict(row) for row in runner.health()])))
            return 0
        if args.command == "db-check":
            result = runner.db_check()
            print(_json(asdict(result)))
            return 0 if result.ok else 1
        if args.command == "export-snapshot":
            snapshot = build_snapshot(runner.repository)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(_json(snapshot) + "\n", encoding="utf-8")
            try:
                args.output.chmod(0o600)
            except OSError:
                pass
            print(_json({"status": "ok", "output": str(args.output), "noticeCount": len(snapshot["notices"])}))
            return 0
        if args.command == "run-and-export":
            summary = runner.run(include_possible=args.possible)
            if not summary.success:
                print(_json({"status": "failed", "run": _present(asdict(summary))}))
                return 1
            snapshot = build_snapshot(runner.repository)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_name(f".{args.output.name}.tmp")
            temporary.write_text(_json(snapshot) + "\n", encoding="utf-8")
            try:
                temporary.chmod(0o600)
            except OSError:
                pass
            temporary.replace(args.output)
            print(_json({"status": "ok", "run": _present(asdict(summary)), "output": str(args.output), "noticeCount": len(snapshot["notices"])}))
            return 0
        if args.command == "sync":
            if not args.endpoint:
                raise SyncError("sync endpoint is not configured")
            snapshot = build_snapshot(runner.repository)
            result = post_snapshot(snapshot, args.endpoint)
            print(_json({"status": "ok", "httpStatus": result.status, "acceptedCount": result.accepted_count, "rejectedCount": result.rejected_count}))
            return 0
        if args.command == "run-and-sync":
            if not args.endpoint:
                raise SyncError("sync endpoint is not configured")
            summary, result = run_and_sync(
                runner.repository,
                runner,
                args.endpoint,
                include_possible=args.possible,
                env=_environment(),
            )
            print(_json({"status": "ok", "run": _present(asdict(summary)), "sync": asdict(result)}))
            return 0
        if args.command == "run-and-sync-if-configured":
            summary = runner.run(include_possible=args.possible)
            if not args.endpoint or not _environment().get("HOSPITAL_TENDER_SYNC_TOKEN", "").strip():
                print(_json({"status": "ok", "run": _present(asdict(summary)), "sync": "not_configured"}))
                return 0 if summary.success else 1
            snapshot = build_snapshot(runner.repository)
            result = post_snapshot(snapshot, args.endpoint)
            print(_json({"status": "ok", "run": _present(asdict(summary)), "sync": asdict(result)}))
            return 0 if summary.success else 1
        parser.error("unknown command")
    except LockBusyError as exc:
        print(str(exc), file=sys.stderr)
        return 75
    except (ValueError, RepositoryError, SyncError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
