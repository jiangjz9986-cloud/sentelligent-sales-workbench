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
            config = load_config({"HOSPITAL_TENDER_MONITOR_DISABLE_NOTIFICATIONS": "1"}, root)
            self.assertEqual(config.sources[0]["id"], "public-source")
            for invalid in (
                [{**source, "enabled": "true"}],
                [source, {**source, "id": "public-source"}],
                [{**source, "hospital_names": []}],
            ):
                with self.subTest(invalid=invalid):
                    self._write_config(root, invalid)
                    with self.assertRaises(ValueError):
                        load_config({"HOSPITAL_TENDER_MONITOR_DISABLE_NOTIFICATIONS": "1"}, root)
