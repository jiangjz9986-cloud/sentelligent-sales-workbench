"""Bounded, configuration-bound positions for collector process handoffs."""

from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
from typing import Mapping


MAX_PROGRESS_ENTRIES = 200
MAX_POSITION = 1_000_000
MAX_PROGRESS_BYTES = 256 * 1024
_POSITION_KEYS = frozenset({"categoryIndex", "hospitalIndex", "page", "pageIndex", "branchIndex", "itemIndex"})


def validate_cursor(value: object) -> dict[str, int]:
    if (
        not isinstance(value, dict)
        or not value.keys() <= _POSITION_KEYS
        or any(type(position) is not int or not 0 <= position <= MAX_POSITION for position in value.values())
    ):
        raise ValueError("invalid collection progress")
    return dict(value)


def validate_collection_progress(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list) or len(value) > MAX_PROGRESS_ENTRIES:
        raise ValueError("invalid collection progress")
    output = []
    seen = set()
    for entry in value:
        if not isinstance(entry, dict) or entry.keys() != {"sourceId", "configurationDigest", "cursor"}:
            raise ValueError("invalid collection progress")
        source_id = entry["sourceId"]
        digest = entry["configurationDigest"]
        if (
            not isinstance(source_id, str) or not source_id.strip()
            or sum(2 if ord(char) > 0xFFFF else 1 for char in source_id) > 200
            or any(ord(char) < 32 or 0x7F <= ord(char) <= 0x9F or 0xD800 <= ord(char) <= 0xDFFF for char in source_id)
            or source_id in seen
            or not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None
        ):
            raise ValueError("invalid collection progress")
        seen.add(source_id)
        output.append({"sourceId": source_id, "configurationDigest": digest, "cursor": validate_cursor(entry["cursor"])})
    return output


def configuration_digest(source: Mapping[str, object]) -> str:
    # Only the hash crosses the process boundary; source URLs and search terms
    # stay in the existing configuration and never become cursor fields.
    payload = json.dumps(dict(source), sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    return sha256(payload.encode("utf-8")).hexdigest()


def _unique_object(pairs):
    output = {}
    for key, value in pairs:
        if key in output:
            raise ValueError("invalid collection progress")
        output[key] = value
    return output


def load_collection_progress(path: Path) -> list[dict[str, object]]:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PROGRESS_BYTES or info.st_mode & 0o077:
                raise ValueError("invalid collection progress")
            payload = handle.read(MAX_PROGRESS_BYTES + 1)
        if len(payload) > MAX_PROGRESS_BYTES:
            raise ValueError("invalid collection progress")
        return validate_collection_progress(json.loads(payload.decode("utf-8"), object_pairs_hook=_unique_object))
    except (OSError, ValueError, UnicodeError, RecursionError):
        raise ValueError("invalid collection progress") from None
