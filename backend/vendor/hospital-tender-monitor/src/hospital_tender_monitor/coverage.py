"""Hospital direct/indirect source coverage reporting."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

from .models import SourceHealth


_STATES = {"direct", "indirect", "disabled", "failing"}


@dataclass(frozen=True, slots=True)
class CoverageEntry:
    source_id: str
    source_name: str
    city: str
    hospital_names: tuple[str, ...]
    state: str
    procurement_url: str = ""
    error: str = ""


@dataclass(frozen=True, slots=True)
class CoverageReport:
    entries: tuple[CoverageEntry, ...]
    counts: dict[str, int]


def build_coverage_report(
    config: Sequence[Mapping[str, object]] | Mapping[str, object], health_rows: Sequence[SourceHealth]
) -> CoverageReport:
    if isinstance(config, Mapping):
        candidate = config.get("sources", ())
        config = candidate if isinstance(candidate, (list, tuple)) else ()
    health = {row.source_id: row for row in health_rows}
    entries: list[CoverageEntry] = []
    for source in config:
        names = source.get("hospital_names", ())
        if not isinstance(names, (list, tuple)) or not names:
            continue
        source_id = str(source.get("id", ""))
        configured = source.get("coverage")
        if not isinstance(configured, str) or configured not in _STATES:
            raise ValueError("hospital coverage state must be explicit and valid")
        enabled = bool(source.get("enabled", True))
        row = health.get(source_id)
        state = "disabled" if not enabled or configured == "disabled" else ("failing" if row and not row.success else configured)
        entries.append(CoverageEntry(source_id, str(source.get("name", "")), str(source.get("city", "")), tuple(str(name) for name in names), state, str(source.get("procurement_url", "")), row.error if row and not row.success else ""))
    counts = {state: sum(entry.state == state for entry in entries) for state in ("direct", "indirect", "disabled", "failing")}
    return CoverageReport(tuple(entries), counts)
