from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase
from urllib.parse import parse_qs, quote, urlsplit

from hospital_tender_monitor.http import HttpResponse
from hospital_tender_monitor.sources.binzhou import BinzhouAdapter
from hospital_tender_monitor.sources.dongying import DongyingAdapter
from hospital_tender_monitor.sources.hospital_html import HospitalHtmlAdapter
from hospital_tender_monitor.sources.jining import JiningAdapter
from hospital_tender_monitor.sources.qingdao import QingdaoAdapter
from hospital_tender_monitor.sources.base import page_reaches_cutoff, parse_published_at
from hospital_tender_monitor.models import NoticeType


FIXTURES = Path(__file__).parent / "fixtures"


class _Http:
    def __init__(self, body: str) -> None:
        self.body = body
        self.calls = []

    def request(self, method: str, url: str, data=None, headers=None) -> HttpResponse:
        self.calls.append((method, url, data, headers))
        return HttpResponse(url=url, status=200, body=self.body.encode("utf-8"), charset="utf-8")


class _RouteHttp:
    def __init__(self, respond) -> None:
        self.respond = respond
        self.calls = []

    def request(self, method: str, url: str, data=None, headers=None) -> HttpResponse:
        self.calls.append((method, url, data, headers))
        body = self.respond(method, url, data, headers)
        return HttpResponse(url=url, status=200, body=body.encode("utf-8"), charset="utf-8")


FIXTURE_NOW = datetime(2026, 8, 18, tzinfo=timezone.utc)
SCAN_NOW = datetime(2026, 9, 28, 12, tzinfo=timezone.utc)


