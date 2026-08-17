"""Small, bounded HTTP client for public source requests.

``urllib`` exposes one socket timeout.  Passing it to ``open`` applies that
same bound to connection establishment and subsequent socket reads.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from dataclasses import dataclass
from typing import Callable, Mapping, Protocol
from urllib.error import HTTPError as UrlHttpError
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import validate_public_url


USER_AGENT = "hospital-it-tender-monitor/0.1"
_SENSITIVE_HEADERS = {"authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token"}
_MAX_ATTEMPTS = 5
_MAX_RETRY_AFTER_SECONDS = 5.0


class HttpError(RuntimeError):
    """A deliberately non-diagnostic transport error safe to record."""


@dataclass(frozen=True, slots=True)
class HttpResponse:
    url: str
    status: int
    body: bytes
    charset: str = "utf-8"

    @property
    def text(self) -> str:
        try:
            return self.body.decode(self.charset, errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")


class _Opener(Protocol):
    def __call__(self, request: Request, timeout: float) -> object: ...


def _validate_resolved_destination(
    url: str, resolver: Callable[..., list[tuple[object, ...]]]
) -> None:
    parts = urlsplit(url)
    host = parts.hostname
    if not host:
        raise HttpError("request failed")
    port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
    try:
        answers = resolver(host, port, type=socket.SOCK_STREAM)
    except Exception as exc:
        raise HttpError("request failed") from exc
    if not answers:
        raise HttpError("request failed")
    for answer in answers:
        try:
            address = str(answer[4][0])
            parsed = ipaddress.ip_address(address)
        except (IndexError, KeyError, TypeError, ValueError) as exc:
            raise HttpError("request failed") from exc
        if (
            parsed.is_loopback
            or parsed.is_link_local
            or parsed.is_multicast
            or parsed.is_unspecified
            or parsed.is_private
        ):
            raise HttpError("request failed")


class _HostLockedRedirectHandler(HTTPRedirectHandler):
    """Allow same-host redirects under an explicit scheme/port policy."""

    def __init__(
        self,
        resolver: Callable[..., list[tuple[object, ...]]] = socket.getaddrinfo,
    ) -> None:
        super().__init__()
        self._resolver = resolver

    def redirect_request(self, req: Request, fp: object, code: int, msg: str, headers: object, newurl: str) -> Request:
        try:
            normalized_url = validate_public_url(newurl)
            source_parts = urlsplit(req.full_url)
            destination_parts = urlsplit(normalized_url)
            source = source_parts.hostname
            destination = destination_parts.hostname
            source_scheme = source_parts.scheme.lower()
            destination_scheme = destination_parts.scheme.lower()
            source_port = source_parts.port or (443 if source_scheme == "https" else 80)
            destination_port = destination_parts.port or (443 if destination_scheme == "https" else 80)
        except ValueError as exc:
            raise HttpError("request failed") from exc
        if not source or source.lower().rstrip(".") != (destination or "").lower().rstrip("."):
            raise HttpError("request failed")
        if source_scheme == "https" and destination_scheme == "http":
            raise HttpError("request failed")
        if source_scheme == destination_scheme:
            allowed_ports = source_port == destination_port
        elif source_scheme == "http" and destination_scheme == "https":
            allowed_ports = source_port == 80 and destination_port == 443
        else:
            allowed_ports = False
        if not allowed_ports:
            raise HttpError("request failed")
        _validate_resolved_destination(normalized_url, self._resolver)
        return super().redirect_request(req, fp, code, msg, headers, normalized_url)


class HttpClient:
    """Make bounded, anonymous, size-limited public HTTP requests.

    Each request uses at most ``max_attempts`` attempts (capped at five), with
    transient failures retried using bounded backoff and optional Retry-After.
    """

    def __init__(
        self,
        timeout_seconds: float = 15,
        max_response_bytes: int = 2_000_000,
        *,
        opener: _Opener | None = None,
        resolver: Callable[..., list[tuple[object, ...]]] = socket.getaddrinfo,
        sleeper: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        max_attempts: int = 2,
        min_interval_seconds: float = 0.0,
    ) -> None:
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self.max_response_bytes = max(1, int(max_response_bytes))
        if type(max_attempts) is not int or not 1 <= max_attempts <= _MAX_ATTEMPTS:
            raise ValueError("max_attempts must be between 1 and 5")
        if not isinstance(min_interval_seconds, (int, float)) or not 0 <= min_interval_seconds <= 10:
            raise ValueError("min_interval_seconds must be between 0 and 10")
        self.max_attempts = max_attempts
        self.min_interval_seconds = float(min_interval_seconds)
        self._resolver = resolver
        self._sleeper = sleeper
        self._monotonic = monotonic
        self._last_request_at: float | None = None
        self._redirect_handler = _HostLockedRedirectHandler(resolver)
        if opener is None:
            urllib_opener = build_opener(self._redirect_handler)
            self._opener: _Opener = urllib_opener.open
        else:
            self._opener = opener

    def request(
        self,
        method: str,
        url: str,
        data: bytes | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> HttpResponse:
        try:
            normalized_url = validate_public_url(url)
            self._validate_resolved_destination(normalized_url)
            request_headers = self._request_headers(headers)
            request = Request(normalized_url, data=data, headers=request_headers, method=method.upper())
        except (TypeError, ValueError, HttpError) as exc:
            raise HttpError("request failed") from exc

        for attempt in range(self.max_attempts):
            self._wait_for_request_slot()
            try:
                response = self._opener(request, timeout=self.timeout_seconds)
                return self._read_response(response)
            except HttpError:
                raise
            except UrlHttpError as exc:
                if (exc.code == 429 or 500 <= exc.code < 600) and attempt < self.max_attempts - 1:
                    self._sleeper(self._retry_delay(attempt, exc))
                    continue
                raise HttpError("request failed") from exc
            except (URLError, TimeoutError, socket.timeout, OSError) as exc:
                if attempt < self.max_attempts - 1:
                    self._sleeper(self._retry_delay(attempt))
                    continue
                raise HttpError("request failed") from exc
            except Exception as exc:
                raise HttpError("request failed") from exc
        raise HttpError("request failed")

    def _wait_for_request_slot(self) -> None:
        now = self._monotonic()
        if self._last_request_at is not None:
            remaining = self.min_interval_seconds - (now - self._last_request_at)
            if remaining > 0:
                self._sleeper(remaining)
        self._last_request_at = self._monotonic()

    def _retry_delay(self, attempt: int, error: UrlHttpError | None = None) -> float:
        fallback = min(0.25 * (2**attempt), _MAX_RETRY_AFTER_SECONDS)
        if error is None or error.code != 429:
            return fallback
        try:
            raw = error.headers.get("Retry-After", "")
            delay = float(str(raw).strip())
        except (AttributeError, TypeError, ValueError):
            return fallback
        return min(max(delay, 0.0), _MAX_RETRY_AFTER_SECONDS)

    def _request_headers(self, headers: Mapping[str, str] | None) -> dict[str, str]:
        safe_headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
        for name, value in (headers or {}).items():
            if name.lower() in _SENSITIVE_HEADERS or "token" in name.lower():
                raise HttpError("request failed")
            safe_headers[str(name)] = str(value)
        safe_headers["User-Agent"] = USER_AGENT
        return safe_headers

    def _validate_resolved_destination(self, url: str) -> None:
        _validate_resolved_destination(url, self._resolver)

    def _read_response(self, response: object) -> HttpResponse:
        try:
            body = response.read(self.max_response_bytes + 1)
            if len(body) > self.max_response_bytes:
                raise HttpError("request failed")
            headers = response.headers
            charset = headers.get_content_charset() or "utf-8"
            return HttpResponse(
                url=response.geturl(), status=response.getcode() or 200, body=body, charset=charset
            )
        except HttpError:
            raise
        except Exception as exc:
            raise HttpError("request failed") from exc
        finally:
            close = getattr(response, "close", None)
            if close is not None:
                close()
