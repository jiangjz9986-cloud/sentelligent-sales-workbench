"""Deterministic, explainable relevance scoring for tender notices."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping

from .models import ClassifiedNotice, RelevanceLevel, TenderNotice


_CATEGORIES = ("strong", "context", "noise")
_WEIGHT_KEYS = (*_CATEGORIES, "title_information_department_override")
_THRESHOLD_KEYS = ("high", "possible", "irrelevant")
_ASCII_ACRONYMS = frozenset({"his", "emr", "lis", "pacs", "ris"})
_TITLE_INFORMATION_TERMS = frozenset({"信息科", "信息中心"})
_FIELDS = ("title", "purchaser", "hospital_names", "body")


@dataclass(frozen=True, slots=True)
class KeywordRules:
    """Immutable keyword lists and score policy loaded from JSON."""

    strong: tuple[str, ...]
    context: tuple[str, ...]
    noise: tuple[str, ...]
    weights: Mapping[str, int]
    thresholds: Mapping[str, int]

    def __post_init__(self) -> None:
        for category in _CATEGORIES:
            raw_value = getattr(self, category)
            if isinstance(raw_value, (str, bytes)) or not isinstance(raw_value, (tuple, list)):
                raise ValueError(f"{category} must be a list or tuple of non-empty strings")
            value = tuple(raw_value)
            if any(not isinstance(term, str) or not term.strip() for term in value):
                raise ValueError(f"{category} must be a list of non-empty strings")
            normalized_terms = tuple(_normalize(term) for term in value)
            if len(set(normalized_terms)) != len(normalized_terms):
                raise ValueError(f"{category} must not contain duplicate terms")
            object.__setattr__(self, category, value)
        object.__setattr__(self, "weights", _validate_policy_mapping("weights", self.weights, _WEIGHT_KEYS))
        object.__setattr__(self, "thresholds", _validate_policy_mapping("thresholds", self.thresholds, _THRESHOLD_KEYS))
        if self.thresholds["high"] < self.thresholds["possible"]:
            raise ValueError("thresholds high must be at least possible")
        if self.thresholds["possible"] < self.thresholds["irrelevant"]:
            raise ValueError("thresholds possible must be at least irrelevant")


def _validate_policy_mapping(name: str, value: Mapping[str, int], keys: tuple[str, ...]) -> Mapping[str, int]:
    if not isinstance(value, Mapping) or set(value) != set(keys):
        raise ValueError(f"{name} must contain exactly: {', '.join(keys)}")
    if any(type(item) is not int for item in value.values()):
        raise ValueError(f"{name} values must be integers")
    if any(item < 0 for item in value.values()):
        raise ValueError(f"{name} values must be non-negative")
    return MappingProxyType(dict(value))


def load_keyword_rules(path: Path, *, extra_context: tuple[str, ...] = ()) -> KeywordRules:
    """Load and validate the public JSON keyword schema."""
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"missing keyword rules file: {Path(path).name}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {Path(path).name}") from exc
    if not isinstance(document, dict) or set(document) != set((*_CATEGORIES, "weights", "thresholds")):
        raise ValueError("keyword rules must contain strong, context, noise, weights, and thresholds")
    try:
        context = list(document["context"])
        known_context = {_normalize(term) for term in context}
        for term in extra_context:
            if not isinstance(term, str) or not term.strip():
                raise ValueError("extra context terms must be non-empty strings")
            normalized = _normalize(term)
            if normalized not in known_context:
                context.append(term)
                known_context.add(normalized)
        return KeywordRules(
            strong=_keyword_list(document["strong"], "strong"),
            context=_keyword_list(context, "context"),
            noise=_keyword_list(document["noise"], "noise"),
            weights=document["weights"],
            thresholds=document["thresholds"],
        )
    except (KeyError, TypeError) as exc:
        raise ValueError("invalid keyword rules schema") from exc


def _keyword_list(value: object, category: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ValueError(f"{category} must be a list")
    return tuple(value)


def _normalize(value: str) -> str:
    return " ".join(value.casefold().split())


def _contains(text: str, term: str) -> bool:
    normalized_term = _normalize(term)
    if normalized_term in _ASCII_ACRONYMS:
        return re.search(rf"(?<![A-Za-z0-9_]){re.escape(normalized_term)}(?![A-Za-z0-9_])", text) is not None
    return normalized_term in text


def _notice_fields(notice: TenderNotice) -> dict[str, str]:
    return {
        "title": _normalize(notice.title),
        "purchaser": _normalize(notice.purchaser),
        "hospital_names": _normalize(" ".join(notice.hospital_names)),
        "body": _normalize(notice.content_text),
    }


def _first_matching_field(term: str, fields: Mapping[str, str]) -> str | None:
    return next((field for field in _FIELDS if _contains(fields[field], term)), None)


def _term_reason(category: str, field: str, term: str) -> str:
    if category == "strong":
        return f"body-only strong term: {term}" if field == "body" else f"{field} strong term: {term}"
    if category == "context":
        return f"hospital context: {term} ({field})"
    return f"{field} noise term: {term}"


def classify(notice: TenderNotice, rules: KeywordRules) -> ClassifiedNotice:
    """Classify one notice using configured policy and stable explanations."""
    fields = _notice_fields(notice)
    matches: list[tuple[str, str, str]] = []
    for category in _CATEGORIES:
        for term in getattr(rules, category):
            field = _first_matching_field(term, fields)
            if field is not None:
                matches.append((category, term, field))

    # Keep explanations concise where configured context terms overlap. A
    # longer context/noise phrase is the more specific evidence (for example,
    # 中医院 supersedes 医院 and 医疗耗材 supersedes 医疗), while strong terms
    # remain independently observable even when they contain context words.
    context_terms = [(term, field) for category, term, field in matches if category == "context"]
    noise_terms = [(term, field) for category, term, field in matches if category == "noise"]
    matches = [
        item
        for item in matches
        if not (
            item[0] == "context"
            and (
                any(item[2] == field and item[1] != term and item[1] in term for term, field in context_terms)
                or any(item[2] == field and item[1] in term for term, field in noise_terms)
            )
        )
    ]

    score = sum(rules.weights[category] for category, _, _ in matches)
    title_information_override = any(
        category == "strong" and term in _TITLE_INFORMATION_TERMS and field == "title"
        for category, term, field in matches
    )
    if title_information_override:
        score += rules.weights["title_information_department_override"]

    strong_matches = [(term, field) for category, term, field in matches if category == "strong"]
    non_body_context = any(category == "context" and field != "body" for category, _, field in matches)
    non_body_strong = any(field != "body" for _, field in strong_matches)
    body_strong = any(field == "body" for _, field in strong_matches)

    if title_information_override:
        level = RelevanceLevel.HIGH
        decision = "title information department/center override"
    elif non_body_strong and non_body_context and score >= rules.thresholds["high"]:
        level = RelevanceLevel.HIGH
        decision = "strong term with hospital context"
    elif strong_matches and score < rules.thresholds["irrelevant"]:
        level = RelevanceLevel.IRRELEVANT
        decision = "no qualifying IT evidence"
    elif strong_matches and body_strong and score >= rules.thresholds["possible"]:
        level = RelevanceLevel.POSSIBLE
        decision = "hospital notice has body-only IT term"
    elif strong_matches and score >= rules.thresholds["possible"]:
        level = RelevanceLevel.POSSIBLE
        decision = "strong term without complete hospital context"
    elif strong_matches and score >= rules.thresholds["irrelevant"]:
        level = RelevanceLevel.POSSIBLE
        decision = "strong IT evidence below possible threshold"
    else:
        # Evidence gates keep context/noise-only notices irrelevant regardless
        # of score; strong matches below the lower threshold are also irrelevant.
        level = RelevanceLevel.IRRELEVANT
        decision = "no qualifying IT evidence"

    return ClassifiedNotice(
        notice=notice,
        score=score,
        level=level,
        matched_terms=tuple(term for _, term, _ in matches),
        reasons=tuple(_term_reason(category, field, term) for category, term, field in matches) + (decision,),
    )
