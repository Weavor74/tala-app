import os
import re
from typing import Any, Dict, Optional


def _safe_int(raw: Any) -> Optional[int]:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw)
    s = str(raw).strip().lower()
    if not s:
        return None
    m = re.search(r"\b(\d{1,3})\b", s)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _parse_bool(raw: Any) -> Optional[bool]:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    text = str(raw).strip().lower()
    if text in ("true", "1", "yes", "y", "on"):
        return True
    if text in ("false", "0", "no", "n", "off"):
        return False
    return None


def _parse_age_from_text(raw: Any) -> Optional[int]:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        age = int(raw)
        return age if 0 <= age <= 130 else None
    text = str(raw).lower()
    m = re.search(
        r"(?:age\s*[:\-]?\s*|when\s+you\s+were\s+|at\s+)?(\d{1,2})(?:\s*(?:years?\s*old|yo))?\b",
        text,
    )
    if m:
        age = int(m.group(1))
        return age if 0 <= age <= 130 else None
    return None


def _extract_ltmf_age(metadata: Dict[str, Any], source: str, text_content: str) -> Optional[int]:
    candidates = [
        metadata.get("age"),
        metadata.get("life_stage"),
        metadata.get("age_life_stage"),
        metadata.get("age_year"),
    ]
    for c in candidates:
        age = _parse_age_from_text(c)
        if age is not None:
            return age

    file_name = os.path.basename(source).lower()
    m_file_age = re.search(r"age[_\-\s]?(\d{1,2})", file_name)
    if m_file_age:
        age = int(m_file_age.group(1))
        if 0 <= age <= 130:
            return age

    m_ltmf_id = re.search(r"ltmf-a(\d{2})", file_name)
    if m_ltmf_id:
        age = int(m_ltmf_id.group(1))
        if 0 <= age <= 130:
            return age

    m_content_age = re.search(r"age\s*/\s*life\s*stage\s*:\s*([^\n\r]+)", text_content, re.IGNORECASE)
    if m_content_age:
        age = _parse_age_from_text(m_content_age.group(1))
        if age is not None:
            return age

    return None


def _extract_age_sequence(metadata: Dict[str, Any], metadata_id: str, source: str) -> Optional[int]:
    for key in ("age_sequence", "sequence", "order", "memory_index"):
        seq = _safe_int(metadata.get(key))
        if seq is not None and seq >= 0:
            return seq

    m_doc = re.search(r"a\d{2}-(\d{1,6})", metadata_id.lower())
    if m_doc:
        return int(m_doc.group(1))

    source_file_name = os.path.basename(source).lower()
    m_file = re.search(r"memory[_\-\s]?(\d{1,4})", source_file_name)
    if m_file:
        return int(m_file.group(1))

    m_chunk = re.search(r"_(\d{1,6})$", metadata_id)
    if m_chunk:
        return int(m_chunk.group(1))

    return None


def _looks_like_ltmf(metadata: Dict[str, Any]) -> bool:
    source = str(metadata.get("source", "")).lower()
    category = str(metadata.get("category", "")).lower()
    metadata_id = str(metadata.get("id", "")).lower()
    is_structured = bool(metadata.get("is_structured"))

    source_basename = os.path.basename(source)
    source_name_ltmf = "ltmf" in source_basename
    source_path_ltmf = "tala_long_term_memory_file_ltmf" in source
    id_ltmf = metadata_id.startswith("ltmf-a")

    if not (source_name_ltmf or source_path_ltmf or id_ltmf):
        return False

    return category == "roleplay" or is_structured


def canonicalize_metadata_for_storage(metadata: Dict[str, Any]) -> Dict[str, Any]:
    normalized = dict(metadata)
    source = str(normalized.get("source", ""))
    text_content = str(normalized.get("text", ""))
    metadata_id = str(normalized.get("id", ""))

    existing_source_type = normalized.get("source_type")
    if isinstance(existing_source_type, str) and existing_source_type.strip().lower() == "ltmf":
        is_ltmf = True
        normalized["source_type"] = "ltmf"
    else:
        is_ltmf = _looks_like_ltmf(normalized)
        if is_ltmf:
            normalized["source_type"] = "ltmf"

    if is_ltmf:
        normalized["memory_type"] = "autobiographical"

        canon_bool = _parse_bool(normalized.get("canon"))
        normalized["canon"] = True if canon_bool is None else canon_bool

        age = _extract_ltmf_age(normalized, source, text_content)
        if age is not None:
            normalized["age"] = age

        seq = _extract_age_sequence(normalized, metadata_id, source)
        if seq is not None:
            normalized["age_sequence"] = seq
    else:
        canon_bool = _parse_bool(normalized.get("canon"))
        if canon_bool is not None:
            normalized["canon"] = canon_bool

        age = _safe_int(normalized.get("age"))
        if age is not None and 0 <= age <= 130:
            normalized["age"] = age

        seq = _safe_int(normalized.get("age_sequence"))
        if seq is not None and seq >= 0:
            normalized["age_sequence"] = seq

    return normalized


def metadata_matches_filter(metadata: Dict[str, Any], filter_meta: Dict[str, Any]) -> bool:
    normalized = canonicalize_metadata_for_storage(metadata)

    for key, expected in filter_meta.items():
        actual = normalized.get(key)

        if isinstance(expected, list):
            if not any(metadata_matches_filter(normalized, {key: v}) for v in expected):
                return False
            continue

        if key in ("age", "age_sequence", "sequence", "order", "memory_index"):
            expected_int = _safe_int(expected)
            actual_int = _safe_int(actual)
            if expected_int is None or actual_int is None or expected_int != actual_int:
                return False
            continue

        if key == "canon":
            expected_bool = _parse_bool(expected)
            actual_bool = _parse_bool(actual)
            if expected_bool is None or actual_bool is None or expected_bool != actual_bool:
                return False
            continue

        if actual != expected:
            return False

    return True
