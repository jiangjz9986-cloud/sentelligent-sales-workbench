"""Bounded HTML-list adapter for Qingdao public procurement notices."""

from __future__ import annotations

import re
import time
from html.parser import HTMLParser
from typing import Mapping
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

from hospital_tender_monitor.http import HttpClient, HttpError
from hospital_tender_monitor.models import NoticeType, TenderNotice

from .base import SourceAdapter, SourceResult, parse_published_at, public_link, source_text, strip_html


FLAGS: tuple[tuple[str, NoticeType], ...] = (
    ("0", NoticeType.PROCUREMENT),
    ("5", NoticeType.CHANGE),
    ("2", NoticeType.RESULT),
    ("3", NoticeType.TERMINATED),
    ("18", NoticeType.CONTRACT),
)
DEFAULT_AREA_CODES = ("0214", "0209")
_DEFAULT_MAX_PAGES = 10
_HARD_MAX_PAGES = 100
_MAX_AREA_CODES = 8
_REQUEST_ATTEMPTS = 3
_RETRY_DELAYS = (0.5, 1.0)
_DETAIL_PREFIX = "/TradeDetals-ZtbShow/"
_CONTRACT_DETAIL_PREFIX = "/Contact-HTGS/"
_DETAIL_PREFIXES = (_DETAIL_PREFIX, _CONTRACT_DETAIL_PREFIX)
_DETAIL = re.compile(
    r"^/TradeDetals-ZtbShow/(?P<id>[^/?#-]+)-[^/?#-]+-1-"
    r"(?P<flag>[^/?#-]+)-[^/?#-]+/[^/?#]+$"
)
_CONTRACT_DETAIL = re.compile(r"^/Contact-HTGS/(?P<id>[0-9]+)$")
_DATE = re.compile(r"(?<!\d)(\d{4}[-/]\d{2}[-/]\d{2})(?!\d)")
_AREA_CODE = re.compile(r"\d{4}")


class _ListParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.records: list[tuple[str, str, str]] = []
        self.next_href = ""
        self.saw_list = False
        self.saw_pager = False
        self._row: dict[str, object] | None = None
        self._detail_anchor: dict[str, object] | None = None
        self._pager_depth = 0
        self._pager_anchor: dict[str, object] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        attributes = {name.casefold(): value or "" for name, value in attrs}
        classes = set(attributes.get("class", "").split())
        if tag == "div":
            if self._pager_depth:
                self._pager_depth += 1
            elif "pages" in classes:
                self._pager_depth = 1
                self.saw_pager = True
            if "list_info" in classes:
                self.saw_list = True
        if tag == "table":
            self.saw_list = True
        if tag == "tr":
            self._finish_row()
            self._row = {"text": [], "href": "", "title": ""}
        if tag == "a" and self._pager_depth:
            self._pager_anchor = {
                "href": attributes.get("href", ""),
                "disabled": "disabled" in attributes,
                "text": [],
            }
        href = attributes.get("href", "")
        if (
            tag == "a"
            and self._row is not None
            and any(href.startswith(prefix) for prefix in _DETAIL_PREFIXES)
        ):
            self._detail_anchor = {
                "href": href,
                "title": attributes.get("title", ""),
                "text": [],
            }

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag == "a":
            self._finish_detail_anchor()
            self._finish_pager_anchor()
        if tag == "tr":
            self._finish_row()
        if tag == "div" and self._pager_depth:
            self._pager_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._row is not None:
            row_text = self._row["text"]
            assert isinstance(row_text, list)
            row_text.append(data)
        if self._detail_anchor is not None:
            anchor_text = self._detail_anchor["text"]
            assert isinstance(anchor_text, list)
            anchor_text.append(data)
        if self._pager_anchor is not None:
            pager_text = self._pager_anchor["text"]
            assert isinstance(pager_text, list)
            pager_text.append(data)

    def close(self) -> None:
        super().close()
        self._finish_detail_anchor()
        self._finish_pager_anchor()
        self._finish_row()

    def _finish_detail_anchor(self) -> None:
        if self._detail_anchor is None:
            return
        if self._row is not None and not self._row["href"]:
            title = str(self._detail_anchor["title"])
            if not title:
                text_parts = self._detail_anchor["text"]
                assert isinstance(text_parts, list)
                title = " ".join(str(part) for part in text_parts)
            self._row["href"] = str(self._detail_anchor["href"])
            self._row["title"] = title
        self._detail_anchor = None

    def _finish_pager_anchor(self) -> None:
        if self._pager_anchor is None:
            return
        text_parts = self._pager_anchor["text"]
        assert isinstance(text_parts, list)
        text = " ".join(str(part) for part in text_parts).strip()
        if (
            text == "下一页"
            and not self._pager_anchor["disabled"]
            and self._pager_anchor["href"]
        ):
            self.next_href = str(self._pager_anchor["href"])
        self._pager_anchor = None

    def _finish_row(self) -> None:
        if self._row is None:
            return
        href = str(self._row["href"])
        if href:
            text_parts = self._row["text"]
            assert isinstance(text_parts, list)
            row_text = " ".join(str(part) for part in text_parts)
            date_matches = _DATE.findall(row_text)
            # The date cell follows the title cell in the source table.  Use
            # the last match so a project title containing an ISO date cannot
            # masquerade as the publication date.
            date = date_matches[-1] if date_matches else ""
            self.records.append((str(self._row["title"]), href, date))
        self._row = None
        self._detail_anchor = None


