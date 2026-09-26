"""Configuration loading with secret-safe display and offline URL validation."""

from __future__ import annotations

import hashlib
import ipaddress
import json
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping
from urllib.parse import urlsplit


def _freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def _is_blocked_ip(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return (
        address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or address.is_private
    )


def _is_noncanonical_numeric_ipv4(host: str) -> bool:
    """Identify legacy IPv4 spellings without using a resolver."""
    parts = host.split(".")
    if not 1 <= len(parts) <= 4 or any(not part for part in parts):
        return False

    values: list[int] = []
    for part in parts:
        base = 10
        digits = part
        if part.lower().startswith("0x"):
            base = 16
            digits = part[2:]
        elif len(part) > 1 and part.startswith("0"):
            base = 8
            digits = part[1:]
        if not digits:
            return False
        try:
            values.append(int(digits, base))
        except ValueError:
            return False

    limits = {
        1: (0xFFFFFFFF,),
        2: (0xFF, 0xFFFFFF),
        3: (0xFF, 0xFF, 0xFFFF),
        4: (0xFF, 0xFF, 0xFF, 0xFF),
    }[len(values)]
    if any(value > limit for value, limit in zip(values, limits)):
        return False
    address = values[0]
    for index, value in enumerate(values[1:], start=1):
        address = (address << (8 if index < len(values) - 1 else 32 - 8 * index)) | value
    try:
        return host != str(ipaddress.IPv4Address(address))
    except ipaddress.AddressValueError:
        return False


def validate_public_url(url: str) -> str:
    """Validate a source URL solely from its syntax; this never resolves DNS."""
    if not isinstance(url, str) or not url.strip():
        raise ValueError("source URL must be a non-empty string")
    candidate = url.strip()
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError as exc:
        raise ValueError("source URL is malformed") from exc
    if parts.scheme.lower() not in {"http", "https"}:
        raise ValueError("source URL must use http or https")
    if not parts.hostname or parts.username or parts.password or port is not None and not 0 < port < 65536:
        raise ValueError("source URL is malformed")
    host = parts.hostname.rstrip(".").lower()
    if (
        host == "localhost"
        or host.endswith(".localhost")
        or _is_blocked_ip(host)
        or _is_noncanonical_numeric_ipv4(host)
    ):
        raise ValueError("source URL has an unsafe destination")
    return candidate


def _read_json(path: Path, expected_key: str) -> Any:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"missing configuration file: {path.name}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path.name}") from exc
    if not isinstance(value, dict) or expected_key not in value:
        raise ValueError(f"invalid {path.name} structure")
    return value[expected_key]


def _read_optional_json(path: Path, expected_key: str) -> Any:
    """Read an optional registry file while retaining strict JSON validation."""
    if not path.exists():
        return []
    return _read_json(path, expected_key)


def _load_customer_hospitals(path: Path) -> tuple[Mapping[str, Any], ...]:
    raw = _read_optional_json(path, "hospitals")
    if not isinstance(raw, list):
        raise ValueError("customer_hospitals.json hospitals must be a list")
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    result: list[Mapping[str, Any]] = []
    allowed_statuses = {"direct", "indirect", "pending"}
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("each customer hospital must be an object")
        required = ("id", "name", "city", "region", "status", "source_ids", "aliases")
        if any(not isinstance(item.get(key), str) or not item[key].strip() for key in required[:5]):
            raise ValueError("customer hospital identity fields are required")
        target_id = item["id"].strip()
        name = item["name"].strip()
        status = item["status"].strip().casefold()
        if target_id in seen_ids or name in seen_names:
            raise ValueError("customer hospital ids and names must be unique")
        if status not in allowed_statuses:
            raise ValueError("customer hospital status is invalid")
        aliases = item.get("aliases")
        hospital_aliases = item.get("hospital_aliases", aliases)
        source_ids = item.get("source_ids")
        if (
            not isinstance(aliases, list)
            or any(not isinstance(value, str) or not value.strip() for value in aliases)
            or len({value.strip().casefold() for value in aliases}) != len(aliases)
        ):
            raise ValueError("customer hospital aliases must be unique strings")
        if (
            not isinstance(hospital_aliases, list)
            or any(not isinstance(value, str) or not value.strip() for value in hospital_aliases)
            or len({value.strip().casefold() for value in hospital_aliases}) != len(hospital_aliases)
        ):
            raise ValueError("customer hospital name aliases must be unique strings")
        if (
            not isinstance(source_ids, list)
            or any(not isinstance(value, str) or not value.strip() for value in source_ids)
            or len({value.strip() for value in source_ids}) != len(source_ids)
        ):
            raise ValueError("customer hospital source_ids must be unique strings")
        announcement_sources = item.get("announcement_sources", [])
        if not isinstance(announcement_sources, list) or len(announcement_sources) > 20:
            raise ValueError("customer announcement sources must be a bounded list")
        normalized_sources: list[dict[str, str]] = []
        seen_source_urls: set[str] = set()
        for source in announcement_sources:
            if not isinstance(source, dict):
                raise ValueError("customer announcement source must be an object")
            source_type = source.get("type")
            if not isinstance(source_type, str) or source_type not in {"hospital_official", "public_resource"}:
                raise ValueError("customer announcement source type is invalid")
            url = validate_public_url(source.get("url"))
            label = source.get("label", "")
            source_id = source.get("id", "")
            if (
                not isinstance(label, str)
                or len(label) > 100
                or not isinstance(source_id, str)
                or len(source_id) > 120
            ):
                raise ValueError("customer announcement source metadata is invalid")
            if url in seen_source_urls:
                raise ValueError("customer announcement sources must be unique")
            seen_source_urls.add(url)
            normalized_sources.append({
                "id": source_id,
                "type": source_type,
                "label": label.strip(),
                "url": url,
            })
        normalized = dict(item)
        normalized.update(
            {
                "id": target_id,
                "name": name,
                "city": item["city"].strip(),
                "region": item["region"].strip(),
                "status": status,
                "aliases": [value.strip() for value in aliases],
                "hospital_aliases": [value.strip() for value in hospital_aliases],
                "source_ids": [value.strip() for value in source_ids],
                "announcement_sources": normalized_sources,
            }
        )
        seen_ids.add(target_id)
        seen_names.add(name)
        result.append(_freeze(normalized))
    return tuple(result)


