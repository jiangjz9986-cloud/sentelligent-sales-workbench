from __future__ import annotations

from datetime import datetime, timezone
import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from hospital_tender_monitor.http import HttpError, HttpResponse
from hospital_tender_monitor.sources.binzhou import BinzhouAdapter
from hospital_tender_monitor.sources.dongying import DongyingAdapter
from hospital_tender_monitor.sources.hospital_html import HospitalHtmlAdapter
from hospital_tender_monitor.sources.jiaozhou_central_hospital import JiaozhouCentralHospitalAdapter
from hospital_tender_monitor.sources.jining import JiningAdapter
from hospital_tender_monitor.sources.qingdao import QingdaoAdapter


NOW = datetime(2026, 10, 24, tzinfo=timezone.utc)
NAME = "Example Hospital"


class Http:
    def __init__(self, respond):
        self.respond = respond
        self.calls = []

    def request(self, method, url, data=None, headers=None):
        self.calls.append((method, url, data))
        return HttpResponse(url, 200, self.respond(method, url, data).encode())


def asp_page(page, next_page=None):
    pager = (
        f'<div id="AspNetPager1"><a href="javascript:__doPostBack(\'AspNetPager1\',\'{next_page}\')">下一页</a></div>'
        if next_page else ""
    )
    return (f'<input type="hidden" name="__VIEWSTATE" value="private-form-state-{page}">'
            f'<ul class="textlist"><li><a href="/Info/Open/Content1.aspx?Id={page}">HIS procurement</a>'
            f'<span>2026-10-24</span></li></ul>{pager}')


def qingdao_page(page, next_page=None):
    pager = f'<div class="pages"><a href="?pageIndex={next_page}">下一页</a></div>' if next_page else ""
    return (f'<table><tr><td><a href="/TradeDetals-ZtbShow/{page}-a-1-0-b/test">HIS procurement</a>'
            f'</td><td>2026-10-24</td></tr></table>{pager}')


