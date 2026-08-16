"""Adapter for Dongying Epoint's first-page public listing endpoint."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Mapping
from urllib.parse import urlencode, urljoin

from hospital_tender_monitor.http import HttpClient, HttpError
from hospital_tender_monitor.models import NoticeType, TenderNotice

from .base import SourceAdapter, SourceResult, parse_published_at, public_link, source_text, strip_html


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


class DongyingAdapter(SourceAdapter):
    def __init__(self, source: Mapping[str, object], http: HttpClient) -> None:
        self.source = source
        self.http = http

    def fetch(self) -> SourceResult:
        notices: list[TenderNotice] = []
        endpoint = urljoin(source_text(self.source, "url"), _PATH)
        try:
            for category, notice_type in CATEGORIES:
                data = urlencode(
                    {
                        "siteGuid": source_text(self.source, "site_guid"),
                        "vname": source_text(self.source, "vname"),
                        "CatgoryNum": category,
                        "Title": "",
                        "pageSize": "20",
                        "pageIndex": "1",
                        "YZM": "",
                        "ImgGuid": "",
                    }
                ).encode("ascii")
                response = self.http.request(
                    "POST", endpoint, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}
                )
                records = _records(response.text)
                for record in records:
                    notice = self._notice(record, notice_type)
                    if notice is not None:
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
            raw_content=title,
        )


def _records(text: str) -> list[object]:
    outer = json.loads(text)
    if not isinstance(outer, dict):
        raise ValueError("outer response")
    candidate = outer.get("data", outer.get("custom"))
    if isinstance(candidate, str):
        candidate = json.loads(candidate)
    if not isinstance(candidate, dict):
        raise ValueError("inner response")
    records = candidate.get("data")
    if not isinstance(records, list):
        raise ValueError("records")
    return records
