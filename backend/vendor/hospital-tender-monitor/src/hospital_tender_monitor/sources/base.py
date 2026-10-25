"""Shared source-adapter contracts and conservative normalization helpers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Mapping
import re
from urllib.parse import urljoin, urlsplit

from hospital_tender_monitor.config import validate_public_url
from hospital_tender_monitor.models import TenderNotice
from hospital_tender_monitor.progress import validate_cursor


SOURCE_LOOKBACK_DAYS = 14


def scan_cutoff(now: datetime) -> datetime:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("scan clock must be timezone-aware")
    return now.astimezone(timezone.utc) - timedelta(days=SOURCE_LOOKBACK_DAYS)


def page_reaches_cutoff(published_at: list[datetime], cutoff: datetime) -> bool:
    # A page may contain a few out-of-order rows. Stop only when every dated
    # row is outside the overlap window, otherwise a newer item could be lost.
    return bool(published_at) and max(published_at) < cutoff


@dataclass(frozen=True, slots=True)
class SourceResult:
    notices: tuple[TenderNotice, ...] = ()
    success: bool = True
    error: str = ""
    cursor: dict[str, int] | None = None
    partial: bool = False


class SourceAdapter(ABC):
    def set_resume_cursor(self, cursor: dict[str, int]) -> None:
        self._resume_cursor = validate_cursor(cursor)

    def resume_position(
        self, *, categories: int = 1, hospitals: int = 1, first_page: int = 1, last_page: int = 1,
    ) -> tuple[int, int, int]:
        cursor = getattr(self, "_resume_cursor", {})
        category = cursor.get("categoryIndex", 0)
        hospital = cursor.get("hospitalIndex", 0)
        page = cursor.get("page", first_page)
        if category >= categories or hospital >= hospitals or not first_page <= page <= last_page:
            return 0, 0, first_page
        return category, hospital, page

    @abstractmethod
    def fetch(self) -> SourceResult:
        """Fetch a source without business relevance filtering."""


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


class _DetailTextExtractor(HTMLParser):
    """Extract bounded, readable page text while ignoring executable markup."""

    _BLOCK_TAGS = frozenset({"br", "div", "li", "p", "td", "th", "tr", "h1", "h2", "h3", "h4"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, _attrs: list[tuple[str, str | None]]) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "noscript", "svg"}:
            self._ignored_depth += 1
        elif not self._ignored_depth and normalized in self._BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "noscript", "svg"} and self._ignored_depth:
            self._ignored_depth -= 1
        elif not self._ignored_depth and normalized in self._BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth:
            self.parts.append(data)


_BUDGET_LABEL = re.compile(
    r"(?:項目預算金額|项目预算金额|預算金額|预算金额|採購預算(?:金額)?|采购预算(?:金额)?|"
    r"項目預算|项目预算|最高投標限價|最高投标限价|最高限價|最高限价|招標控制價|招标控制价|預算|预算)"
)
_MONEY_VALUE = re.compile(
    r"(?:人民幣|人民币)?\s*([¥￥]?\s*\d[\d,]*(?:\.\d+)?)\s*(億元|亿元|萬元|万元|千元|元|萬|万|億|亿)?"
)
_UNIT_HINT = re.compile(r"(?:單位|单位)?\s*[:：]?\s*(億元|亿元|萬元|万元|千元|元|萬|万|億|亿)")


def extract_budget_text(value: object) -> str:
    """Extract a value only when it follows an explicit budget/price label."""
    parser = _DetailTextExtractor()
    parser.feed(str(value or ""))
    parser.close()
    lines = [" ".join(line.split()) for line in "".join(parser.parts).splitlines()]
    for index, line in enumerate(lines):
        label = _BUDGET_LABEL.search(line)
        if not label:
            continue
        suffix = line[label.end():]
        hint_match = _UNIT_HINT.search(suffix[:40])
        amount = _MONEY_VALUE.search(suffix[:100])
        safe_prefix = (
            re.fullmatch(r"[\s:：=，,（()）)約约為为人民幣人民币暫暂估不超過不超过預計预计最高萬元万元億元亿元千元元萬万億亿]*", suffix[:amount.start()])
            if amount else None
        )
        if amount and safe_prefix:
            value_text = amount.group(1).replace(" ", "")
            unit = amount.group(2) or (hint_match.group(1) if hint_match else "")
            return f"{value_text}{unit}"
        if index + 1 < len(lines):
            next_amount = _MONEY_VALUE.fullmatch(lines[index + 1])
            if next_amount:
                value_text = next_amount.group(1).replace(" ", "")
                unit = next_amount.group(2) or (hint_match.group(1) if hint_match else "")
                return f"{value_text}{unit}"
    return ""


def fetch_detail_budget(http, source_url: str, notice_url: str) -> str:
    """Fetch one same-host public notice page and read an explicitly labelled budget."""
    try:
        source_parts = urlsplit(source_url)
        notice_parts = urlsplit(notice_url)
        source_host = (source_parts.hostname or "").casefold().rstrip(".")
        notice_host = (notice_parts.hostname or "").casefold().rstrip(".")
        if not source_host or source_host != notice_host:
            return ""
        if source_parts.username or source_parts.password or notice_parts.username or notice_parts.password:
            return ""
        source_scheme = source_parts.scheme.casefold()
        notice_scheme = notice_parts.scheme.casefold()
        source_port = source_parts.port or (443 if source_scheme == "https" else 80)
        notice_port = notice_parts.port or (443 if notice_scheme == "https" else 80)
        if source_scheme not in {"http", "https"} or notice_scheme not in {"http", "https"}:
            return ""
        if source_scheme == "https" and notice_scheme != "https":
            return ""
        if source_scheme == notice_scheme and source_port != notice_port:
            return ""
        if source_scheme == "http" and notice_scheme == "https" and (source_port, notice_port) != (80, 443):
            return ""
        response = http.request("GET", notice_url)
        if response.status < 200 or response.status >= 300:
            return ""
        return extract_budget_text(response.text)
    except Exception:
        return ""


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
