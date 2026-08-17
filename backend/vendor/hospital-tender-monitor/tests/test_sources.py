from __future__ import annotations

from pathlib import Path
from unittest import TestCase

from hospital_tender_monitor.http import HttpResponse
from hospital_tender_monitor.sources.dongying import DongyingAdapter
from hospital_tender_monitor.sources.hospital_html import HospitalHtmlAdapter
from hospital_tender_monitor.sources.jining import JiningAdapter
from hospital_tender_monitor.sources.base import parse_published_at


FIXTURES = Path(__file__).parent / "fixtures"


class _Http:
    def __init__(self, body: str) -> None:
        self.body = body
        self.calls = []

    def request(self, method: str, url: str, data=None, headers=None) -> HttpResponse:
        self.calls.append((method, url))
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
