"""Adapter for configured Jining tenant newest.json public endpoints."""

from __future__ import annotations

import json
from typing import Mapping
from urllib.parse import quote, urljoin

from hospital_tender_monitor.http import HttpClient, HttpError
from hospital_tender_monitor.models import NoticeType, TenderNotice

from .base import SourceAdapter, SourceResult, parse_published_at, public_link, source_text, strip_html


CATEGORY_TYPES = {
    "536": NoticeType.PLAN,
    "503000": NoticeType.PROCUREMENT,
    "551001": NoticeType.PROCUREMENT,
    "55100101": NoticeType.PROCUREMENT,
    "551003": NoticeType.UNKNOWN,
}


class JiningAdapter(SourceAdapter):
    def __init__(self, source: Mapping[str, object], http: HttpClient) -> None:
        self.source = source
        self.http = http

    def fetch(self) -> SourceResult:
        categories = self.source.get("categories", ())
        if not isinstance(categories, (list, tuple)):
            return SourceResult(success=False, error="invalid source response")
        tenant = source_text(self.source, "tenant")
        if not tenant:
            return SourceResult(success=False, error="invalid source response")
        notices: list[TenderNotice] = []
        seen: set[str] = set()
        try:
            for category_value in categories:
                category = str(category_value)
                endpoint = urljoin(
                    source_text(self.source, "url"),
                    f"/Tenants/{quote(tenant, safe='')}/Posts/{quote(category, safe='')}/newest.json",
                )
                response = self.http.request("GET", endpoint)
                document = json.loads(response.text)
                records = document.get("data") if isinstance(document, dict) else document
                if not isinstance(records, list):
                    raise ValueError("records")
                for record in records:
                    notice = self._notice(record, CATEGORY_TYPES.get(category, NoticeType.UNKNOWN))
                    if notice is not None and notice.identity_key not in seen:
                        seen.add(notice.identity_key)
                        notices.append(notice)
        except (HttpError, ValueError, json.JSONDecodeError, TypeError):
            return SourceResult(success=False, error="invalid source response")
        return SourceResult(notices=tuple(notices))

    def _notice(self, record: object, notice_type: NoticeType) -> TenderNotice | None:
        if not isinstance(record, dict):
            return None
        title = strip_html(record.get("title"))
        published_at = parse_published_at(record.get("date"))
        if not title or published_at is None:
            return None
        raw_link = str(record.get("url") or "").strip()
        source_item_id = str(record.get("id") or "").strip()
        if raw_link and "/" not in raw_link and "?" not in raw_link and ":" not in raw_link:
            source_item_id = source_item_id or raw_link
            tenant = source_text(self.source, "tenant")
            raw_link = f"/{quote(tenant, safe='')}/Posts/Detail?id={quote(raw_link, safe='')}"
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
            raw_content=title,
        )
