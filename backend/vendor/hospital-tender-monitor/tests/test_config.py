from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from hospital_tender_monitor.config import load_config


class ConfigGateTests(TestCase):
    def _write_config(self, root: Path, sources: list[dict[str, object]]) -> None:
        config = root / "config"
        config.mkdir(exist_ok=True)
        (config / "sources.json").write_text(json.dumps({"sources": sources}), encoding="utf-8")
        (config / "keywords.json").write_text(json.dumps({
            "strong": ["HIS"],
            "context": ["医院"],
            "noise": [],
            "weights": {
                "strong": 1,
                "context": 1,
                "noise": 1,
                "title_information_department_override": 1,
            },
            "thresholds": {"high": 2, "possible": 1, "irrelevant": 0},
        }), encoding="utf-8")
        (config / "customer_hospitals.json").write_text(json.dumps({"hospitals": []}), encoding="utf-8")

    def test_source_identity_and_enabled_fields_are_release_checked(self) -> None:
        with TemporaryDirectory(prefix="hospital-tender-config-") as raw_root:
            root = Path(raw_root)
            source = {
                "id": "public-source",
                "name": "公开来源",
                "adapter": "hospital_html",
                "url": "https://public.example.test/notices",
                "hospital_names": ["示例医院"],
            }
            self._write_config(root, [source])
            config = load_config({}, root)
            self.assertEqual(config.sources[0]["id"], "public-source")
            for invalid in (
                [{**source, "enabled": "true"}],
                [source, {**source, "id": "public-source"}],
                [{**source, "hospital_names": []}],
            ):
                with self.subTest(invalid=invalid):
                    self._write_config(root, invalid)
                    with self.assertRaises(ValueError):
                        load_config({}, root)

    def test_retired_notification_environment_is_ignored(self) -> None:
        with TemporaryDirectory(prefix="hospital-tender-config-") as raw_root:
            root = Path(raw_root)
            source = {
                "id": "public-source",
                "name": "公开来源",
                "adapter": "hospital_html",
                "url": "https://public.example.test/notices",
                "hospital_names": ["示例医院"],
            }
            self._write_config(root, [source])
            retired_value = "-".join(("retired", "notification", "value"))
            config = load_config({
                "PUSHPLUS_TOKEN": retired_value,
                "HOSPITAL_TENDER_MONITOR_DISABLE_NOTIFICATIONS": "not-a-boolean",
            }, root)
            self.assertFalse(hasattr(config, "pushplus_token"))
            self.assertNotIn(retired_value, repr(config))

    def test_customer_announcement_urls_become_direct_collector_sources(self) -> None:
        with TemporaryDirectory(prefix="hospital-tender-customer-sources-") as raw_root:
            root = Path(raw_root)
            self._write_config(root, [])
            registry_path = root / "config" / "customer_hospitals.json"
            registry_path.write_text(json.dumps({"hospitals": [
                {
                    "id": "hospital-a", "name": "示例医院甲", "city": "济宁", "region": "嘉祥县",
                    "status": "direct", "source_ids": [], "aliases": ["甲医院"],
                    "announcement_sources": [
                        {"id": "official-a", "type": "hospital_official", "label": "医院官网", "url": "https://hospital-a.example.test/notices"},
                        {"id": "platform-a", "type": "public_resource", "label": "嘉祥县平台", "url": "https://trade.example.test/jiaxiang"},
                    ],
                },
                {
                    "id": "hospital-b", "name": "示例医院乙", "city": "济宁", "region": "嘉祥县",
                    "status": "direct", "source_ids": [], "aliases": [],
                    "announcement_sources": [
                        {"id": "platform-b", "type": "public_resource", "label": "嘉祥县平台", "url": "https://trade.example.test/jiaxiang"},
                    ],
                },
            ]}), encoding="utf-8")

            config = load_config({}, root)

            self.assertEqual(len(config.sources), 2)
            shared_platform = next(source for source in config.sources if source["url"].endswith("/jiaxiang"))
            self.assertEqual(shared_platform["adapter"], "hospital_html")
            self.assertEqual(shared_platform["coverage"], "direct")
            self.assertEqual(set(shared_platform["hospital_names"]), {"示例医院甲", "甲医院", "示例医院乙"})

    def test_customer_announcement_sources_reject_private_or_unknown_urls(self) -> None:
        with TemporaryDirectory(prefix="hospital-tender-customer-source-invalid-") as raw_root:
            root = Path(raw_root)
            self._write_config(root, [])
            registry_path = root / "config" / "customer_hospitals.json"
            hospital = {
                "id": "hospital-a", "name": "示例医院", "city": "济宁", "region": "济宁",
                "status": "direct", "source_ids": [], "aliases": [],
                "announcement_sources": [
                    {"type": "hospital_official", "url": "http://127.0.0.1/notices"},
                ],
            }
            registry_path.write_text(json.dumps({"hospitals": [hospital]}), encoding="utf-8")

            with self.assertRaises(ValueError):
                load_config({}, root)

    def test_customer_sources_reject_duplicate_urls_even_with_different_types(self) -> None:
        with TemporaryDirectory(prefix="hospital-tender-customer-source-duplicate-") as raw_root:
            root = Path(raw_root)
            self._write_config(root, [])
            registry_path = root / "config" / "customer_hospitals.json"
            hospital = {
                "id": "hospital-a", "name": "示例医院", "city": "济宁", "region": "济宁",
                "status": "direct", "source_ids": [], "aliases": [],
                "announcement_sources": [
                    {"type": "hospital_official", "url": "https://example.test/notices"},
                    {"type": "public_resource", "url": "https://example.test/notices"},
                ],
            }
            registry_path.write_text(json.dumps({"hospitals": [hospital]}), encoding="utf-8")

            with self.assertRaises(ValueError):
                load_config({}, root)
