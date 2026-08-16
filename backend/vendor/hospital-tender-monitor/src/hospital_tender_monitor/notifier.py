"""Safe PushPlus delivery and deterministic Markdown digest rendering."""

from __future__ import annotations

import json
import socket
from dataclasses import dataclass, field
from typing import Iterable, Sequence
from urllib.parse import quote, urlsplit

from .http import HttpClient, HttpError
from .models import ClassifiedNotice, SourceHealth


PUSHPLUS_ENDPOINT = "https://www.pushplus.plus/send"


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    success: bool
    batch_count: int = 0
    error_category: str = ""
    error: str = field(default="", repr=False)

    def __str__(self) -> str:
        return f"DeliveryResult(success={self.success!r}, batch_count={self.batch_count!r}, error_category={self.error_category!r})"


def _escape_markdown(value: object) -> str:
    text = str(value or "")
    # Escape punctuation that can alter Markdown structure while preserving CJK text.
    for char in ("\\", "`", "*", "_", "[", "]", "(", ")", "#", ">", "|"):
        text = text.replace(char, "\\" + char)
    return text


def _limit_utf8(text: str, limit: int) -> str:
    if limit < 1:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= limit:
        return text
    return encoded[:limit].decode("utf-8", errors="ignore")


def _markdown_url(value: str) -> str:
    """Keep URL syntax intact while encoding Markdown destination delimiters."""
    return quote(value, safe=":/?#[]@!$&'*+,;=%~-._")


def _notice_sort_key(item: ClassifiedNotice) -> tuple[str, str, str, str, str]:
    notice = item.notice
    return (
        notice.city,
        notice.source_name,
        notice.notice_type.value,
        notice.title,
        notice.identity_key,
    )


_TYPE_LABELS = {
    "plan": "采购计划",
    "procurement": "采购公告",
    "single_source": "单一来源",
    "change": "变更公告",
    "result": "中标结果",
    "terminated": "终止公告",
    "contract": "合同公告",
    "unknown": "其他",
}


def render_digest(
    notices: Iterable[ClassifiedNotice],
    *,
    max_items: int = 50,
    max_bytes: int = 60_000,
) -> str:
    """Render notices grouped by city/source/type with stable ordering and bounds."""
    max_items = max(0, int(max_items))
    max_bytes = max(1, int(max_bytes))
    selected = sorted(tuple(notices), key=_notice_sort_key)[:max_items]
    lines = ["# 医院 IT 招标日报"]
    current_group: tuple[str, str, str] | None = None
    for item in selected:
        notice = item.notice
        group = (notice.city, notice.source_name, notice.notice_type.value)
        if group != current_group:
            lines.append("")
            lines.append(
                f"## {_escape_markdown(notice.city)} / {_escape_markdown(notice.source_name)} / {_escape_markdown(_TYPE_LABELS.get(notice.notice_type.value, notice.notice_type.value))}"
            )
            current_group = group
        title = _escape_markdown(notice.title)
        link = _markdown_url(notice.url or "#")
        details = [f"[项目链接]({link})"]
        if notice.project_code:
            details.append(f"项目编号: {_escape_markdown(notice.project_code)}")
        if item.reasons:
            details.append(f"原因: {_escape_markdown('；'.join(item.reasons))}")
        elif item.matched_terms:
            details.append(f"匹配: {_escape_markdown('、'.join(item.matched_terms))}")
        lines.append(f"- **{title}** — " + " · ".join(details))
    if len(lines) == 1:
        lines.append("")
    return _limit_utf8("\n".join(lines), max_bytes)


def render_health_alert(health_rows: Iterable[SourceHealth], *, max_bytes: int = 12_000) -> str:
    """Render source health failures/staleness without exposing diagnostics."""
    rows = sorted(tuple(health_rows), key=lambda row: row.source_id)
    lines = ["# 招标监测源健康提醒", ""]
    for row in rows:
        status = "正常" if row.success else "失败"
        detail = _escape_markdown(row.error) if row.error else f"条目数: {row.item_count}"
        lines.append(f"- **{_escape_markdown(row.source_id)}**: {status}（{detail}）")
    return _limit_utf8("\n".join(lines), max_bytes)


