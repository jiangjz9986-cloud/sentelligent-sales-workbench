from __future__ import annotations

import gzip
import socket
from email.message import Message
from io import BytesIO
from unittest import TestCase
from urllib.error import HTTPError

from hospital_tender_monitor.http import HttpClient, HttpError


class _Response:
    def __init__(self, url: str, body: bytes = b"ok") -> None:
        self._url = url
        self._body = BytesIO(body)
        self.headers = Message()
        self.headers["Content-Type"] = "application/json; charset=utf-8"

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def geturl(self) -> str:
        return self._url

    def getcode(self) -> int:
        return 200

    def close(self) -> None:
        pass


def _resolver(_host: str, port: int, *args, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]


class _Clock:
    def __init__(self) -> None:
        self.value = 0.0
        self.sleeps = []

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.value += seconds


class HttpBudgetTests(TestCase):
    def test_gzip_response_is_decompressed_with_bounded_output(self) -> None:
        class _GzipResponse(_Response):
            def __init__(self, url: str, body: bytes) -> None:
                super().__init__(url, body)
                self.headers["Content-Encoding"] = "gzip"

        requests = []

        def opener(request, timeout):
            requests.append(request)
            return _GzipResponse(request.full_url, gzip.compress(b"notices"))

        response = HttpClient(
            opener=opener,
            resolver=_resolver,
            max_attempts=1,
        ).request("GET", "https://public.example.test/notices")

        self.assertEqual(response.body, b"notices")
        self.assertEqual(requests[0].get_header("Accept-encoding"), "gzip")

    def test_gzip_response_cannot_exceed_decompressed_size_limit(self) -> None:
        class _GzipResponse(_Response):
            def __init__(self, url: str, body: bytes) -> None:
                super().__init__(url, body)
                self.headers["Content-Encoding"] = "gzip"

        client = HttpClient(
            opener=lambda request, timeout: _GzipResponse(request.full_url, gzip.compress(b"too long")),
            resolver=_resolver,
            max_attempts=1,
            max_response_bytes=4,
        )

        with self.assertRaises(HttpError):
            client.request("GET", "https://public.example.test/oversized")

    def test_unsupported_content_encoding_is_rejected(self) -> None:
        class _EncodedResponse(_Response):
            def __init__(self, url: str) -> None:
                super().__init__(url)
                self.headers["Content-Encoding"] = "br"

        client = HttpClient(
            opener=lambda request, timeout: _EncodedResponse(request.full_url),
            resolver=_resolver,
            max_attempts=1,
        )
        with self.assertRaises(HttpError):
            client.request("GET", "https://public.example.test/brotli")

    def test_source_budget_rejects_response_body_that_finishes_after_deadline(self) -> None:
        clock = _Clock()

        class _SlowResponse(_Response):
            def read(self, size: int = -1) -> bytes:
                clock.value += 21.0
                return super().read(size)

        client = HttpClient(
            timeout_seconds=15,
            opener=lambda request, timeout: _SlowResponse(request.full_url),
            resolver=_resolver,
            sleeper=clock.sleep,
            monotonic=clock.now,
            max_attempts=1,
            min_interval_seconds=0,
        )

        with self.assertRaises(HttpError):
            with client.request_budget(20):
                client.request("GET", "https://public.example.test/slow-body")

    def test_consecutive_requests_share_one_budget_and_context_exit_restores_deadline(self) -> None:
        clock = _Clock()
        timeouts = []
        durations = iter((12.0, 8.0, 1.0))

        def opener(request, timeout):
            timeouts.append(timeout)
            clock.value += min(next(durations), timeout)
            return _Response(request.full_url)

        client = HttpClient(
            timeout_seconds=15,
            opener=opener,
            resolver=_resolver,
            sleeper=clock.sleep,
            monotonic=clock.now,
            max_attempts=1,
            min_interval_seconds=0,
        )

        with client.request_budget(20):
            client.request("GET", "https://public.example.test/one")
            client.request("GET", "https://public.example.test/two")
        client.request("GET", "https://public.example.test/after-budget")

        self.assertEqual(len(timeouts), 3)
        self.assertAlmostEqual(timeouts[0], 15.0)
        self.assertAlmostEqual(timeouts[1], 8.0)
        self.assertAlmostEqual(timeouts[2], 15.0)

    def test_source_budget_caps_multi_request_retry_time(self) -> None:
        clock = _Clock()
        timeouts = []

        def opener(_request, timeout):
            timeouts.append(timeout)
            clock.value += timeout
            raise TimeoutError("fixture timeout")

        client = HttpClient(
            timeout_seconds=15,
            opener=opener,
            resolver=_resolver,
            sleeper=clock.sleep,
            monotonic=clock.now,
            max_attempts=3,
            min_interval_seconds=0,
        )

        with client.request_budget(20):
            with self.assertRaises(HttpError):
                client.request("GET", "https://public.example.test/notices")

        self.assertEqual(len(timeouts), 2)
        self.assertAlmostEqual(timeouts[0], 15.0)
        self.assertAlmostEqual(timeouts[1], 4.75)
        self.assertAlmostEqual(clock.value, 20.0)

    def test_retries_429_with_bounded_retry_after(self) -> None:
        attempts = 0
        clock = _Clock()

        def opener(request, timeout):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                headers = Message()
                headers["Retry-After"] = "1"
                raise HTTPError(request.full_url, 429, "rate limited", headers, None)
            return _Response(request.full_url)

        response = HttpClient(
            opener=opener,
            resolver=_resolver,
            sleeper=clock.sleep,
            monotonic=clock.now,
            max_attempts=3,
            min_interval_seconds=0,
        ).request("GET", "https://public.example.test/notices")

        self.assertEqual(response.text, "ok")
        self.assertEqual(attempts, 2)
        self.assertEqual(clock.sleeps, [1.0])

    def test_retries_transient_timeouts_with_bounded_backoff(self) -> None:
        attempts = 0
        clock = _Clock()

        def opener(request, timeout):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise TimeoutError("fixture timeout")
            return _Response(request.full_url)

        response = HttpClient(
            opener=opener,
            resolver=_resolver,
            sleeper=clock.sleep,
            monotonic=clock.now,
            max_attempts=3,
            min_interval_seconds=0,
        ).request("GET", "https://public.example.test/notices")

        self.assertEqual(response.text, "ok")
        self.assertEqual(attempts, 3)
        self.assertEqual(clock.sleeps, [0.25, 0.5])

    def test_spaces_successive_requests_by_the_global_interval(self) -> None:
        clock = _Clock()

        def opener(request, timeout):
            return _Response(request.full_url)

        client = HttpClient(
            opener=opener,
            resolver=_resolver,
            sleeper=clock.sleep,
            monotonic=clock.now,
            max_attempts=1,
            min_interval_seconds=0.5,
        )
        client.request("GET", "https://public.example.test/one")
        client.request("GET", "https://public.example.test/two")

        self.assertEqual(clock.sleeps, [0.5])
