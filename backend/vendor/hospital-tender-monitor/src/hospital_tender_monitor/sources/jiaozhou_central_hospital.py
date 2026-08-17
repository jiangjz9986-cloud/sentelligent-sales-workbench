"""Adapter for Jiaozhou Central Hospital's ASP.NET procurement list."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Mapping
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

from hospital_tender_monitor.http import HttpClient, HttpError
from hospital_tender_monitor.models import NoticeType, TenderNotice

from .base import SourceAdapter, SourceResult, parse_published_at, public_link, source_text, strip_html


_DEFAULT_MAX_PAGES = 10
_HARD_MAX_PAGES = 100
_DATE = re.compile(r"(?<!\d)(\d{4}[-/]\d{2}[-/]\d{2})(?!\d)")
_POSTBACK = re.compile(
    r"__doPostBack\(\s*['\"](?P<target>[^'\"]+)['\"]\s*,\s*['\"](?P<argument>[^'\"]*)['\"]\s*\)"
)
_DETAIL_PATH = "/Info/Open/Content1.aspx"
_DEFAULT_HOSPITAL_NAMES = ("青岛市胶州中心医院", "胶州市中心医院")


class _AspNetListParser(HTMLParser):
    """Extract list rows, hidden form state, and the pager's next argument."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.records: list[tuple[str, str, str]] = []
        self.hidden_fields: dict[str, str] = {}
        self.next_argument: str | None = None
        self.saw_list = False
        self.saw_pager = False
        self._list_depth = 0
        self._pager_depth = 0
        self._row: dict[str, object] | None = None
        self._row_anchor: dict[str, object] | None = None
        self._pager_anchor: dict[str, object] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        attributes = {name.casefold(): value or "" for name, value in attrs}
        classes = set(attributes.get("class", "").split())

        if tag == "input" and attributes.get("type", "").casefold() == "hidden":
            name = attributes.get("name", "")
            if name:
                self.hidden_fields[name] = attributes.get("value", "")

        if tag == "ul" and "textlist" in classes:
            self._list_depth += 1
            self.saw_list = True
        elif tag == "div" and self._list_depth and "textlist" in classes:
            # Some templates put a class-bearing wrapper around the list; it
            # is still enough to mark the page as a recognized list page.
            self.saw_list = True

        if tag == "div":
            if self._pager_depth:
                self._pager_depth += 1
            elif attributes.get("id", "") == "AspNetPager1" or "page" in classes:
                self._pager_depth = 1
                self.saw_pager = True

        if self._list_depth and tag == "li":
            self._finish_row()
            self._row = {"text": [], "href": "", "title": ""}

        if self._row is not None and tag == "a" and self._row_anchor is None:
            self._row_anchor = {"href": attributes.get("href", ""), "text": []}

        if self._pager_depth and tag == "a":
            href = attributes.get("href", "")
            postback = _POSTBACK.search(href)
            if postback is not None:
                self._pager_anchor = {
                    "target": postback.group("target"),
                    "argument": postback.group("argument"),
                    "disabled": "disabled" in attributes,
                    "text": [],
                }

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag == "a" and self._row_anchor is not None:
            self._finish_row_anchor()
        if tag == "a" and self._pager_anchor is not None:
            self._finish_pager_anchor()
        if tag == "li":
            self._finish_row()
        if tag == "ul" and self._list_depth:
            self._list_depth -= 1
        if tag == "div" and self._pager_depth:
            self._pager_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._row is not None:
            text_parts = self._row["text"]
            assert isinstance(text_parts, list)
            text_parts.append(data)
        if self._row_anchor is not None:
            text_parts = self._row_anchor["text"]
            assert isinstance(text_parts, list)
            text_parts.append(data)
        if self._pager_anchor is not None:
            text_parts = self._pager_anchor["text"]
            assert isinstance(text_parts, list)
            text_parts.append(data)

    def close(self) -> None:
        super().close()
        self._finish_row_anchor()
        self._finish_pager_anchor()
        self._finish_row()

    def _finish_row_anchor(self) -> None:
        if self._row_anchor is None:
            return
        if self._row is not None and not self._row["href"]:
            text_parts = self._row_anchor["text"]
            assert isinstance(text_parts, list)
            self._row["href"] = str(self._row_anchor["href"])
            self._row["title"] = " ".join(str(part) for part in text_parts)
        self._row_anchor = None

    def _finish_pager_anchor(self) -> None:
        if self._pager_anchor is None:
            return
        text_parts = self._pager_anchor["text"]
        assert isinstance(text_parts, list)
        text = " ".join(str(part) for part in text_parts).split()
        if (
            text == ["下一页"]
            and not self._pager_anchor["disabled"]
            and self._pager_anchor["target"] == "AspNetPager1"
        ):
            self.next_argument = str(self._pager_anchor["argument"])
        self._pager_anchor = None

    def _finish_row(self) -> None:
        if self._row is None:
            return
        href = str(self._row["href"])
        title = strip_html(self._row["title"])
        text_parts = self._row["text"]
        assert isinstance(text_parts, list)
        row_text = " ".join(str(part) for part in text_parts)
        date_matches = _DATE.findall(row_text)
        date = date_matches[-1] if date_matches else ""
        if href and title:
            self.records.append((title, href, date))
        self._row = None
        self._row_anchor = None