class AdapterRecoveryTests(TestCase):
    def test_jining_unfiltered_keeps_earlier_feed_and_resumes_category(self):
        source = {"id": "jining", "url": "https://example.test", "tenant": "fixture",
                  "categories": ["55100101", "553001"]}

        def respond(_method, url, _data):
            if "/553001/" in url:
                raise TimeoutError("timeout")
            return json.dumps([{"title": "HIS procurement", "date": "2026-10-24", "url": "first"}])

        result = JiningAdapter(source, Http(respond)).fetch()
        self.assertFalse(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.cursor["categoryIndex"], 1)
        resumed_http = Http(lambda *_: "[]")
        resumed = JiningAdapter(source, resumed_http)
        resumed.set_resume_cursor(result.cursor)
        self.assertTrue(resumed.fetch().success)
        self.assertEqual(len(resumed_http.calls), 1)
        self.assertIn("/553001/", resumed_http.calls[0][1])

    def test_dongying_keeps_earlier_category_and_resumes(self):
        source = {"id": "dongying", "url": "https://example.test"}

        def respond(_method, _url, data):
            if parse_qs(data.decode())["CatgoryNum"] != ["005001001"]:
                raise HttpError("timeout")
            return json.dumps([{"title": "HIS procurement", "date": "2026-10-24", "href": "/notice/1"}])

        result = DongyingAdapter(source, Http(respond), clock=lambda: NOW).fetch()
        self.assertFalse(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.cursor, {"categoryIndex": 1, "hospitalIndex": 0, "page": 0})
        resumed_http = Http(lambda *_: "[]")
        resumed = DongyingAdapter(source, resumed_http, clock=lambda: NOW)
        resumed.set_resume_cursor(result.cursor)
        self.assertTrue(resumed.fetch().success)
        self.assertEqual(parse_qs(resumed_http.calls[0][2].decode())["CatgoryNum"], ["005001002"])

    def test_binzhou_keeps_page_before_timeout_and_resumes_offset(self):
        source = {"id": "binzhou", "url": "https://jypt.bzggzyjy.cn/bzweb/search/fullsearch.html",
                  "hospital_names": [NAME]}

        def respond(_method, _url, data):
            if json.loads(data)["pn"] > 0:
                raise HttpError("timeout")
            return json.dumps({"result": {"totalcount": 51, "records": [
                {"title": f"{NAME} HIS procurement {i}", "webdate": "2026-10-24", "linkurl": f"/notices/{i}"}
                for i in range(50)
            ]}})

        result = BinzhouAdapter(source, Http(respond), clock=lambda: NOW).fetch()
        self.assertFalse(result.success)
        self.assertEqual(len(result.notices), 50)
        self.assertEqual(result.cursor["page"], 1)
        resumed_http = Http(lambda *_: '{"result":{"records":[],"totalcount":0}}')
        resumed = BinzhouAdapter(source, resumed_http, clock=lambda: NOW)
        resumed.set_resume_cursor(result.cursor)
        self.assertTrue(resumed.fetch().success)
        self.assertEqual(json.loads(resumed_http.calls[0][2])["pn"], 50)

    def test_qingdao_keeps_first_page_and_resumes_directly_at_failed_page(self):
        source = {"id": "qingdao", "url": "https://example.test", "area_codes": ["0214"]}

        def respond(_method, url, _data):
            if parse_qs(urlsplit(url).query)["pageIndex"] == ["2"]:
                raise HttpError("timeout")
            return qingdao_page(1, 2)

        result = QingdaoAdapter(source, Http(respond)).fetch()
        self.assertFalse(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.cursor, {"categoryIndex": 0, "hospitalIndex": 0, "page": 2})
        resumed_http = Http(lambda _m, url, _d: qingdao_page(2) if "/1-1-0?" in url else "<table></table>")
        resumed = QingdaoAdapter(source, resumed_http)
        resumed.set_resume_cursor(result.cursor)
        self.assertTrue(resumed.fetch().success)
        self.assertEqual(parse_qs(urlsplit(resumed_http.calls[0][1]).query)["pageIndex"], ["2"])

    def test_qingdao_page_limit_is_partial_and_preserves_next_page(self):
        source = {"id": "qingdao", "url": "https://example.test", "area_codes": ["0214"], "max_pages": 1}
        result = QingdaoAdapter(source, Http(lambda *_: qingdao_page(1, 2))).fetch()
        self.assertFalse(result.success)
        self.assertTrue(result.partial)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.cursor["page"], 2)

    def test_aspnet_keeps_first_page_and_refetches_form_state_on_resume(self):
        source = {"id": "aspnet", "url": "https://example.test/List.aspx", "hospital_names": [NAME]}

        def respond(method, _url, _data):
            if method == "POST":
                raise HttpError("timeout")
            return asp_page(1, 2)

        result = JiaozhouCentralHospitalAdapter(source, Http(respond)).fetch()
        self.assertFalse(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.cursor, {"page": 2})
        self.assertNotIn("private-form-state", json.dumps(result.cursor))
        resumed_http = Http(lambda method, *_: asp_page(1, 2) if method == "GET" else asp_page(2))
        resumed = JiaozhouCentralHospitalAdapter(source, resumed_http)
        resumed.set_resume_cursor(result.cursor)
        finished = resumed.fetch()
        self.assertTrue(finished.success)
        self.assertEqual([call[0] for call in resumed_http.calls], ["GET", "POST"])
        payload = parse_qs(resumed_http.calls[1][2].decode())
        self.assertEqual(payload["__EVENTARGUMENT"], ["2"])
        self.assertEqual(payload["__VIEWSTATE"], ["private-form-state-1"])
        self.assertTrue(finished.notices[0].url.endswith("Id=2"))

    def test_hospital_html_keeps_valid_rows_when_later_row_iteration_fails(self):
        def records():
            yield ("HIS procurement", "/notice/1", "2026-10-24")
            raise ValueError("broken later row")

        parser = SimpleNamespace(records=records(), feed=lambda *_: None, close=lambda: None)
        source = {"id": "hospital", "url": "https://example.test", "title_terms": ["HIS"]}
        result = HospitalHtmlAdapter(source, Http(lambda *_: ""), parser_factory=lambda: parser).fetch()
        self.assertFalse(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertTrue(result.partial)