def _customer_sources(sources: list[Mapping[str, Any]], hospitals: tuple[Mapping[str, Any], ...]) -> list[Mapping[str, Any]]:
    output = [dict(source) for source in sources]
    platform_sources = {
        str(source.get("url", "")).split("/", 3)[2].casefold(): source
        for source in output
        if isinstance(source.get("url"), str) and "://" in str(source.get("url"))
    }
    configured: dict[str, dict[str, Any]] = {}
    for hospital in hospitals:
        name = str(hospital.get("name", "")).strip()
        if not name:
            continue
        city = str(hospital.get("city", "")).strip()
        names = [name, *(hospital.get("hospital_aliases", hospital.get("aliases", ())) or ())]
        for source in hospital.get("announcement_sources", ()):
            key = str(source["url"])
            host = urlsplit(key).hostname or ""
            source_type = str(source.get("type", ""))
            if source_type == "hospital_official":
                adapter = "hospital_html"
            elif host.casefold() == "ggzy.dongying.gov.cn":
                adapter = "dongying"
            elif host.casefold() == "jypt.bzggzyjy.cn":
                adapter = "binzhou"
            elif host.casefold() == "ggzy.qingdao.gov.cn":
                adapter = "qingdao"
            else:
                adapter = "hospital_html"

            # City-specific adapters need their source-specific configuration
            # when the matching URL is one of the built-in regional sources.
            inherited = platform_sources.get(host.casefold(), {})
            row = configured.get(key)
            if row is None:
                digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
                row = {
                    "id": f"customer-url-{digest}",
                    "name": source["label"] or f"{name}公告页",
                    "city": city,
                    "adapter": adapter,
                    "url": key,
                    "enabled": True,
                    "coverage": "direct" if source_type == "hospital_official" else "indirect",
                    "hospital_names": [],
                }
                if adapter == "hospital_html" and source_type == "public_resource":
                    row["title_match_required"] = True
                for field in ("site_guid", "vname", "categories"):
                    if field in inherited:
                        row[field] = inherited[field]
                if adapter == "qingdao":
                    row["area_codes"] = []
                configured[key] = row
            for hospital_name in names:
                if isinstance(hospital_name, str):
                    value = hospital_name.strip()
                    if value and value not in row["hospital_names"]:
                        row["hospital_names"].append(value[:200])
            if adapter == "qingdao":
                region = str(hospital.get("region", "")).casefold()
                area_code = "0214" if "黄岛" in region else "0209" if "胶州" in region else ""
                if area_code and area_code not in row["area_codes"]:
                    row["area_codes"].append(area_code)
    output.extend(configured.values())
    return output


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < 1:
        raise ValueError(f"{name} must be positive")
    return value