class JiaozhouCentralHospitalAdapter(SourceAdapter):
    """Collect all notices from the hospital's bounded ASP.NET list pages."""

    def __init__(self, source: Mapping[str, object], http: HttpClient) -> None:
        self.source = source
        self.http = http

    def fetch(self) -> SourceResult:
        notices: list[TenderNotice] = []
        seen: set[str] = set()
        try:
            max_pages = _max_pages(self.source)
            page_url = source_text(self.source, "url")
            page_number = 1
            seen_pages: set[int] = set()
            seen_fingerprints: set[tuple[str, ...]] = set()
            form_state: dict[str, str] | None = None
            current_url = page_url
            for _ in range(max_pages):
                if page_number in seen_pages:
                    raise ValueError("pagination loop")
                seen_pages.add(page_number)
                if form_state is None:
                    response = self.http.request("GET", current_url)
                else:
                    payload = dict(form_state)
                    payload["__EVENTTARGET"] = "AspNetPager1"
                    payload["__EVENTARGUMENT"] = str(page_number)
                    response = self.http.request(
                        "POST",
                        current_url,
                        data=urlencode(payload).encode("utf-8"),
                        headers={"Content-Type": "application/x-www-form-urlencoded"},
                    )
                if (
                    not isinstance(response.text, str)
                    or response.status < 200
                    or response.status >= 300
                ):
                    raise ValueError("response")
                parser = _AspNetListParser()
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
                    try:
                        notice = self._notice(record)
                    except (TypeError, ValueError):
                        # A broken detail link or date in one row must not
                        # discard the valid rows on this page or later pages.
                        continue
                    if notice is None or notice.identity_key in seen:
                        continue
                    seen.add(notice.identity_key)
                    notices.append(notice)
                next_page = _next_page(parser.next_argument)
                if next_page is None:
                    break
                if next_page <= page_number or next_page in seen_pages:
                    raise ValueError("pagination loop")
                if not parser.hidden_fields.get("__VIEWSTATE"):
                    raise ValueError("form state")
                form_state = parser.hidden_fields
                current_url = response.url or current_url
                page_number = next_page
        except (HttpError, ValueError, TypeError, AttributeError):
            return SourceResult(success=False, error="invalid source response")
        return SourceResult(notices=tuple(notices))

    def _notice(self, record: tuple[str, str, str]) -> TenderNotice | None:
        title, href, date_value = record
        try:
            link = public_link(source_text(self.source, "url"), href)
        except ValueError:
            return None
        link_parts = urlsplit(link)
        source_parts = urlsplit(source_text(self.source, "url"))
        if (link_parts.hostname or "").casefold().rstrip(".") != (
            source_parts.hostname or ""
        ).casefold().rstrip("."):
            return None
        if link_parts.path.rstrip("/").casefold() != _DETAIL_PATH.casefold():
            return None
        ids = parse_qs(link_parts.query, keep_blank_values=True).get("Id", ())
        if len(ids) != 1 or re.fullmatch(r"[0-9]+", ids[0]) is None:
            return None
        published_at = parse_published_at(date_value)
        if not title or published_at is None:
            return None
        names = self.source.get("hospital_names", _DEFAULT_HOSPITAL_NAMES)
        if not isinstance(names, (list, tuple)):
            raise ValueError("hospital names")
        return TenderNotice(
            source_id=source_text(self.source, "id"),
            source_name=source_text(self.source, "name"),
            city=source_text(self.source, "city"),
            title=title,
            url=link,
            published_at=published_at,
            notice_type=NoticeType.UNKNOWN,
            content_text=title,
            hospital_names=tuple(str(name) for name in names),
            source_item_id=ids[0],
            raw_content=title,
        )


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


def _next_page(argument: str | None) -> int | None:
    if argument is None or not str(argument).strip():
        return None
    try:
        page = int(str(argument).strip())
    except (TypeError, ValueError):
        raise ValueError("pagination") from None
    if page < 1:
        raise ValueError("pagination")
    return page


QdjzchAdapter = JiaozhouCentralHospitalAdapter

__all__ = ["JiaozhouCentralHospitalAdapter", "QdjzchAdapter"]
