"""Adapter for Jining's public-resource listing and newest-post feeds."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Callable, Mapping
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlsplit

from hospital_tender_monitor.http import HttpClient, HttpError
from hospital_tender_monitor.models import NoticeType, TenderNotice

from .base import (
    SourceAdapter,
    SourceResult,
    page_reaches_cutoff,
    parse_published_at,
    public_link,
    scan_cutoff,
    source_text,
    strip_html,
)


CATEGORY_TYPES = {
    "536": NoticeType.PLAN,
    "503000": NoticeType.PROCUREMENT,
    "551001": NoticeType.PROCUREMENT,
    "55100101": NoticeType.PROCUREMENT,
    "55200101": NoticeType.CHANGE,
    "553001": NoticeType.RESULT,
    "57100101": NoticeType.TERMINATED,
    "551003": NoticeType.UNKNOWN,
}
DEFAULT_CATEGORIES = ("55100101", "55200101", "553001", "57100101")
_PAGE_SIZE = 20
_MAX_PAGES = 30


class _PostsListParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.records: list[dict[str, str]] = []
        self._row: dict[str, object] | None = None
        self._in_time = 0
        self._in_link = False
        self._badge_depth = 0
        self._span_stack: list[tuple[bool, bool]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        if tag == "li" and "list-group-item" in classes:
            self._finish_row()
            self._row = {"date": [], "title": [], "url": ""}
            return
        if self._row is None:
            return
        if tag == "span":
            is_time = "time" in classes
            is_badge = "badge" in classes
            self._span_stack.append((is_time, is_badge))
            self._in_time += int(is_time)
            self._badge_depth += int(is_badge)
        elif tag == "a":
            href = attributes.get("href") or ""
            if "/Posts/Detail" in href:
                self._row["url"] = href
                self._in_link = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "span" and self._span_stack:
            is_time, is_badge = self._span_stack.pop()
            self._in_time -= int(is_time)
            self._badge_depth -= int(is_badge)
        elif tag == "a":
            self._in_link = False
        elif tag == "li":
            self._finish_row()

    def handle_data(self, data: str) -> None:
        if self._row is None:
            return
        if self._in_time:
            self._row["date"].append(data)
        if self._in_link and not self._badge_depth:
            self._row["title"].append(data)

    def _finish_row(self) -> None:
        if self._row is None:
            return
        title = " ".join("".join(self._row["title"]).split())
        published = " ".join("".join(self._row["date"]).split())
        url = str(self._row["url"])
        if title and published and url:
            item_id = parse_qs(urlsplit(url).query).get("id", [""])[0]
            self.records.append({"title": title, "date": published, "url": url, "id": item_id})
        self._row = None
        self._in_time = 0
        self._in_link = False
        self._badge_depth = 0
        self._span_stack.clear()


def _listing_records(body: str) -> list[dict[str, str]]:
    parser = _PostsListParser()
    parser.feed(body)
    parser.close()
    parser._finish_row()
    return parser.records


class JiningAdapter(SourceAdapter):
    def __init__(
        self,
        source: Mapping[str, object],
        http: HttpClient,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.source = source
        self.http = http
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def fetch(self) -> SourceResult:
        categories = self.source.get("categories", DEFAULT_CATEGORIES)
        if not isinstance(categories, (list, tuple)):
            return SourceResult(success=False, error="invalid source response")
        categories = tuple(dict.fromkeys(str(value).strip() for value in categories if str(value).strip()))
        if not categories:
            categories = DEFAULT_CATEGORIES
        tenant = source_text(self.source, "tenant")
        source_url = source_text(self.source, "url")
        if not tenant:
            return SourceResult(success=False, error="invalid source response")
        names = self._search_names()
        if names:
            return self._fetch_filtered(source_url, tenant, categories, names)

        notices: list[TenderNotice] = []
        seen: set[str] = set()
        try:
            for category in categories:
                endpoint = urljoin(
                    source_url,
                    f"/Tenants/{quote(tenant, safe='')}/Posts/{quote(category, safe='')}/newest.json",
                )
                response = self.http.request("GET", endpoint)
                document = json.loads(response.text)
                records = document.get("data") if isinstance(document, dict) else document
                if not isinstance(records, list):
                    raise ValueError("records")
                for record in records:
                    try:
                        notice = self._notice(record, CATEGORY_TYPES.get(category, NoticeType.UNKNOWN))
                    except (TypeError, ValueError):
                        continue
                    if notice is not None and notice.identity_key not in seen:
                        seen.add(notice.identity_key)
                        notices.append(notice)
        except (HttpError, ValueError, json.JSONDecodeError, TypeError):
            return SourceResult(success=False, error="invalid source response")
        return SourceResult(notices=tuple(notices))

    def _search_names(self) -> tuple[str, ...]:
        configured = self.source.get("hospital_names", ())
        if not isinstance(configured, (list, tuple)):
            return ()
        names = [str(name).strip() for name in configured if isinstance(name, str) and len(name.strip()) >= 4]
        page_filter = parse_qs(urlsplit(source_text(self.source, "url")).query).get("filter", [""])[0].strip()
        if len(page_filter) >= 4:
            names.append(page_filter)
        return tuple(dict.fromkeys(names))

    def _fetch_filtered(
        self,
        source_url: str,
        tenant: str,
        categories: tuple[str, ...],
        hospital_names: tuple[str, ...],
    ) -> SourceResult:
        notices: list[TenderNotice] = []
        seen: set[str] = set()
        cutoff = scan_cutoff(self.clock())
        list_endpoint = urljoin(source_url, f"/{quote(tenant, safe='')}/Posts")
        try:
            for category in categories:
                for name in hospital_names:
                    for page in range(1, _MAX_PAGES + 1):
                        query = {"cat": category, "filter": name}
                        if page > 1:
                            query["pn"] = str(page)
                        response = self.http.request("GET", f"{list_endpoint}?{urlencode(query)}")
                        records = _listing_records(response.text)
                        page_dates = []
                        for record in records:
                            published = parse_published_at(record.get("date"))
                            if published is not None:
                                page_dates.append(published)
                            if published is not None and published < cutoff:
                                continue
                            notice = self._notice(
                                record,
                                CATEGORY_TYPES.get(category, NoticeType.UNKNOWN),
                                hospital_names,
                            )
                            if notice is not None:
                                if notice.identity_key not in seen:
                                    seen.add(notice.identity_key)
                                    notices.append(notice)
                        if len(records) < _PAGE_SIZE or page_reaches_cutoff(page_dates, cutoff):
                            break
        except (HttpError, ValueError, TypeError):
            return SourceResult(success=False, error="invalid source response")
        return SourceResult(notices=tuple(notices))

    def _notice(
        self,
        record: object,
        notice_type: NoticeType,
        hospital_names: tuple[str, ...] = (),
    ) -> TenderNotice | None:
        if not isinstance(record, dict):
            return None
        title = strip_html(record.get("title"))
        published_at = parse_published_at(record.get("date"))
        if not title or published_at is None:
            return None
        matched_names = tuple(
            name for name in hospital_names
            if len(name) >= 4 and name.casefold() in title.casefold()
        )
        if hospital_names and not matched_names:
            return None
        raw_link = str(record.get("url") or "").strip()
        source_item_id = str(record.get("id") or "").strip()
        if raw_link and "/" not in raw_link and "?" not in raw_link and ":" not in raw_link:
            source_item_id = source_item_id or raw_link
            raw_link = f"/{quote(source_text(self.source, 'tenant'), safe='')}/Posts/Detail?id={quote(raw_link, safe='')}"
        try:
            link = public_link(source_text(self.source, "url"), raw_link)
        except ValueError:
            return None
        return TenderNotice(
            source_id=source_text(self.source, "id"),
            source_name=source_text(self.source, "name"),
            city=source_text(self.source, "city"),
            title=title,
            url=link,
            published_at=published_at,
            notice_type=notice_type,
            source_item_id=source_item_id,
            content_text=title,
            hospital_names=matched_names,
            raw_content=title,
        )