def _boolean(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name, str(default)).strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _source_text(source: Mapping[str, Any], key: str, *, required: bool = True) -> str:
    value = source.get(key, "")
    if not isinstance(value, str):
        raise ValueError(f"source {key} must be a string")
    normalized = value.strip()
    if required and not normalized:
        raise ValueError(f"source {key} is required")
    if len(normalized) > 300 or any(ord(char) < 0x20 or ord(char) == 0x7F for char in normalized):
        raise ValueError(f"source {key} is invalid")
    return normalized


@dataclass(frozen=True, slots=True)
class AppConfig:
    project_root: Path
    database_path: Path
    sources: tuple[Mapping[str, Any], ...]
    keywords: Mapping[str, Any]
    customer_hospitals: tuple[Mapping[str, Any], ...] = ()
    timezone: str = "Asia/Shanghai"
    schedule_time: str = "08:05"
    timeout_seconds: int = 15
    retries: int = 2
    stale_after_hours: int = 48
    notify_possible: bool = False

    def __repr__(self) -> str:
        return (
            "AppConfig("
            f"project_root={self.project_root!r}, database_path={self.database_path!r}, "
            f"sources={self.sources!r}, keywords={self.keywords!r}, "
            f"customer_hospitals={len(self.customer_hospitals)!r}, "
            f"timezone={self.timezone!r}, schedule_time={self.schedule_time!r}, "
            f"timeout_seconds={self.timeout_seconds!r}, retries={self.retries!r}, "
            f"stale_after_hours={self.stale_after_hours!r}, notify_possible={self.notify_possible!r})"
        )


def load_config(env: Mapping[str, str], project_root: Path) -> AppConfig:
    """Load collector configuration without any outbound notification credentials."""
    root = Path(project_root).resolve()
    config_dir = root / "config"
    raw_sources = _read_json(config_dir / "sources.json", "sources")
    raw_keywords = _read_json(config_dir / "keywords.json", "strong")
    customer_hospitals_path = str(env.get("HOSPITAL_TENDER_MONITOR_CUSTOMER_HOSPITALS_PATH", "")).strip()
    customer_hospitals = _load_customer_hospitals(
        Path(customer_hospitals_path) if customer_hospitals_path else config_dir / "customer_hospitals.json"
    )
    if not isinstance(raw_sources, list):
        raise ValueError("sources.json sources must be a list")
    if not isinstance(raw_keywords, list):
        raise ValueError("keywords.json strong must be a list")
    sources: list[Mapping[str, Any]] = []
    source_ids: set[str] = set()
    for source in raw_sources:
        if not isinstance(source, dict):
            raise ValueError("each source must be an object")
        source_id = _source_text(source, "id")
        _source_text(source, "name")
        adapter = _source_text(source, "adapter")
        enabled = source.get("enabled", True)
        if type(enabled) is not bool:
            raise ValueError("source enabled must be a boolean")
        if source_id in source_ids:
            raise ValueError("source ids must be unique")
        source_ids.add(source_id)
        url = source.get("url")
        validate_public_url(url)
        coverage = source.get("coverage")
        if coverage is not None and coverage not in {"direct", "indirect", "disabled", "failing"}:
            raise ValueError("source coverage is invalid")
        if adapter.casefold() in {
            "hospital", "hospital_html", "hospital-html", "generic_html",
            "jiaozhou_central_hospital", "jiaozhou-central-hospital", "jiaozhou_hospital", "qdjzch",
        }:
            names = source.get("hospital_names")
            if not isinstance(names, list) or not names or any(
                not isinstance(name, str) or not name.strip() for name in names
            ):
                raise ValueError("hospital source hospital_names are required")
        sources.append(_freeze(source))
    sources = [_freeze(source) for source in _customer_sources(sources, customer_hospitals)]
    data_dir = Path(env.get("HOSPITAL_TENDER_MONITOR_DATA_DIR", root / "data"))
    database_path = Path(
        env.get("HOSPITAL_TENDER_MONITOR_DATABASE_PATH", data_dir / "hospital-tender-monitor.sqlite3")
    )
    keywords_document = json.loads((config_dir / "keywords.json").read_text(encoding="utf-8"))
    return AppConfig(
        project_root=root,
        database_path=database_path,
        sources=tuple(sources),
        keywords=_freeze(keywords_document),
        customer_hospitals=customer_hospitals,
        timeout_seconds=_positive_int(env, "HOSPITAL_TENDER_MONITOR_TIMEOUT_SECONDS", 15),
        retries=_positive_int(env, "HOSPITAL_TENDER_MONITOR_RETRIES", 2),
        stale_after_hours=_positive_int(env, "HOSPITAL_TENDER_MONITOR_STALE_AFTER_HOURS", 48),
        notify_possible=_boolean(env, "HOSPITAL_TENDER_MONITOR_NOTIFY_POSSIBLE", False),
    )