class QingdaoAdapter(SourceAdapter):
    def __init__(self, source: Mapping[str, object], http: HttpClient) -> None:
        self.source = source
        self.http = http

    def fetch(self) -> SourceResult:
        notices: list[TenderNotice] = []
        seen_notices: set[str] = set()
        try:
            max_pages = _max_pages(self.source)
            for area_code in _area_codes(self.source):
                for flag, notice_type in FLAGS:
                    page = 1
                    seen_pages: set[int] = set()
                    seen_fingerprints: set[tuple[str, ...]] = set()
                    for _ in range(max_pages):
                        if page in seen_pages:
                            raise ValueError("pagination loop")
                        seen_pages.add(page)
                        response = self._request_with_retry(
                            self._list_url(area_code, flag, page)
                        )
                        if (
                            not isinstance(response.text, str)
                            or response.status < 200
                            or response.status >= 300
                        ):
                            raise ValueError("response")
                        parser = _ListParser()
                        parser.feed(response.text)
                        parser.close()
                        if not parser.saw_list:
                            raise ValueError("page structure")
                        if not parser.records:
                            break
                        fingerprint = tuple(sorted(record[1] for record in parser.records))
                        if fingerprint in seen_fingerprints:
                            raise ValueError("repeated page")
                        seen_fingerprints.add(fingerprint)
                        for record in parser.records:
                            notice = self._notice(record, notice_type, flag)
                            if notice is None or notice.identity_key in seen_notices:
                                continue
                            seen_notices.add(notice.identity_key)
                            notices.append(notice)
                        if not parser.next_href:
                            break
                        next_page = _next_page(parser.next_href)
                        if next_page is None or next_page <= page or next_page in seen_pages:
                            raise ValueError("pagination loop")
                        page = next_page
        except (HttpError, ValueError, TypeError, AttributeError):
            return SourceResult(success=False, error="invalid source response")
        return SourceResult(notices=tuple(notices))

    def _request_with_retry(self, url: str):
        """Retry transient transport failures before failing the source.

        The Qingdao contract endpoint occasionally resets an otherwise valid
        connection.  Keep the retry local to this adapter so other sources do
        not inherit a longer request budget, and preserve the generic error
        boundary used by the runner.
        """
        for attempt in range(_REQUEST_ATTEMPTS):
            try:
                return self.http.request("GET", url)
            except HttpError:
                if attempt >= _REQUEST_ATTEMPTS - 1:
                    raise
                time.sleep(_RETRY_DELAYS[attempt])
        raise HttpError("request failed")

    def _list_url(self, area_code: str, flag: str, page: int) -> str:
        path = f"/Tradeinfo-GGGSList/1-1-{flag}"
        endpoint = urljoin(source_text(self.source, "url"), path)
        query = urlencode({"ArryCode": area_code, "Time": "07", "pageIndex": str(page)})
        return f"{endpoint}?{query}"

    def _notice(
        self,
        record: tuple[str, str, str],
        notice_type: NoticeType,
        flag: str,
    ) -> TenderNotice | None:
        title_value, href, date_value = record
        if flag == "18":
            match = _CONTRACT_DETAIL.fullmatch(href)
        else:
            match = _DETAIL.fullmatch(href)
            if match is not None and match.group("flag") != flag:
                return None
        if match is None:
            return None
        title = strip_html(title_value)
        published_at = parse_published_at(date_value)
        if not title or published_at is None:
            return None
        try:
            link = public_link(source_text(self.source, "url"), href)
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
            source_item_id=match.group("id"),
            raw_content=title,
        )


def _area_codes(source: Mapping[str, object]) -> tuple[str, ...]:
    raw_codes = source.get("area_codes", source.get("areas", DEFAULT_AREA_CODES))
    if isinstance(raw_codes, (str, bytes)) or not isinstance(raw_codes, (list, tuple)):
        raise ValueError("area codes")
    codes: list[str] = []
    seen: set[str] = set()
    for raw_code in raw_codes:
        code = str(raw_code).strip()
        if not _AREA_CODE.fullmatch(code):
            raise ValueError("area codes")
        if code not in seen:
            seen.add(code)
            codes.append(code)
    if not codes or len(codes) > _MAX_AREA_CODES:
        raise ValueError("area codes")
    return tuple(codes)


def _max_pages(source: Mapping[str, object]) -> int:
    raw_value = source.get("max_pages", _DEFAULT_MAX_PAGES)
    if type(raw_value) is bool or not isinstance(raw_value, (int, str, float)):
        raise ValueError("max pages")
    if isinstance(raw_value, float) and not raw_value.is_integer():
        raise ValueError("max pages")
    try:
        value = int(raw_value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("max pages") from exc
    if value < 1 or value > _HARD_MAX_PAGES:
        raise ValueError("max pages")
    return value


def _next_page(href: str) -> int | None:
    values = parse_qs(urlsplit(href).query).get("pageIndex", ())
    if len(values) != 1:
        return None
    try:
        page = int(values[0])
    except (TypeError, ValueError):
        return None
    return page if page > 0 else None