class SourceFixtureTests(TestCase):
    def test_lookback_page_cutoff_requires_every_row_to_be_old(self) -> None:
        cutoff = datetime(2026, 9, 14, tzinfo=timezone.utc)
        self.assertFalse(page_reaches_cutoff([
            datetime(2026, 9, 10, tzinfo=timezone.utc),
            datetime(2026, 9, 25, tzinfo=timezone.utc),
        ], cutoff))
        self.assertTrue(page_reaches_cutoff([
            datetime(2026, 9, 10, tzinfo=timezone.utc),
            datetime(2026, 9, 12, tzinfo=timezone.utc),
        ], cutoff))

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
        result = DongyingAdapter(
            source,
            _Http((FIXTURES / "dongying_search.json").read_text(encoding="utf-8")),
            clock=lambda: FIXTURE_NOW,
        ).fetch()
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
        result = DongyingAdapter(source, _Http(body), clock=lambda: FIXTURE_NOW).fetch()
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
        result = DongyingAdapter(source, http, clock=lambda: FIXTURE_NOW).fetch()
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

    def test_dongying_uses_zero_based_pages_and_stops_after_old_overlap_page(self) -> None:
        source = {
            "id": "dongying-customer",
            "name": "医院公共资源公告",
            "city": "东营",
            "url": "http://ggzy.dongying.gov.cn/jyxx/005001/005001002/about.html",
            "site_guid": "fixture-guid",
            "vname": "/dongying",
            "hospital_names": ["示例医院"],
        }

        def respond(_method, _url, data, _headers):
            query = parse_qs(data.decode("ascii"))
            if query["CatgoryNum"] != ["005001002"]:
                return '{"data":"{\\"data\\":[],\\"totalcount\\":0}"}'
            if query["pageIndex"] == ["0"]:
                records = [
                    {
                        "title": f"示例医院信息化采购公告 {index}",
                        "date": "2026-09-25",
                        "href": f"/notices/dy-{index}.html",
                        "index": f"dy-{index}",
                    }
                    for index in range(20)
                ]
            else:
                records = [
                    {
                        "title": f"示例医院旧公告 {index}",
                        "date": "2026-09-10",
                        "href": f"/notices/dy-old-{index}.html",
                        "index": f"dy-old-{index}",
                    }
                    for index in range(20)
                ]
            return json.dumps({"data": json.dumps({"data": records, "totalcount": 40})})

        http = _RouteHttp(respond)
        result = DongyingAdapter(source, http, clock=lambda: SCAN_NOW).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 20)
        category_calls = [
            parse_qs(call[2].decode("ascii"))
            for call in http.calls
            if parse_qs(call[2].decode("ascii"))["CatgoryNum"] == ["005001002"]
        ]
        self.assertEqual([call["pageIndex"][0] for call in category_calls], ["0", "1"])
        self.assertTrue(all(call["Title"] == ["示例医院"] for call in category_calls))

    def test_dongying_searches_every_configured_hospital_alias(self) -> None:
        source = {
            "id": "dongying-customer",
            "name": "医院公共资源公告",
            "city": "东营",
            "url": "http://ggzy.dongying.gov.cn/",
            "site_guid": "fixture-guid",
            "vname": "/dongying",
            "hospital_names": ["东营市人民医院", "东营人民医院"],
        }
        http = _RouteHttp(lambda *_: '{"data":"{\\"data\\":[],\\"totalcount\\":0}"}')
        result = DongyingAdapter(source, http, clock=lambda: SCAN_NOW).fetch()
        self.assertTrue(result.success)
        first_category_titles = [
            parse_qs(call[2].decode("ascii"))["Title"][0]
            for call in http.calls
            if parse_qs(call[2].decode("ascii"))["CatgoryNum"] == ["005001001"]
        ]
        self.assertEqual(first_category_titles, ["东营市人民医院", "东营人民医院"])

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

    def test_binzhou_list_url_without_wd_searches_configured_hospital_names_and_aliases(self) -> None:
        source = {
            "id": "binzhou-people",
            "name": "滨州市人民医院公共资源公告",
            "city": "滨州",
            "url": "https://jypt.bzggzyjy.cn/bzweb/jyxx/012002/012002004/list1.html",
            "hospital_names": ["滨州市人民医院", "滨州人民医院"],
        }
        body = json.dumps({"result": {
            "totalcount": 2,
            "records": [
                {"title": "滨州市人民医院设备采购公告", "webdate": "2026-09-25", "linkurl": "/notice/people.html"},
                {"title": "滨州人民医院信息系统采购公告", "webdate": "2026-09-25", "linkurl": "/notice/alias.html"},
            ],
        }})
        http = _Http(body)
        result = BinzhouAdapter(source, http, clock=lambda: SCAN_NOW).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 2)
        self.assertEqual(
            [json.loads(call[2])["wd"] for call in http.calls],
            [quote("滨州市人民医院"), quote("滨州人民医院")],
        )

    def test_binzhou_paginates_offsets_and_excludes_rows_beyond_overlap(self) -> None:
        source = {
            "id": "binzhou-people",
            "name": "滨州市人民医院公共资源公告",
            "city": "滨州",
            "url": "https://jypt.bzggzyjy.cn/bzweb/jyxx/012002/012002004/list1.html",
            "hospital_names": ["滨州市人民医院"],
        }

        def respond(_method, _url, data, _headers):
            payload = json.loads(data)
            date = "2026-09-25" if payload["pn"] == 0 else "2026-09-10"
            records = [
                {
                    "title": f"滨州市人民医院采购公告 {payload['pn'] + index}",
                    "webdate": date,
                    "linkurl": f"/notice/bz-{payload['pn'] + index}.html",
                }
                for index in range(50)
            ]
            return json.dumps({"result": {"totalcount": 100, "records": records}})

        http = _RouteHttp(respond)
        result = BinzhouAdapter(source, http, clock=lambda: SCAN_NOW).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 50)
        self.assertEqual([json.loads(call[2])["pn"] for call in http.calls], [0, 50])

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

    def test_jining_filters_hospital_and_reads_four_categories_with_one_based_pages(self) -> None:
        categories = ["55100101", "55200101", "553001", "57100101"]
        source = {
            "id": "jining-hospital",
            "name": "济宁市第一人民医院公共资源公告",
            "city": "济宁",
            "url": "https://www.jnsggzy.cn/JiNing/Posts?cat=55100101&filter=济宁市第一人民医院",
            "tenant": "JiNing",
            "categories": categories,
            "hospital_names": ["济宁市第一人民医院"],
        }

        def respond(_method, url, _data, _headers):
            query = parse_qs(urlsplit(url).query)
            category = query["cat"][0]
            page = query.get("pn", ["1"])[0]
            date = "2026-09-25" if page == "1" else "2026-09-10"
            rows = []
            for index in range(20):
                title = "其他医院办公采购" if index == 0 else f"济宁市第一人民医院采购公告 {index}"
                rows.append(
                    f'<li class="list-group-item"><span class="time">{date}</span>'
                    f'<a href="/JiNing/Posts/Detail?id={category}-{page}-{index}">'
                    f'<span class="badge">{index + 1}</span>{title}</a></li>'
                )
            return "<ul>" + "".join(rows) + "</ul>"

        http = _RouteHttp(respond)
        result = JiningAdapter(source, http, clock=lambda: SCAN_NOW).fetch()
        self.assertTrue(result.success)
        self.assertEqual(len(result.notices), 4 * 19)
        self.assertEqual({notice.notice_type for notice in result.notices}, {
            NoticeType.PROCUREMENT,
            NoticeType.CHANGE,
            NoticeType.RESULT,
            NoticeType.TERMINATED,
        })
        queries = [parse_qs(urlsplit(call[1]).query) for call in http.calls]
        self.assertEqual({query["cat"][0] for query in queries}, set(categories))
        self.assertEqual(
            {query.get("pn", ["1"])[0] for query in queries},
            {"1", "2"},
        )
        self.assertTrue(all(query["filter"] == ["济宁市第一人民医院"] for query in queries))

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