class PushPlusNotifier:
    """PushPlus client. Token is retained only for request construction and redacted everywhere else."""

    def __init__(
        self,
        http_client: HttpClient,
        token: str,
        *,
        endpoint: str = PUSHPLUS_ENDPOINT,
        max_items: int = 50,
        max_bytes: int = 60_000,
        title: str = "医院IT招标监测",
    ) -> None:
        parts = urlsplit(endpoint)
        if endpoint != PUSHPLUS_ENDPOINT:
            raise ValueError("PushPlus endpoint is fixed")
        if parts.scheme.lower() != "https" or not parts.hostname or parts.username or parts.password:
            raise ValueError("PushPlus endpoint must use HTTPS")
        if not isinstance(token, str) or not token:
            raise ValueError("PushPlus token is required")
        self._http = http_client
        self._token = token
        self._endpoint = endpoint
        self.max_items = max(1, int(max_items))
        self.max_bytes = max(256, int(max_bytes))
        self.title = title

    def __repr__(self) -> str:
        return f"PushPlusNotifier(endpoint={self._endpoint!r}, max_items={self.max_items!r}, max_bytes={self.max_bytes!r})"

    def _batches(self, notices: Sequence[ClassifiedNotice]) -> list[str]:
        if not notices:
            return []
        batches: list[str] = []
        current: list[ClassifiedNotice] = []
        for notice in sorted(notices, key=_notice_sort_key):
            candidate = current + [notice]
            # Measure before applying byte truncation so an oversized group is split.
            rendered = render_digest(candidate, max_items=self.max_items, max_bytes=10**9)
            if current and (len(candidate) > self.max_items or len(rendered.encode("utf-8")) > self.max_bytes):
                batches.append(render_digest(current, max_items=self.max_items, max_bytes=self.max_bytes))
                current = [notice]
            else:
                current = candidate
        if current:
            batches.append(render_digest(current, max_items=self.max_items, max_bytes=self.max_bytes))
        return batches

    def send_digest(self, notices: Iterable[ClassifiedNotice], *, title: str | None = None) -> DeliveryResult:
        return self.send(notices, title=title)

    def send_health_alert(self, health_rows: Iterable[SourceHealth], *, title: str = "医院IT招标监测健康提醒") -> DeliveryResult:
        return self.send(render_health_alert(health_rows, max_bytes=self.max_bytes), title=title)

    def send(self, notices_or_content: Iterable[ClassifiedNotice] | str, *, title: str | None = None) -> DeliveryResult:
        if isinstance(notices_or_content, str):
            batches = [_limit_utf8(notices_or_content, self.max_bytes)]
        else:
            batches = self._batches(tuple(notices_or_content))
        if not batches:
            return DeliveryResult(True, 0)
        for content in batches:
            payload = json.dumps(
                {"token": self._token, "title": title or self.title, "content": content, "template": "markdown"},
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
            try:
                response = self._http.request(
                    "POST",
                    self._endpoint,
                    data=payload,
                    headers={"Content-Type": "application/json", "Accept": "application/json"},
                )
            except (TimeoutError, socket.timeout):
                return DeliveryResult(False, len(batches), "timeout", "PushPlus request timed out")
            except HttpError:
                return DeliveryResult(False, len(batches), "http_failure", "PushPlus HTTP request failed")
            except Exception:
                return DeliveryResult(False, len(batches), "http_failure", "PushPlus HTTP request failed")
            if getattr(response, "status", 0) < 200 or getattr(response, "status", 0) >= 300:
                return DeliveryResult(False, len(batches), "http_failure", "PushPlus HTTP request failed")
            if len(getattr(response, "body", b"")) > 64 * 1024:
                return DeliveryResult(False, len(batches), "invalid_json", "PushPlus response was invalid")
            try:
                data = json.loads(response.text)
            except (TypeError, ValueError, json.JSONDecodeError):
                return DeliveryResult(False, len(batches), "invalid_json", "PushPlus response was invalid")
            if not isinstance(data, dict) or type(data.get("code")) is not int or data.get("code") != 200:
                return DeliveryResult(False, len(batches), "business_failure", "PushPlus rejected the message")
        return DeliveryResult(True, len(batches))
