from __future__ import annotations

import json
from pathlib import Path
from unittest import TestCase

from hospital_tender_monitor.http import HttpResponse
from hospital_tender_monitor.sources.binzhou import BinzhouAdapter
from hospital_tender_monitor.sources.dongying import DongyingAdapter
from hospital_tender_monitor.sources.hospital_html import HospitalHtmlAdapter
from hospital_tender_monitor.sources.jining import JiningAdapter
from hospital_tender_monitor.sources.qingdao import QingdaoAdapter
from hospital_tender_monitor.sources.base import parse_published_at
from hospital_tender_monitor.models import NoticeType


FIXTURES = Path(__file__).parent / "fixtures"


class _Http:
    def __init__(self, body: str) -> None:
        self.body = body
        self.calls = []

    def request(self, method: str, url: str, data=None, headers=None) -> HttpResponse:
        self.calls.append((method, url, data, headers))
        return HttpResponse(url=url, status=200, body=self.body.encode("utf-8"), charset="utf-8")


class SourceFixtureTests(TestCase):
    def test_published_date_parser_accepts_common_public_site_spellings(self) -> None:
        self.assertIsNotNone(parse_published_at("2026年8月17日"))
        self.assertIsNotNone(parse_published_at("20260817"))
        self.assertEqual(
            parse_published_at("2026/08/17 12:30").isoformat(),
            "2026-08-17T12:30:00+00:00",
        )

    def test_dongying_categories_deduplicate_the_same_public_notice(self) -> None:
        source = {
            "id": "dongying-ggzy",
            "name": "东营市公共资源交易网",
            "city": "东营",
            "url": "http://ggzy.dongying.gov.cn/",
            "site_guid": "fixture-guid",
            "vname": "/dongying",
        }
        result = DongyingAdapter(source, _Http((FIXTURES / "dongying_search.json").read_text(encoding="utf-8"))).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.notices[0].content_text, result.notices[0].title)

    def test_dongying_accepts_direct_record_envelope(self) -> None:
        source = {
            "id": "dongying-ggzy",
            "name": "东营市公共资源交易网",
            "city": "东营",
            "url": "http://ggzy.dongying.gov.cn/",
            "site_guid": "fixture-guid",
            "vname": "/dongying",
        }
        body = '[{"title":"示例医院信息化采购公告","date":"2026年8月17日","href":"/notices/example-1.html","index":"example-1"}]'
        result = DongyingAdapter(source, _Http(body)).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.notices[0].content_text, result.notices[0].title)

    def test_dongying_customer_source_filters_and_tags_the_hospital(self) -> None:
        source = {
            "id": "dongying-customer",
            "name": "医院公共资源公告",
            "city": "东营区",
            "url": "http://ggzy.dongying.gov.cn/?hospital=%E7%A4%BA%E4%BE%8B%E5%8C%BB%E9%99%A2",
            "site_guid": "fixture-guid",
            "vname": "/dongying",
            "hospital_names": ["示例医院"],
        }
        http = _Http((FIXTURES / "dongying_search.json").read_text(encoding="utf-8"))
        result = DongyingAdapter(source, http).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.notices[0].hospital_names, ("示例医院",))
        self.assertIn(b"Title=%E7%A4%BA%E4%BE%8B%E5%8C%BB%E9%99%A2", http.calls[0][2])

    def test_dongying_customer_source_does_not_attribute_fuzzy_results(self) -> None:
        source = {
            "id": "dongying-customer",
            "name": "医院公共资源公告",
            "city": "东营区",
            "url": "http://ggzy.dongying.gov.cn/",
            "hospital_names": ["示例医院"],
        }
        adapter = DongyingAdapter(source, _Http('[]'))
        self.assertIsNone(adapter._notice(
            {"title": "东营区另一家医院设备采购公告", "date": "2026-09-25", "href": "/notice/1"},
            NoticeType.PROCUREMENT,
            ("示例医院",),
        ))

    def test_binzhou_search_extracts_only_verified_hospital_titles(self) -> None:
        source = {
            "id": "binzhou-boxing",
            "name": "博兴县公共资源交易检索",
            "city": "博兴县",
            "url": "https://jypt.bzggzyjy.cn/bxweb/search/fullsearch.html?wd=%E5%8D%9A%E5%85%B4%E5%8E%BF%E4%BA%BA%E6%B0%91%E5%8C%BB%E9%99%A2&cnum=007",
            "hospital_names": ["博兴县人民医院"],
        }
        body = '{"result":{"totalcount":2,"records":[' \
            '{"title":"山东省滨州市<em>博兴县人民医院</em>设备采购公告","webdate":"2026-09-25 10:00:00","linkurl":"/jyxx/012002/012002002/20260925/example.html"},' \
            '{"title":"博兴县园林绿化工程招标公告","webdate":"2026-09-25 10:00:00","linkurl":"/jyxx/012001/012001001/20260925/other.html"}' \
            ']}}'
        http = _Http(body)
        result = BinzhouAdapter(source, http).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.notices[0].title, "山东省滨州市博兴县人民医院设备采购公告")
        self.assertEqual(result.notices[0].hospital_names, ("博兴县人民医院",))
        self.assertEqual(result.notices[0].url, "https://jypt.bzggzyjy.cn/bxweb/jyxx/012002/012002002/20260925/example.html")
        self.assertEqual(http.calls[0][0], "POST")
        payload = json.loads(http.calls[0][2])
        self.assertEqual(payload["accuracy"], "100")
        self.assertEqual(payload["noParticiple"], "1")

    def test_jining_categories_deduplicate_the_same_public_notice(self) -> None:
        source = {
            "id": "jining-ggzy",
            "name": "济宁市公共资源交易公共服务平台",
            "city": "济宁",
            "url": "https://www.jnsggzy.cn/",
            "tenant": "JiNing",
            "categories": ["536", "503000", "55100101", "551003"],
        }
        result = JiningAdapter(source, _Http((FIXTURES / "jining_newest.json").read_text(encoding="utf-8"))).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 1)
        self.assertEqual(result.notices[0].content_text, result.notices[0].title)

    def test_qingdao_notice_exports_nonempty_normalized_content(self) -> None:
        source = {
            "id": "qingdao-ggzy",
            "name": "Qingdao public fixture",
            "city": "Qingdao",
            "url": "https://example.com/",
        }
        adapter = QingdaoAdapter(source, _Http(""))
        notice = adapter._notice(
            (
                "Synthetic hospital IT procurement",
                "/TradeDetals-ZtbShow/item-project-1-0-area/detail.html",
                "2026-08-17",
            ),
            NoticeType.PROCUREMENT,
            "0",
        )
        self.assertIsNotNone(notice)
        self.assertEqual(notice.content_text, notice.title)

    def test_qingdao_customer_source_only_returns_exact_hospital_title_hits(self) -> None:
        source = {
            "id": "qingdao-hospital",
            "name": "青岛公共资源公告",
            "city": "胶州",
            "url": "https://ggzy.qingdao.gov.cn/?region=jiaozhou",
            "hospital_names": ["胶州市中医院"],
        }
        adapter = QingdaoAdapter(source, _Http(""))
        self.assertIsNone(adapter._notice(
            ("胶州市某医院采购项目", "/TradeDetals-ZtbShow/163678-5021-1-0-0/example.html", "2026-08-17"),
            NoticeType.PROCUREMENT,
            "0",
        ))

    def test_hospital_list_fixtures_extract_only_dated_procurement_rows(self) -> None:
        cases = (
            ("hospital_dongying_fifth.html", "https://www.dysdwrmyy.cn/29/", ("东营市第五人民医院",)),
            ("hospital_jining_first.html", "https://www.jnrmyy.com/gonggao/zbgg/", ("济宁市第一人民医院",)),
            ("hospital_jining_tcm.html", "https://www.jnszyy.com/list.php?class=2", ("济宁市中医院",)),
        )
        for fixture, url, names in cases:
            with self.subTest(fixture=fixture):
                source = {
                    "id": fixture.removesuffix(".html"),
                    "name": names[0],
                    "city": "东营" if "dongying" in fixture else "济宁",
                    "url": url,
                    "hospital_names": list(names),
                }
                result = HospitalHtmlAdapter(
                    source,
                    _Http((FIXTURES / fixture).read_text(encoding="utf-8")),
                ).fetch()
                self.assertTrue(result.success)
                self.assertEqual(len(result.notices), 1)
                self.assertEqual(result.notices[0].hospital_names, names)

    def test_hospital_list_adapter_accepts_chinese_and_dotted_dates(self) -> None:
        for date_text in ("2026年9月25日", "2026.09.25", "20260925"):
            with self.subTest(date_text=date_text):
                source = {
                    "id": "customer-hospital",
                    "name": "客户医院公告",
                    "city": "济宁",
                    "url": "https://hospital.example.test/notices",
                    "hospital_names": ["示例医院"],
                }
                body = f"<ul><li><a href='/notice-1'>信息化设备采购公告</a>{date_text}</li></ul>"
                result = HospitalHtmlAdapter(source, _Http(body)).fetch()
                self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 1)

    def test_public_resource_html_search_only_attributes_exact_hospital_hits(self) -> None:
        html = (
            "<ul>"
            "<li><a href='/notice-1'>示例医院医疗设备采购公告</a>2026年9月25日</li>"
            "<li><a href='/notice-2'>另一医院办公设备采购公告</a>2026年9月25日</li>"
            "</ul>"
        )
        source = {
            "id": "county-platform-search",
            "name": "县公共资源交易平台检索",
            "city": "嘉祥县",
            "url": "https://trade.example.test/jiaxiang?filter=%E7%A4%BA%E4%BE%8B%E5%8C%BB%E9%99%A2",
            "hospital_names": ["示例医院", "医院"],
            "title_match_required": True,
        }
        result = HospitalHtmlAdapter(source, _Http(html)).fetch()
        self.assertTrue(result.success)
        self.assertEqual(
            tuple(notice.title for notice in result.notices),
            ("示例医院医疗设备采购公告",),
        )
        self.assertEqual(result.notices[0].hospital_names, ("示例医院",))
