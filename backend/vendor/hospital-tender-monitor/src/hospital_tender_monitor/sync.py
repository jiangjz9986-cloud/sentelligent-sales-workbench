"""Bounded, credential-separated snapshot export to Sentelligent."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .storage import Repository, RepositoryError


SNAPSHOT_SCHEMA_VERSION = "hospital-tender-snapshot-v1"
MAX_RESPONSE_BYTES = 512 * 1024


class SyncError(RuntimeError):
    """A safe, operator-facing sync failure without credential details."""


def _validate_endpoint(endpoint: str) -> str:
    if not isinstance(endpoint, str) or not endpoint.strip():
        raise SyncError("sync endpoint is required")
    value = endpoint.strip()
    parts = urlsplit(value)
    if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
        raise SyncError("sync endpoint must be an http or https URL")
    if parts.scheme == "http" and parts.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SyncError("non-loopback sync endpoint must use HTTPS")
    return value


def _token_from_env(env: dict[str, str] | None = None) -> str:
    values = os.environ if env is None else env
    token = str(values.get("HOSPITAL_TENDER_SYNC_TOKEN", "")).strip()
    if not token:
        raise SyncError("sync token is not configured")
    if len(token) > 512 or any(ord(char) < 0x20 or ord(char) == 0x7F for char in token):
        raise SyncError("sync token is invalid")
    return token


def build_snapshot(repository: Repository, *, now: datetime | None = None, limit: int = 500) -> dict[str, object]:
    if not isinstance(repository, Repository):
        raise TypeError("repository must be a Repository")
    snapshot = repository.export_snapshot(now=now, limit=limit)
    if snapshot.get("schemaVersion") != SNAPSHOT_SCHEMA_VERSION:
        raise SyncError("snapshot schema is unsupported")
    return snapshot


@dataclass(frozen=True, slots=True)
class SyncResult:
    status: int
    accepted_count: int
    rejected_count: int


def post_snapshot(
    snapshot: dict[str, object],
    endpoint: str,
    *,
    token: str | None = None,
    timeout_seconds: float = 30.0,
    opener=urlopen,
) -> SyncResult:
    url = _validate_endpoint(endpoint)
    if token is None:
        token = _token_from_env()
    if not isinstance(token, str) or not token.strip():
        raise SyncError("sync token is not configured")
    body = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(body) > 8 * 1024 * 1024:
        raise SyncError("snapshot is too large")
    request = Request(
        url,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "hospital-it-tender-monitor-sync/1",
        },
        data=body,
    )
    try:
        with opener(request, timeout=timeout_seconds) as response:
            status = int(response.status)
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        raise SyncError("sync endpoint rejected the snapshot") from None
    except (URLError, TimeoutError, OSError):
        raise SyncError("sync endpoint is unavailable") from None
    if len(payload) > MAX_RESPONSE_BYTES:
        raise SyncError("sync response is too large")
    if status < 200 or status >= 300:
        raise SyncError("sync endpoint rejected the snapshot")
    try:
        data = json.loads(payload.decode("utf-8")) if payload else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SyncError("sync response is invalid") from None
    item = data.get("item") if isinstance(data, dict) else None
    if not isinstance(item, dict):
        raise SyncError("sync response is invalid")
    accepted = item.get("acceptedCount", 0)
    rejected = item.get("rejectedCount", 0)
    if type(accepted) is not int or accepted < 0 or type(rejected) is not int or rejected < 0:
        raise SyncError("sync response is invalid")
    return SyncResult(status, accepted, rejected)


def run_and_sync(
    repository: Repository,
    runner,
    endpoint: str,
    *,
    include_possible: bool = False,
    env: dict[str, str] | None = None,
) -> tuple[object, SyncResult]:
    summary = runner.run(include_possible=include_possible)
    if not getattr(summary, "success", False):
        raise SyncError("monitor run failed; snapshot was not sent")
    snapshot = build_snapshot(repository)
    token = _token_from_env(env)
    result = post_snapshot(snapshot, endpoint, token=token)
    return summary, result
