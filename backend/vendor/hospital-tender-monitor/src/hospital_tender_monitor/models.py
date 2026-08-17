"""Immutable domain values shared by collectors, classification, and storage."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from hashlib import sha256
from typing import Iterable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


class NoticeType(str, Enum):
    PLAN = "plan"
    PROCUREMENT = "procurement"
    SINGLE_SOURCE = "single_source"
    CHANGE = "change"
    RESULT = "result"
    TERMINATED = "terminated"
    CONTRACT = "contract"
    UNKNOWN = "unknown"


class RelevanceLevel(str, Enum):
    HIGH = "high"
    POSSIBLE = "possible"
    IRRELEVANT = "irrelevant"


def _normalize_text(value: str | None) -> str:
    return " ".join((value or "").split())


def _normalize_names(names: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    normalized: list[str] = []
    for name in names:
        cleaned = _normalize_text(name)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            normalized.append(cleaned)
    return tuple(normalized)


def canonicalize_url(url: str) -> str:
    """Return a stable URL representation for deduplication, not URL security."""
    cleaned = _normalize_text(url)
    if not cleaned:
        return ""
    parts = urlsplit(cleaned)
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    port = parts.port
    if host and ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = host
    if port is not None and (scheme, port) not in {("http", 80), ("https", 443)}:
        netloc = f"{netloc}:{port}"
    path = parts.path or "/"
    query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    return urlunsplit((scheme, netloc, path, query, ""))


@dataclass(frozen=True, slots=True)
class TenderNotice:
    source_id: str
    source_name: str
    city: str
    title: str
    url: str
    published_at: datetime
    notice_type: NoticeType = NoticeType.UNKNOWN
    purchaser: str = ""
    project_code: str = ""
    budget_text: str = ""
    deadline_text: str = ""
    content_text: str = ""
    hospital_names: tuple[str, ...] = ()
    source_item_id: str = ""
    raw_content: str = ""
    content_sha256: str = field(init=False)
    identity_key: str = field(init=False)

    def __post_init__(self) -> None:
        for name in (
            "source_id",
            "source_name",
            "city",
            "title",
            "purchaser",
            "project_code",
            "budget_text",
            "deadline_text",
            "content_text",
            "source_item_id",
            "raw_content",
        ):
            object.__setattr__(self, name, _normalize_text(getattr(self, name)))
        object.__setattr__(self, "url", canonicalize_url(self.url))
        object.__setattr__(self, "hospital_names", _normalize_names(self.hospital_names))
        content = self.raw_content or self.content_text
        object.__setattr__(self, "content_sha256", sha256(content.encode("utf-8")).hexdigest())
        if self.url:
            identity = f"url:{self.url}"
        elif self.source_item_id:
            identity = f"source:{self.source_id}:{self.source_item_id}"
        else:
            identity = f"content:{self.source_id}:{self.content_sha256}"
        object.__setattr__(self, "identity_key", identity)


@dataclass(frozen=True, slots=True)
class ClassifiedNotice:
    notice: TenderNotice
    score: int
    level: RelevanceLevel
    matched_terms: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "matched_terms", tuple(self.matched_terms))
        object.__setattr__(self, "reasons", tuple(self.reasons))


@dataclass(frozen=True, slots=True)
class SourceHealth:
    source_id: str
    checked_at: datetime
    success: bool
    item_count: int = 0
    error: str = ""
    source_name: str = ""
    city: str = ""
