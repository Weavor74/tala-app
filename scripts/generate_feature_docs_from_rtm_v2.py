#!/usr/bin/env python3
"""
generate_feature_docs_from_rtm_v2.py

Purpose
-------
Generate feature documentation from the Requirements Trace Matrix (RTM) and enrich
it with implementation behavior extracted from active source-file docblocks.

This version improves on the basic RTM generator by:
- using RTM as the primary grouping source
- reading active authored source files from the file inventory
- extracting JSDoc / TypeScript-style docblocks from active files
- attaching implementation behavior to generated feature specs
- optionally enriching features with architecture/interface/security references

Expected inputs
---------------
Required:
- docs/traceability/requirements_trace_matrix.md
- docs/audit/file_inventory_full.json

Optional but recommended:
- docs/traceability/test_trace_matrix.md
- docs/architecture/component_model.md
- docs/interfaces/interface_matrix.md
- docs/security/threat_model.md

Outputs
-------
- docs/features/system_features.md
- docs/features/feature_catalog.json
- docs/features/<feature-slug>.md

Design goals
------------
- RTM remains source-of-truth for feature grouping
- implementation docblocks enrich feature behavior text
- only active/authored files are scanned for code docs
- tolerant of markdown table variations
- safe for repeated regeneration
- intended to be run automatically in hooks/CI

Usage
-----
Basic:
    python scripts/generate_feature_docs_from_rtm_v2.py --repo .

Custom paths:
    python scripts/generate_feature_docs_from_rtm_v2.py ^
      --repo . ^
      --rtm docs/traceability/requirements_trace_matrix.md ^
      --inventory docs/audit/file_inventory_full.json ^
      --out docs/features

Notes
-----
- This script does NOT rewrite source code.
- Generated docs should not be hand-edited.
- Update requirements/traceability/source docblocks, then regenerate.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# ============================================================
# Data models
# ============================================================

@dataclass
class TraceRow:
    requirement_id: str = ""
    requirement_description: str = ""
    feature: str = ""
    capability: str = ""
    subsystem: str = ""
    component: str = ""
    source_file: str = ""
    verification_method: str = ""
    test_location: str = ""
    notes: str = ""


@dataclass
class DocblockEntry:
    file_path: str
    entry_type: str = ""          # class | method | function | interface | type | const | enum | unknown
    symbol_name: str = ""
    summary: str = ""
    details: List[str] = field(default_factory=list)
    params: List[str] = field(default_factory=list)
    returns: str = ""
    throws: List[str] = field(default_factory=list)
    visibility: str = ""
    raw_comment: str = ""


@dataclass
class FeatureDoc:
    feature_name: str
    slug: str
    capability: str = ""
    subsystems: List[str] = field(default_factory=list)
    components: List[str] = field(default_factory=list)
    source_files: List[str] = field(default_factory=list)
    verification_methods: List[str] = field(default_factory=list)
    test_locations: List[str] = field(default_factory=list)
    requirement_ids: List[str] = field(default_factory=list)
    requirement_descriptions: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    implementation_entries: List[DocblockEntry] = field(default_factory=list)
    implementation_behavior: List[str] = field(default_factory=list)

    architecture_refs: List[str] = field(default_factory=list)
    interface_refs: List[str] = field(default_factory=list)
    security_refs: List[str] = field(default_factory=list)


# ============================================================
# File I/O helpers
# ============================================================

def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except Exception:
            continue
    raise RuntimeError(f"Could not read {path}")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


# ============================================================
# String helpers
# ============================================================

def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
    value = re.sub(r"_+", "_", value).strip("_")
    return value or "unnamed_feature"


def dedupe_keep_order(items: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for item in items:
        if not item:
            continue
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def normalize_header(header: str) -> str:
    h = header.strip().lower()
    h = re.sub(r"[^a-z0-9]+", " ", h).strip()

    aliases = {
        "requirement id": "requirement_id",
        "req id": "requirement_id",
        "requirement": "requirement_description",
        "requirement description": "requirement_description",
        "description": "requirement_description",
        "feature": "feature",
        "capability": "capability",
        "subsystem": "subsystem",
        "component": "component",
        "source file": "source_file",
        "file": "source_file",
        "implementation file": "source_file",
        "verification method": "verification_method",
        "verification": "verification_method",
        "test location": "test_location",
        "test": "test_location",
        "notes": "notes",
    }
    return aliases.get(h, h.replace(" ", "_"))


# ============================================================
# Markdown table parsing
# ============================================================

def split_md_row(line: str) -> List[str]:
    return [p.strip() for p in line.strip().strip("|").split("|")]


def is_separator_row(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and all(ch in "|:- " for ch in stripped)


def parse_markdown_tables(text: str) -> List[Tuple[List[str], List[Dict[str, str]]]]:
    lines = text.splitlines()
    tables: List[Tuple[List[str], List[Dict[str, str]]]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if "|" in line and i + 1 < len(lines) and is_separator_row(lines[i + 1]):
            headers = [normalize_header(h) for h in split_md_row(line)]
            i += 2
            rows: List[Dict[str, str]] = []
            while i < len(lines):
                curr = lines[i]
                if not curr.strip():
                    i += 1
                    continue
                if curr.strip().startswith("#"):
                    break
                if "|" not in curr:
                    break
                raw = split_md_row(curr)
                if len(raw) == len(headers):
                    rows.append({headers[idx]: raw[idx] for idx in range(len(headers))})
                i += 1
            tables.append((headers, rows))
        else:
            i += 1
    return tables


# ============================================================
# RTM parsing
# ============================================================

def parse_trace_rows(rtm_path: Path, test_trace_path: Optional[Path]) -> List[TraceRow]:
    rtm_text = read_text(rtm_path)
    rtm_tables = parse_markdown_tables(rtm_text)

    rows: List[TraceRow] = []

    for headers, table_rows in rtm_tables:
        if "requirement_id" not in headers and "requirement_description" not in headers:
            continue

        for row in table_rows:
            trace = TraceRow(
                requirement_id=row.get("requirement_id", "").strip(),
                requirement_description=row.get("requirement_description", "").strip(),
                feature=row.get("feature", "").strip(),
                capability=row.get("capability", "").strip(),
                subsystem=row.get("subsystem", "").strip(),
                component=row.get("component", "").strip(),
                source_file=row.get("source_file", "").strip(),
                verification_method=row.get("verification_method", "").strip(),
                test_location=row.get("test_location", "").strip(),
                notes=row.get("notes", "").strip(),
            )
            if trace.requirement_id or trace.requirement_description:
                rows.append(trace)

    # Optional enrichment from test trace matrix
    if test_trace_path and test_trace_path.exists():
        test_text = read_text(test_trace_path)
        test_tables = parse_markdown_tables(test_text)
        test_map: Dict[str, Dict[str, str]] = {}
        for headers, table_rows in test_tables:
            if "requirement_id" not in headers:
                continue
            for row in table_rows:
                rid = row.get("requirement_id", "").strip()
                if rid:
                    test_map[rid] = row

        for row in rows:
            if row.requirement_id in test_map:
                trow = test_map[row.requirement_id]
                if not row.verification_method:
                    row.verification_method = trow.get("verification_method", "").strip()
                if not row.test_location:
                    row.test_location = trow.get("test_location", "").strip()

    return rows


# ============================================================
# Inventory filtering
# ============================================================

def load_active_file_inventory(inventory_path: Path) -> Dict[str, Dict]:
    """
    Returns map of normalized path -> inventory item for active authored files.
    Tries to tolerate a few possible shapes.
    """
    data = json.loads(read_text(inventory_path))
    items: List[Dict] = []

    if isinstance(data, dict):
        if isinstance(data.get("files"), list):
            items = data["files"]
        elif isinstance(data.get("items"), list):
            items = data["items"]
        else:
            # fallback: maybe dict keyed by path
            if all(isinstance(v, dict) for v in data.values()):
                items = list(data.values())
    elif isinstance(data, list):
        items = data

    active: Dict[str, Dict] = {}
    for item in items:
        if not isinstance(item, dict):
            continue

        path = (
            item.get("path")
            or item.get("relative_path")
            or item.get("file_path")
            or item.get("name")
            or ""
        )
        if not path:
            continue

        role = str(item.get("role", "")).upper()
        status = str(item.get("status", "")).upper()
        subsystem = str(item.get("subsystem", ""))

        # Exclude obviously non-authored / excluded / archive / generated
        excluded = False
        raw = f"{role} {status} {subsystem}".upper()
        if any(x in raw for x in ["ARCHIVE", "GENERATED", "EXCLUDED", "VENDOR", "DEPENDENCY"]):
            excluded = True

        lower_path = str(path).replace("\\", "/").lower()
        if any(seg in lower_path for seg in [
            "/node_modules/",
            "/venv/",
            "/.venv/",
            "/site-packages/",
            "/dist/",
            "/dist-electron/",
            "/archive/",
            "/archives/",
            "/.git/",
        ]):
            excluded = True

        if not excluded:
            active[normalize_path(path)] = item

    return active


def normalize_path(path: str) -> str:
    return path.replace("\\", "/").strip()


# ============================================================
# Docblock extraction
# ============================================================

DOCBLOCK_RE = re.compile(r"/\*\*(.*?)\*/", re.DOTALL)
PARAM_RE = re.compile(r"@param\s+(?:\{[^}]+\}\s+)?(\[?[A-Za-z0-9_.]+\]?)\s*-?\s*(.*)")
RETURNS_RE = re.compile(r"@returns?\s+(?:\{[^}]+\}\s+)?(.*)")
THROWS_RE = re.compile(r"@throws\s+(.*)")
VISIBILITY_RE = re.compile(r"\b(public|private|protected)\b")
CLASS_RE = re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)")
INTERFACE_RE = re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z0-9_]+)")
ENUM_RE = re.compile(r"^\s*(?:export\s+)?enum\s+([A-Za-z0-9_]+)")
FUNCTION_RE = re.compile(r"^\s*(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(")
CONST_ARROW_RE = re.compile(r"^\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(")
METHOD_RE = re.compile(
    r"^\s*(public|private|protected)?\s*(?:async\s+)?([A-Za-z0-9_]+)\s*\("
)


def clean_docblock(comment_body: str) -> List[str]:
    lines = comment_body.splitlines()
    cleaned: List[str] = []
    for line in lines:
        line = re.sub(r"^\s*\*\s?", "", line.rstrip())
        cleaned.append(line)
    return cleaned


def split_docblock_sections(lines: List[str]) -> Tuple[str, List[str], List[str], str, List[str]]:
    """
    Returns:
    summary, detail_lines, params, returns, throws
    """
    summary_lines: List[str] = []
    detail_lines: List[str] = []
    params: List[str] = []
    returns = ""
    throws: List[str] = []

    in_tags = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        if stripped.startswith("@"):
            in_tags = True

            pm = PARAM_RE.match(stripped)
            if pm:
                name = pm.group(1).strip()
                desc = pm.group(2).strip()
                params.append(f"{name}: {desc}" if desc else name)
                continue

            rm = RETURNS_RE.match(stripped)
            if rm:
                returns = rm.group(1).strip()
                continue

            tm = THROWS_RE.match(stripped)
            if tm:
                throws.append(tm.group(1).strip())
                continue

            continue

        if not in_tags and not summary_lines:
            summary_lines.append(stripped)
        elif not in_tags:
            detail_lines.append(stripped)
        else:
            detail_lines.append(stripped)

    summary = " ".join(summary_lines).strip()
    return summary, detail_lines, params, returns, throws


def identify_symbol_from_following_code(code_line: str) -> Tuple[str, str, str]:
    """
    Returns entry_type, symbol_name, visibility
    """
    visibility = ""
    vm = VISIBILITY_RE.search(code_line)
    if vm:
        visibility = vm.group(1)

    for regex, entry_type in [
        (CLASS_RE, "class"),
        (INTERFACE_RE, "interface"),
        (ENUM_RE, "enum"),
        (FUNCTION_RE, "function"),
        (CONST_ARROW_RE, "const"),
    ]:
        m = regex.search(code_line)
        if m:
            return entry_type, m.group(1), visibility

    mm = METHOD_RE.search(code_line)
    if mm:
        vis = mm.group(1) or visibility
        name = mm.group(2)
        return "method", name, vis

    return "unknown", "", visibility


def extract_docblocks_from_source(text: str, file_path: str) -> List[DocblockEntry]:
    entries: List[DocblockEntry] = []

    for m in DOCBLOCK_RE.finditer(text):
        comment = m.group(1)
        end = m.end()

        # Look ahead a few lines to identify the symbol this docblock belongs to
        tail = text[end:end + 500]
        next_lines = tail.splitlines()
        target_line = ""
        for line in next_lines:
            if line.strip():
                target_line = line
                break

        entry_type, symbol_name, visibility = identify_symbol_from_following_code(target_line)
        lines = clean_docblock(comment)
        summary, details, params, returns, throws = split_docblock_sections(lines)

        # Skip empty docblocks
        if not summary and not details and not params and not returns and not throws:
            continue

        entries.append(
            DocblockEntry(
                file_path=file_path,
                entry_type=entry_type,
                symbol_name=symbol_name,
                summary=summary,
                details=details,
                params=params,
                returns=returns,
                throws=throws,
                visibility=visibility,
                raw_comment="\n".join(lines),
            )
        )

    return entries


def scan_docblocks_for_active_files(repo: Path, active_files: Dict[str, Dict]) -> Dict[str, List[DocblockEntry]]:
    by_file: Dict[str, List[DocblockEntry]] = {}

    for norm_path in active_files.keys():
        path = repo / norm_path
        if not path.exists():
            continue

        suffix = path.suffix.lower()
        if suffix not in {".ts", ".tsx", ".js", ".jsx", ".py"}:
            continue

        try:
            text = read_text(path)
        except Exception:
            continue

        entries = extract_docblocks_from_source(text, norm_path)
        if entries:
            by_file[norm_path] = entries

    return by_file


# ============================================================
# Optional enrichment docs parsing
# ============================================================

def load_reference_markdown_lines(path: Optional[Path]) -> List[str]:
    if not path or not path.exists():
        return []
    return read_text(path).splitlines()


def find_reference_hits(lines: List[str], terms: List[str], max_hits: int = 5) -> List[str]:
    hits: List[str] = []
    if not lines or not terms:
        return hits

    lower_terms = [t.lower() for t in terms if t]
    for line in lines:
        line_stripped = line.strip()
        if not line_stripped:
            continue
        lower_line = line_stripped.lower()
        if any(term in lower_line for term in lower_terms):
            hits.append(line_stripped)
        if len(hits) >= max_hits:
            break
    return dedupe_keep_order(hits)


# ============================================================
# Feature grouping
# ============================================================

def infer_feature_name(row: TraceRow) -> str:
    if row.feature:
        return row.feature
    if row.capability:
        return row.capability
    if row.subsystem:
        return f"{row.subsystem} Features"
    if row.component:
        return f"{row.component} Features"
    return "Uncategorized Features"


def build_feature_docs(rows: List[TraceRow]) -> Dict[str, FeatureDoc]:
    feature_map: Dict[str, FeatureDoc] = {}

    for row in rows:
        feature_name = infer_feature_name(row)
        slug = slugify(feature_name)

        if slug not in feature_map:
            feature_map[slug] = FeatureDoc(
                feature_name=feature_name,
                slug=slug,
                capability=row.capability or "",
            )

        fd = feature_map[slug]
        if row.capability and not fd.capability:
            fd.capability = row.capability

        fd.subsystems.append(row.subsystem)
        fd.components.append(row.component)
        fd.source_files.append(normalize_path(row.source_file))
        fd.verification_methods.append(row.verification_method)
        fd.test_locations.append(row.test_location)
        fd.requirement_ids.append(row.requirement_id)
        fd.requirement_descriptions.append(row.requirement_description)
        if row.notes:
            fd.notes.append(row.notes)

    for fd in feature_map.values():
        fd.subsystems = dedupe_keep_order(fd.subsystems)
        fd.components = dedupe_keep_order(fd.components)
        fd.source_files = dedupe_keep_order([f for f in fd.source_files if f])
        fd.verification_methods = dedupe_keep_order(fd.verification_methods)
        fd.test_locations = dedupe_keep_order(fd.test_locations)
        fd.requirement_ids = dedupe_keep_order(fd.requirement_ids)
        fd.requirement_descriptions = dedupe_keep_order(fd.requirement_descriptions)
        fd.notes = dedupe_keep_order(fd.notes)

    return feature_map


def attach_implementation_behavior(
    features: Dict[str, FeatureDoc],
    docblocks_by_file: Dict[str, List[DocblockEntry]],
) -> None:
    for feature in features.values():
        entries: List[DocblockEntry] = []

        # file-level direct match
        for file_path in feature.source_files:
            norm = normalize_path(file_path)
            if norm in docblocks_by_file:
                entries.extend(docblocks_by_file[norm])

        # component-symbol fallback
        component_names = {c.lower() for c in feature.components if c}
        if component_names:
            for file_entries in docblocks_by_file.values():
                for entry in file_entries:
                    if entry.symbol_name and entry.symbol_name.lower() in component_names:
                        if entry not in entries:
                            entries.append(entry)

        # Keep the most relevant public items first
        entries_sorted = sorted(
            entries,
            key=lambda e: (
                0 if e.entry_type in {"class", "interface"} else 1,
                0 if e.visibility == "public" else 1,
                e.file_path,
                e.symbol_name,
            ),
        )

        # Trim noisy entries but keep enough detail
        feature.implementation_entries = entries_sorted[:20]

        behavior_lines: List[str] = []
        for entry in feature.implementation_entries:
            label = entry.symbol_name or entry.entry_type or "symbol"
            if entry.summary:
                line = f"`{label}` — {entry.summary}"
                if entry.returns:
                    line += f" Returns: {entry.returns}"
                behavior_lines.append(line)

        feature.implementation_behavior = dedupe_keep_order(behavior_lines[:20])


def attach_reference_enrichment(
    features: Dict[str, FeatureDoc],
    architecture_lines: List[str],
    interface_lines: List[str],
    security_lines: List[str],
) -> None:
    for feature in features.values():
        terms = feature.components + feature.subsystems + [feature.feature_name, feature.capability]
        feature.architecture_refs = find_reference_hits(architecture_lines, terms, max_hits=5)
        feature.interface_refs = find_reference_hits(interface_lines, terms, max_hits=5)
        feature.security_refs = find_reference_hits(security_lines, terms, max_hits=5)


# ============================================================
# Rendering
# ============================================================

def render_generated_header() -> List[str]:
    return [
        "> This file is generated from:",
        "> - docs/traceability/requirements_trace_matrix.md",
        "> - docs/traceability/test_trace_matrix.md",
        "> - docs/audit/file_inventory_full.json",
        "> - active source-file docblocks",
        ">",
        "> Do not edit manually. Update the source docs/code comments and regenerate.",
        "",
    ]


def render_system_features_md(features: Dict[str, FeatureDoc]) -> str:
    items = sorted(features.values(), key=lambda f: f.feature_name.lower())

    lines: List[str] = []
    lines.append("# System Features — Tala")
    lines.append("")
    lines.extend(render_generated_header())
    lines.append("## Feature Summary")
    lines.append("")
    lines.append("| Feature | Capability | Requirements | Components | Files | Verification Methods |")
    lines.append("|---|---|---:|---:|---:|---:|")
    for f in items:
        lines.append(
            f"| [{f.feature_name}](./{f.slug}.md) | "
            f"{f.capability or ''} | "
            f"{len(f.requirement_ids)} | "
            f"{len(f.components)} | "
            f"{len(f.source_files)} | "
            f"{len(f.verification_methods)} |"
        )
    lines.append("")
    return "\n".join(lines) + "\n"


def render_docblock_entry(entry: DocblockEntry) -> List[str]:
    lines: List[str] = []
    symbol = entry.symbol_name or "(anonymous)"
    lines.append(f"- **{symbol}** (`{entry.entry_type or 'unknown'}` in `{entry.file_path}`)")
    if entry.summary:
        lines.append(f"  - Summary: {entry.summary}")
    if entry.details:
        for detail in entry.details[:3]:
            lines.append(f"  - Detail: {detail}")
    if entry.params:
        for p in entry.params[:5]:
            lines.append(f"  - Param: {p}")
    if entry.returns:
        lines.append(f"  - Returns: {entry.returns}")
    if entry.throws:
        for t in entry.throws[:3]:
            lines.append(f"  - Throws: {t}")
    return lines


def render_feature_md(feature: FeatureDoc) -> str:
    lines: List[str] = []
    lines.append(f"# Feature Specification — {feature.feature_name}")
    lines.append("")
    lines.extend(render_generated_header())

    lines.append("## Feature Summary")
    lines.append("")
    lines.append(f"**Feature Name:** {feature.feature_name}")
    lines.append(f"**Capability:** {feature.capability or 'Not explicitly specified'}")
    lines.append(f"**Requirement Count:** {len(feature.requirement_ids)}")
    lines.append(f"**Component Count:** {len(feature.components)}")
    lines.append(f"**Implementation File Count:** {len(feature.source_files)}")
    lines.append("")

    lines.append("## Requirement Basis")
    lines.append("")
    for rid, desc in zip(feature.requirement_ids, feature.requirement_descriptions):
        lines.append(f"- **{rid}** — {desc}")
    lines.append("")

    lines.append("## Subsystems")
    lines.append("")
    for item in feature.subsystems:
        lines.append(f"- {item}")
    lines.append("")

    lines.append("## Components")
    lines.append("")
    for item in feature.components:
        lines.append(f"- {item}")
    lines.append("")

    lines.append("## Source Files")
    lines.append("")
    for item in feature.source_files:
        lines.append(f"- `{item}`")
    lines.append("")

    lines.append("## Implementation Behavior")
    lines.append("")
    if feature.implementation_behavior:
        for item in feature.implementation_behavior:
            lines.append(f"- {item}")
    else:
        lines.append("_No implementation docblock summaries were matched to this feature._")
    lines.append("")

    lines.append("## Primary Methods / Functions")
    lines.append("")
    if feature.implementation_entries:
        for entry in feature.implementation_entries[:12]:
            lines.extend(render_docblock_entry(entry))
    else:
        lines.append("_No docblock entries available._")
    lines.append("")

    lines.append("## Interfaces")
    lines.append("")
    if feature.interface_refs:
        for item in feature.interface_refs:
            lines.append(f"- {item}")
    else:
        lines.append("_No direct interface references matched from the interface docs._")
    lines.append("")

    lines.append("## Security Notes")
    lines.append("")
    if feature.security_refs:
        for item in feature.security_refs:
            lines.append(f"- {item}")
    else:
        lines.append("_No direct security references matched from the threat/security docs._")
    lines.append("")

    lines.append("## Architecture References")
    lines.append("")
    if feature.architecture_refs:
        for item in feature.architecture_refs:
            lines.append(f"- {item}")
    else:
        lines.append("_No direct architecture references matched from the architecture docs._")
    lines.append("")

    lines.append("## Verification")
    lines.append("")
    lines.append("**Methods**")
    if feature.verification_methods:
        for item in feature.verification_methods:
            lines.append(f"- {item}")
    else:
        lines.append("- _No verification methods documented._")
    lines.append("")
    lines.append("**Test Locations**")
    if feature.test_locations:
        for item in feature.test_locations:
            lines.append(f"- `{item}`")
    else:
        lines.append("- _No test locations documented._")
    lines.append("")

    if feature.notes:
        lines.append("## Notes")
        lines.append("")
        for item in feature.notes:
            lines.append(f"- {item}")
        lines.append("")

    return "\n".join(lines) + "\n"


def write_feature_outputs(out_dir: Path, features: Dict[str, FeatureDoc]) -> None:
    ensure_dir(out_dir)

    # System overview
    write_text(out_dir / "system_features.md", render_system_features_md(features))

    # JSON catalog
    catalog = {
        "generated_from": {
            "requirements_trace_matrix": "docs/traceability/requirements_trace_matrix.md",
            "test_trace_matrix": "docs/traceability/test_trace_matrix.md",
            "file_inventory": "docs/audit/file_inventory_full.json",
            "implementation_enrichment": "active source file docblocks",
        },
        "feature_count": len(features),
        "features": [
            {
                **asdict(f),
                "implementation_entries": [asdict(e) for e in f.implementation_entries],
            }
            for f in sorted(features.values(), key=lambda x: x.feature_name.lower())
        ],
    }
    write_text(out_dir / "feature_catalog.json", json.dumps(catalog, indent=2))

    # Per-feature docs
    for feature in features.values():
        write_text(out_dir / f"{feature.slug}.md", render_feature_md(feature))


# ============================================================
# Main
# ============================================================

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate feature documentation from the RTM plus active-file docblocks."
    )
    parser.add_argument("--repo", required=True, help="Repository root")
    parser.add_argument(
        "--rtm",
        default="docs/traceability/requirements_trace_matrix.md",
        help="Requirements trace matrix path, relative to repo",
    )
    parser.add_argument(
        "--test-trace",
        default="docs/traceability/test_trace_matrix.md",
        help="Test trace matrix path, relative to repo",
    )
    parser.add_argument(
        "--inventory",
        default="docs/audit/file_inventory_full.json",
        help="Full file inventory path, relative to repo",
    )
    parser.add_argument(
        "--architecture",
        default="docs/architecture/component_model.md",
        help="Architecture reference doc, relative to repo",
    )
    parser.add_argument(
        "--interfaces",
        default="docs/interfaces/interface_matrix.md",
        help="Interface reference doc, relative to repo",
    )
    parser.add_argument(
        "--security",
        default="docs/security/threat_model.md",
        help="Security reference doc, relative to repo",
    )
    parser.add_argument(
        "--out",
        default="docs/features",
        help="Output directory, relative to repo",
    )
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    rtm_path = repo / args.rtm
    test_trace_path = repo / args.test_trace
    inventory_path = repo / args.inventory
    out_dir = repo / args.out

    architecture_path = repo / args.architecture
    interfaces_path = repo / args.interfaces
    security_path = repo / args.security

    if not repo.exists():
        raise SystemExit(f"Repository path does not exist: {repo}")
    if not rtm_path.exists():
        raise SystemExit(f"RTM not found: {rtm_path}")
    if not inventory_path.exists():
        raise SystemExit(f"File inventory not found: {inventory_path}")

    rows = parse_trace_rows(rtm_path, test_trace_path if test_trace_path.exists() else None)
    if not rows:
        raise SystemExit("No usable requirements rows found in the RTM.")

    active_files = load_active_file_inventory(inventory_path)
    docblocks_by_file = scan_docblocks_for_active_files(repo, active_files)

    features = build_feature_docs(rows)
    attach_implementation_behavior(features, docblocks_by_file)

    architecture_lines = load_reference_markdown_lines(architecture_path)
    interface_lines = load_reference_markdown_lines(interfaces_path)
    security_lines = load_reference_markdown_lines(security_path)
    attach_reference_enrichment(features, architecture_lines, interface_lines, security_lines)

    write_feature_outputs(out_dir, features)

    print("Feature documentation generated.")
    print(f"Repo: {repo}")
    print(f"RTM rows: {len(rows)}")
    print(f"Active files in inventory: {len(active_files)}")
    print(f"Files with extracted docblocks: {len(docblocks_by_file)}")
    print(f"Feature count: {len(features)}")
    print(f"Output: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())