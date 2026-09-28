"""Adapter for Dongying Epoint's public-resource listing endpoint."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Callable, Mapping
from urllib.parse import urlencode, urljoin

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


CATEGORIES: tuple[tuple[str, NoticeType], ...] = (
    ("005001001", NoticeType.PLAN),
    ("005001002", NoticeType.PROCUREMENT),
    ("005001003", NoticeType.SINGLE_SOURCE),
    ("005001004", NoticeType.CHANGE),
    ("005001005", NoticeType.RESULT),
    ("005001009", NoticeType.TERMINATED),
    ("005001010", NoticeType.CONTRACT),
)
_PATH = "/EWB-FRONT/moreinfoListAction.action?cmd=getInfolist"
_PAGE_SIZE = 20
_MAX_PAGES = 30


class DongyingAdapter(SourceAdapter):
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
        notices: list[TenderNotice] = []
        seen: set[str] = set()
        endpoint = urljoin(source_text(self.source, "url"), _PATH)
        configured_names = self.source.get("hospital_names", ())
        if not isinstance(configured_names, (list, tuple)):
            return SourceResult(success=False, error="invalid source response")
        hospital_names = tuple(dict.fromkeys(
            str(name).strip() for name in configured_names
            if isinstance(name, str) and len(name.strip()) >= 4
        ))
        # Region sources can intentionally be broad. Customer-specific sources
        # issue one server-side Title search for every canonical name/alias.
        search_names = hospital_names or ("",)
        cutoff = scan_cutoff(self.clock())
        try:
            for category, notice_type in CATEGORIES:
                for search_name in search_names:
                    for page_index in range(_MAX_PAGES):
                        data = urlencode(
                            {
                                "siteGuid": source_text(self.source, "site_guid"),
                                "vname": source_text(self.source, "vname"),
                                "CatgoryNum": category,
                                "Title": search_name,
                                "pageSize": str(_PAGE_SIZE),
                                # Epoint's browser client uses a zero-based index.
                                "pageIndex": str(page_index),
                                "YZM": "",
                                "ImgGuid": "",
                            }
                        ).encode("ascii")
                        response = self.http.request(
                            "POST", endpoint, data=data,
                            headers={"Content-Type": "application/x-www-form-urlencoded"},
                        )
                        records, total = _page(response.text)
                        page_dates: list[datetime] = []
                        for record in records:
                            published = None
                            if isinstance(record, dict):
                                published = parse_published_at(record.get("date"))
                                if published is not None:
                                    page_dates.append(published)
                            if published is not None and published < cutoff:
                                continue
                            try:
                                notice = self._notice(record, notice_type, hospital_names)
                            except (TypeError, ValueError):
                                continue
                            if notice is not None and notice.identity_key not in seen:
                                seen.add(notice.identity_key)
                                notices.append(notice)
                        if (
                            not records
                            or len(records) < _PAGE_SIZE
                            or (total is not None and (page_index + 1) * _PAGE_SIZE >= total)
                            or page_reaches_cutoff(page_dates, cutoff)
                        ):
                            break
        except (HttpError, ValueError, json.JSONDecodeError, TypeError):
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
        try:
            link = public_link(source_text(self.source, "url"), record.get("href"))
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
            source_item_id=str(record.get("index") or ""),
            content_text=title,
            hospital_names=matched_names,
            raw_content=title,
        )


def _page(text: str) -> tuple[list[object], int | None]:
    outer = json.loads(text)
    # Epoint deployments return either the documented wrapper or a direct list.
    if isinstance(outer, list):
        return outer, None
    if not isinstance(outer, dict):
        raise ValueError("outer response")
    candidate = outer.get("data", outer.get("custom"))
    if isinstance(candidate, str):
        candidate = json.loads(candidate)
    if isinstance(candidate, list):
        return candidate, _positive_total(outer)
    if not isinstance(candidate, dict):
        raise ValueError("inner response")
    records = candidate.get("data")
    if not isinstance(records, list):
        raise ValueError("records")
    return records, _positive_total(candidate) or _positive_total(outer)


def _positive_total(value: Mapping[str, object]) -> int | None:
    for key in ("total", "totalCount", "totalcount", "count", "recordCount"):
        if key not in value:
            continue
        try:
            total = int(value[key])
        except (TypeError, ValueError):
            continue
        if total >= 0:
            return total
    return None
