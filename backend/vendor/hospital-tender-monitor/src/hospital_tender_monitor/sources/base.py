"""Shared source-adapter contracts and conservative normalization helpers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Mapping
import re
from urllib.parse import urljoin

from hospital_tender_monitor.config import validate_public_url
from hospital_tender_monitor.models import TenderNotice


@dataclass(frozen=True, slots=True)
class SourceResult:
    notices: tuple[TenderNotice, ...] = ()
    success: bool = True
    error: str = ""


class SourceAdapter(ABC):
    @abstractmethod
    def fetch(self) -> SourceResult:
        """Fetch a source without business relevance filtering."""


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def strip_html(value: object) -> str:
    parser = _TextExtractor()
    parser.feed(str(value or ""))
    parser.close()
    return " ".join("".join(parser.parts).split())


def public_link(base_url: str, value: object) -> str:
    raw_link = str(value or "").strip()
    if not raw_link:
        raise ValueError("notice URL is missing")
    candidate = urljoin(base_url, raw_link)
    return validate_public_url(candidate)


_DATE_REPLACEMENTS = (
    (re.compile(r"^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?$"), r"\1-\2-\3"),
    (re.compile(r"^(\d{4})(\d{2})(\d{2})$"), r"\1-\2-\3"),
)


def parse_published_at(value: object) -> datetime | None:
    raw = str(value or "").strip().replace("Z", "+00:00")
    if not raw:
        return None
    candidates = [raw, raw.replace("/", "-")]
    date_part = raw.split(" ", 1)[0].split("T", 1)[0]
    for pattern, replacement in _DATE_REPLACEMENTS:
        normalized = pattern.sub(replacement, date_part)
        if normalized != date_part:
            year, month, day = normalized.split("-", 2)
            normalized = f"{year}-{month.zfill(2)}-{day.zfill(2)}"
            suffix = raw[len(date_part):]
            candidates.append(f"{normalized}{suffix}")
    for candidate in candidates:
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            continue
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return None


def source_text(source: Mapping[str, object], name: str) -> str:
    value = source.get(name, "")
    return value if isinstance(value, str) else ""
