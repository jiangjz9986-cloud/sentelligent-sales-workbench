"""Adapter for Binzhou's public-resource full-text search endpoint."""

from __future__ import annotations

import json
from typing import Mapping
from urllib.parse import parse_qs, quote, urljoin, urlsplit

from hospital_tender_monitor.http import HttpClient, HttpError
from hospital_tender_monitor.models import TenderNotice

from .base import SourceAdapter, SourceResult, parse_published_at, public_link, source_text, strip_html


_ENDPOINT = "/inteligentsearch/rest/esinteligentsearch/getFullTextDataNew"
_TENANT_CODES = {
    "bzweb": "001",
    "zpweb": "003",
    "hmweb": "004",
    "bxweb": "007",
}
_PAGE_SIZE = 50
_MAX_PAGES = 5


class BinzhouAdapter(SourceAdapter):
    def __init__(self, source: Mapping[str, object], http: HttpClient) -> None:
        self.source = source
        self.http = http

    def fetch(self) -> SourceResult:
        source_url = source_text(self.source, "url")
        parts = urlsplit(source_url)
        if (parts.hostname or "").casefold() != "jypt.bzggzyjy.cn":
            return SourceResult(success=False, error="invalid source response")
        tenant = next((part for part in parts.path.split("/") if part), "").casefold()
        query = parse_qs(parts.query)
        keyword = query.get("wd", [""])[0].strip()
        category = query.get("cnum", [_TENANT_CODES.get(tenant, "")])[0].strip()
        hospital_names = self.source.get("hospital_names", ())
        if (
            tenant not in _TENANT_CODES
            or not keyword
            or category != _TENANT_CODES[tenant]
            or not isinstance(hospital_names, (list, tuple))
            or not hospital_names
        ):
            return SourceResult(success=False, error="invalid source response")
        normalized_names = tuple(dict.fromkeys(
            str(name).strip() for name in hospital_names if isinstance(name, str) and name.strip()
        ))
        if not normalized_names:
            return SourceResult(success=False, error="invalid source response")

        endpoint = urljoin(source_url, _ENDPOINT)
        base_url = f"{parts.scheme}://{parts.netloc}/{tenant}/"
        notices: list[TenderNotice] = []
        seen: set[str] = set()
        try:
            for page in range(_MAX_PAGES):
                payload = {
                    "token": "",
                    "pn": page * _PAGE_SIZE,
                    "rn": _PAGE_SIZE,
                    "sdt": "",
                    "edt": "",
                    "wd": quote(keyword),
                    "inc_wd": "",
                    "exc_wd": "",
                    "fields": "title",
                    "cnum": category,
                    "sort": json.dumps({"webdate": "0"}, separators=(",", ":")),
                    "ssort": "title",
                    "cl": 500,
                    "terminal": "",
                    "condition": None,
                    "time": None,
                    "highlights": "title",
                    "statistics": None,
                    "unionCondition": None,
                    "accuracy": "100",
                    "noParticiple": "1",
                    "searchRange": None,
                }
                response = self.http.request(
                    "POST",
                    endpoint,
                    data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                )
                outer = json.loads(response.text)
                result = outer.get("result") if isinstance(outer, dict) else None
                records = result.get("records") if isinstance(result, dict) else None
                if not isinstance(records, list):
                    raise ValueError("records")
                for record in records:
                    notice = self._notice(record, base_url, normalized_names)
                    if notice is not None and notice.identity_key not in seen:
                        seen.add(notice.identity_key)
                        notices.append(notice)
                if len(records) < _PAGE_SIZE:
                    break
        except (HttpError, ValueError, TypeError, json.JSONDecodeError):
            return SourceResult(success=False, error="invalid source response")
        return SourceResult(notices=tuple(notices))

    def _notice(
        self,
        record: object,
        base_url: str,
        hospital_names: tuple[str, ...],
    ) -> TenderNotice | None:
        if not isinstance(record, dict):
            return None
        title = strip_html(record.get("title"))
        matches = tuple(
            name for name in hospital_names
            if len(name) >= 4 and name.casefold() in title.casefold()
        )
        published_at = parse_published_at(record.get("webdate"))
        if not title or not matches or published_at is None:
            return None
        try:
            link = public_link(base_url, str(record.get("linkurl", "")).lstrip("/"))
        except ValueError:
            return None
        return TenderNotice(
            source_id=source_text(self.source, "id"),
            source_name=source_text(self.source, "name"),
            city=source_text(self.source, "city"),
            title=title,
            url=link,
            published_at=published_at,
            content_text=title,
            hospital_names=matches,
            source_item_id=str(record.get("id") or record.get("linkurl") or ""),
            raw_content=title,
        )
