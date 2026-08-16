"""Conservative adapter for public hospital HTML notice lists."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Callable, Mapping

from hospital_tender_monitor.http import HttpClient, HttpError
from hospital_tender_monitor.models import NoticeType, TenderNotice, canonicalize_url

from .base import SourceAdapter, SourceResult, parse_published_at, public_link, source_text, strip_html


_DATE = re.compile(r"(?<!\d)(\d{4}[-/]\d{2}[-/]\d{2})(?!\d)")
_DEFAULT_TERMS = ("采购", "招标", "议价", "成交", "中标", "调研", "需求", "咨询", "公示", "磋商", "谈判", "询价")


class _RecordParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.records: list[tuple[str, str, str]] = []
        self._boundary: dict[str, object] | None = None
        self._anchor: dict[str, object] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in {"li", "tr"} and self._boundary is None:
            self._boundary = {"tag": tag, "text": [], "href": "", "title": []}
        if self._boundary is not None:
            if tag == "a" and self._anchor is None:
                href = dict(attrs).get("href") or ""
                self._anchor = {"href": href, "text": []}

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._boundary is None:
            return
        if tag == "a" and self._anchor is not None:
            title = " ".join(self._anchor["text"])  # type: ignore[arg-type]
            if not self._boundary["href"] and title.strip():
                self._boundary["href"] = self._anchor["href"]
                self._boundary["title"] = [title]
            self._anchor = None
        if tag == self._boundary["tag"]:
            text = " ".join(self._boundary["text"])  # type: ignore[arg-type]
            title = " ".join(self._boundary["title"])  # type: ignore[arg-type]
            if title and self._boundary["href"]:
                self.records.append((title, str(self._boundary["href"]), text))
            self._boundary = None
            self._anchor = None

    def handle_data(self, data: str) -> None:
        if self._boundary is None:
            return
        self._boundary["text"].append(data)  # type: ignore[union-attr]
        if self._anchor is not None:
            self._anchor["text"].append(data)  # type: ignore[union-attr]


class HospitalHtmlAdapter(SourceAdapter):
    def __init__(
        self,
        source: Mapping[str, object],
        http: HttpClient,
        *,
        parser_factory: Callable[[], HTMLParser] = _RecordParser,
    ) -> None:
        self.source = source
        self.http = http
        self._parser_factory = parser_factory

    def fetch(self) -> SourceResult:
        try:
            response = self.http.request("GET", source_text(self.source, "url"))
            if not isinstance(response.text, str) or response.status < 200 or response.status >= 300:
                raise ValueError("response")
            parser = self._parser_factory()
            parser.feed(response.text)
            parser.close()
            terms = self.source.get("title_terms", _DEFAULT_TERMS)
            if not isinstance(terms, (list, tuple)):
                raise ValueError("terms")
            names = self.source.get("hospital_names", ())
            if not isinstance(names, (list, tuple)):
                raise ValueError("hospital names")
            notices: list[TenderNotice] = []
            seen: set[str] = set()
            for title, href, record_text in parser.records:  # type: ignore[attr-defined]
                title = strip_html(title)
                if not title or not any(str(term) and str(term) in title for term in terms):
                    continue
                date_match = _DATE.search(record_text)
                published_at = parse_published_at(date_match.group(1) if date_match else "")
                if published_at is None:
                    continue
                try:
                    link = public_link(source_text(self.source, "url"), href)
                except ValueError:
                    continue
                canonical_link = canonicalize_url(link)
                if canonical_link in seen:
                    continue
                seen.add(canonical_link)
                notices.append(TenderNotice(
                    source_id=source_text(self.source, "id"),
                    source_name=source_text(self.source, "name"),
                    city=source_text(self.source, "city"),
                    title=title,
                    url=link,
                    published_at=published_at,
                    notice_type=NoticeType.UNKNOWN,
                    content_text=title,
                    hospital_names=tuple(str(name) for name in names),
                    raw_content=title,
                ))
            return SourceResult(notices=tuple(notices))
        except (HttpError, ValueError, TypeError, AttributeError):
            return SourceResult(success=False, error="invalid source response")
