from __future__ import annotations

import socket
from email.message import Message
from io import BytesIO
from unittest import TestCase
from urllib.error import HTTPError

from hospital_tender_monitor.http import HttpClient


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
