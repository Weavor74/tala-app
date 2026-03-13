#!/usr/bin/env python3
"""
generate_python_dependency_audit.py

Repo-bounded Python dependency audit for Tala-style projects.

Key fixes vs generic version:
- hard excludes bundled/vendor/runtime trees
- only scans likely project code roots by default
- supports strict subsystem mapping
- prevents huge "unclassified" explosions
- keeps pip/freeze as version pinning only, not primary dependency source
"""

from __future__ import annotations

import argparse
import ast
import importlib.metadata
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

try:
    import tomllib
except Exception:
    tomllib = None


DEFAULT_SUBSYSTEM_OUTPUTS = {
    "astro_engine": {
        "deps": "astro_engine_deps.txt",
        "reqs": "astro_engine_requirements.txt",
        "title": "Astro Engine",
    },
    "mcp_core": {
        "deps": "mcp_core_deps.txt",
        "reqs": "mcp_core_requirements.txt",
        "title": "MCP Core",
    },
    "inference": {
        "deps": "inference_deps.txt",
        "reqs": "inference_requirements.txt",
        "title": "Inference",
    },
    "rag": {
        "deps": "rag_deps.txt",
        "reqs": "rag_requirements.txt",
        "title": "RAG",
    },
    "ui_tools": {
        "deps": "ui_tools_deps.txt",
        "reqs": "ui_tools_requirements.txt",
        "title": "UI Tools",
    },
    "unclassified": {
        "deps": "unclassified_deps.txt",
        "reqs": "unclassified_requirements.txt",
        "title": "Unclassified",
    },
}

# Strict-by-default Tala-oriented mapping
DEFAULT_SUBSYSTEM_PATH_RULES = {
    "astro_engine": [
        "mcp-servers/astro-engine",
    ],
    "mcp_core": [
        "mcp-servers/common",
        "mcp-servers/shared",
        "mcp-servers/base",
    ],
    "inference": [
        "local-inference",
    ],
    "rag": [
        "mcp-servers/tala-core",
        "mcp-servers/mem0-core",
    ],
    "ui_tools": [
        "scripts",
        "tools",
    ],
}

# Only scan these roots unless explicitly overridden
DEFAULT_CODE_ROOTS = [
    "mcp-servers/astro-engine",
    "mcp-servers/tala-core",
    "mcp-servers/mem0-core",
    "mcp-servers/common",
    "mcp-servers/shared",
    "mcp-servers/base",
    "local-inference",
    "scripts",
    "tools",
]

IGNORE_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".idea",
    ".vscode",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".turbo",
    "archive",
    "archives",
    "tmp",
    "temp",
    ".venv",
    "venv",
    "env",
    "site-packages",
    "vendor",
    "vendors",
    "third_party",
    "third-party",
    "external",
    "externals",
    ".tox",
    ".nox",
    "obj",
}

# Also ignore paths containing these segments anywhere
IGNORE_PATH_SEGMENTS = {
    "/site-packages/",
    "/dist-packages/",
    "/python-win/",
    "/portable-python/",
    "/embedded-python/",
    "/vendor/",
    "/vendors/",
    "/third_party/",
    "/third-party/",
    "/external/",
    "/externals/",
    "/archive/",
    "/archives/",
    "/node_modules/",
    "/.venv/",
    "/venv/",
    "/env/",
    "/lib/python",
    "/lib64/python",
}

IMPORT_TO_PACKAGE = {
    "PIL": "Pillow",
    "yaml": "PyYAML",
    "cv2": "opencv-python",
    "dotenv": "python-dotenv",
    "bs4": "beautifulsoup4",
    "sklearn": "scikit-learn",
    "qdrant_client": "qdrant-client",
    "sentence_transformers": "sentence-transformers",
    "fitz": "PyMuPDF",
    "dateutil": "python-dateutil",
    "googleapiclient": "google-api-python-client",
    "Crypto": "pycryptodome",
    "OpenSSL": "pyOpenSSL",
    "jwt": "PyJWT",
    "multipart": "python-multipart",
    "orjson": "orjson",
    "uvicorn": "uvicorn",
    "fastapi": "fastapi",
    "pydantic": "pydantic",
    "pydantic_settings": "pydantic-settings",
    "requests": "requests",
    "httpx": "httpx",
    "numpy": "numpy",
    "pandas": "pandas",
    "scipy": "scipy",
    "torch": "torch",
    "transformers": "transformers",
    "tokenizers": "tokenizers",
    "accelerate": "accelerate",
    "llama_cpp": "llama-cpp-python",
    "sse_starlette": "sse-starlette",
    "starlette": "starlette",
    "jinja2": "Jinja2",
    "watchdog": "watchdog",
    "psutil": "psutil",
    "rich": "rich",
    "click": "click",
    "colorama": "colorama",
    "loguru": "loguru",
    "posthog": "posthog",
    "swisseph": "pyswisseph",
    "pyswisseph": "pyswisseph",
    "mem0": "mem0ai",
    "langchain": "langchain",
    "langchain_community": "langchain-community",
    "langchain_openai": "langchain-openai",
    "langchain_core": "langchain-core",
    "unstructured": "unstructured",
    "pdfplumber": "pdfplumber",
    "docx": "python-docx",
    "pptx": "python-pptx",
    "openpyxl": "openpyxl",
    "tiktoken": "tiktoken",
}

FALLBACK_STDLIB = {
    "abc", "argparse", "array", "ast", "asyncio", "base64", "binascii", "bisect",
    "builtins", "calendar", "collections", "concurrent", "contextlib", "copy",
    "csv", "ctypes", "dataclasses", "datetime", "decimal", "difflib", "dis",
    "enum", "errno", "fnmatch", "fractions", "functools", "gc", "glob",
    "gzip", "hashlib", "heapq", "hmac", "html", "http", "importlib", "inspect",
    "io", "itertools", "json", "logging", "lzma", "math", "mimetypes",
    "multiprocessing", "numbers", "operator", "os", "pathlib", "pickle",
    "pkgutil", "platform", "pprint", "queue", "random", "re", "secrets",
    "select", "selectors", "shlex", "shutil", "signal", "site", "socket",
    "sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess",
    "sys", "tempfile", "textwrap", "threading", "time", "tomllib", "traceback",
    "types", "typing", "unicodedata", "unittest", "urllib", "uuid", "venv",
    "warnings", "weakref", "webbrowser", "xml", "zipfile", "zoneinfo",
}

SUSPICIOUS_UTILITY_PACKAGES = {
    "rich",
    "click",
    "colorama",
    "python-dotenv",
    "posthog",
    "loguru",
    "psutil",
    "watchdog",
}

REQ_LINE_RE = re.compile(
    r"^\s*([A-Za-z0-9_.\-]+)\s*"
    r"((?:==|~=|>=|<=|>|<|!=).+?)?"
    r"\s*(?:#.*)?$"
)


@dataclass
class PackageEvidence:
    package: str
    subsystem: str
    imported_by_files: Set[str] = field(default_factory=set)
    imported_as_modules: Set[str] = field(default_factory=set)
    manifest_sources: Set[str] = field(default_factory=set)
    launcher_sources: Set[str] = field(default_factory=set)
    version: Optional[str] = None
    version_source: Optional[str] = None
    suspicious_utility: bool = False
    confidence: str = "PROBABLE"


@dataclass
class SubsystemResult:
    subsystem: str
    files_scanned: List[str] = field(default_factory=list)
    manifest_files: List[str] = field(default_factory=list)
    launcher_files: List[str] = field(default_factory=list)
    packages: Dict[str, PackageEvidence] = field(default_factory=dict)


def safe_read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return path.read_text(encoding=enc)
        except Exception:
            pass
    raise RuntimeError(f"Could not read {path}")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def posix_rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def normalize_module_to_package(module_name: str) -> str:
    top = module_name.split(".")[0]
    return IMPORT_TO_PACKAGE.get(top, top)


def get_stdlib_names() -> Set[str]:
    stdlib = set(FALLBACK_STDLIB)
    if hasattr(sys, "stdlib_module_names"):
        try:
            stdlib |= set(sys.stdlib_module_names)
        except Exception:
            pass
    return stdlib


def is_probably_stdlib(module_name: str, stdlib_names: Set[str]) -> bool:
    return module_name.split(".")[0] in stdlib_names


def load_mapping_json(path: Optional[Path]) -> Dict[str, List[str]]:
    if path is None:
        return DEFAULT_SUBSYSTEM_PATH_RULES
    data = json.loads(safe_read_text(path))
    if not isinstance(data, dict):
        raise ValueError("Mapping JSON must be an object")
    out: Dict[str, List[str]] = {}
    for key, value in data.items():
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ValueError(f"Invalid mapping for {key}")
        out[key] = value
    return out


def load_code_roots(path: Optional[Path]) -> List[str]:
    if path is None:
        return DEFAULT_CODE_ROOTS
    data = json.loads(safe_read_text(path))
    if not isinstance(data, list) or not all(isinstance(v, str) for v in data):
        raise ValueError("Code roots JSON must be a list of strings")
    return data


def path_contains_ignored_segment(rel_path: str) -> bool:
    rp = "/" + rel_path.lower().replace("\\", "/") + "/"
    return any(seg in rp for seg in IGNORE_PATH_SEGMENTS)


def is_under_allowed_root(rel_path: str, code_roots: List[str]) -> bool:
    rp = rel_path.lower().replace("\\", "/").strip("/")
    for root in code_roots:
        rr = root.lower().replace("\\", "/").strip("/")
        if rp == rr or rp.startswith(rr + "/"):
            return True
    return False


def classify_subsystem(rel_path: str, mapping: Dict[str, List[str]]) -> str:
    rp = rel_path.lower().replace("\\", "/")
    matches: List[Tuple[str, int]] = []
    for subsystem, prefixes in mapping.items():
        for prefix in prefixes:
            p = prefix.lower().replace("\\", "/").strip("/")
            if rp == p or rp.startswith(p + "/"):
                matches.append((subsystem, len(p)))
    if not matches:
        return "unclassified"
    matches.sort(key=lambda x: x[1], reverse=True)
    return matches[0][0]


def discover_python_files(repo: Path, code_roots: List[str]) -> List[Path]:
    found: List[Path] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        root_path = Path(root)
        try:
            rel_root = posix_rel(repo, root_path)
        except Exception:
            continue
        if rel_root != "." and path_contains_ignored_segment(rel_root):
            dirs[:] = []
            continue

        for name in files:
            if not name.endswith(".py"):
                continue
            p = root_path / name
            rel = posix_rel(repo, p)
            if path_contains_ignored_segment(rel):
                continue
            if not is_under_allowed_root(rel, code_roots):
                continue
            found.append(p)
    return sorted(found)


def discover_named_files(repo: Path, names: Iterable[str], code_roots: List[str]) -> List[Path]:
    wanted = set(names)
    found: List[Path] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        root_path = Path(root)
        try:
            rel_root = posix_rel(repo, root_path)
        except Exception:
            continue
        if rel_root != "." and path_contains_ignored_segment(rel_root):
            dirs[:] = []
            continue
        for name in files:
            if name not in wanted:
                continue
            p = root_path / name
            rel = posix_rel(repo, p)
            if path_contains_ignored_segment(rel):
                continue
            if not is_under_allowed_root(rel, code_roots):
                continue
            found.append(p)
    return sorted(found)


def discover_suffix_files(repo: Path, suffixes: Iterable[str], code_roots: List[str]) -> List[Path]:
    suffixes = tuple(suffixes)
    found: List[Path] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        root_path = Path(root)
        try:
            rel_root = posix_rel(repo, root_path)
        except Exception:
            continue
        if rel_root != "." and path_contains_ignored_segment(rel_root):
            dirs[:] = []
            continue
        for name in files:
            if not name.endswith(suffixes):
                continue
            p = root_path / name
            rel = posix_rel(repo, p)
            if path_contains_ignored_segment(rel):
                continue
            if not is_under_allowed_root(rel, code_roots):
                continue
            found.append(p)
    return sorted(found)


def extract_imports_from_python(path: Path) -> Tuple[Set[str], Optional[str]]:
    try:
        text = safe_read_text(path)
        tree = ast.parse(text, filename=str(path))
    except Exception as exc:
        return set(), f"{type(exc).__name__}: {exc}"

    imports: Set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                imports.add(node.module)
    return imports, None


def parse_requirements_file(path: Path) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in safe_read_text(path).splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = REQ_LINE_RE.match(s)
        if not m:
            continue
        name = m.group(1)
        spec = m.group(2) or ""
        out[name.lower()] = f"{name}{spec}".strip()
    return out


def parse_pyproject_dependencies(path: Path) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if tomllib is None:
        return out
    try:
        data = tomllib.loads(safe_read_text(path))
    except Exception:
        return out

    project = data.get("project", {})
    if isinstance(project, dict):
        for dep in project.get("dependencies", []) or []:
            if not isinstance(dep, str):
                continue
            base = re.split(r"[<>=!~\[]", dep, maxsplit=1)[0].strip()
            if base:
                out[base.lower()] = dep.strip()

    tool = data.get("tool", {})
    if isinstance(tool, dict):
        poetry = tool.get("poetry", {})
        if isinstance(poetry, dict):
            deps = poetry.get("dependencies", {})
            if isinstance(deps, dict):
                for pkg, spec in deps.items():
                    if str(pkg).lower() == "python":
                        continue
                    if isinstance(spec, str):
                        out[str(pkg).lower()] = f"{pkg}{spec}" if spec[:1].isdigit() is False else f"{pkg}=={spec}"
                    else:
                        out[str(pkg).lower()] = str(pkg)
    return out


def parse_setup_py_naive(path: Path) -> Dict[str, str]:
    out: Dict[str, str] = {}
    text = safe_read_text(path)
    m = re.search(r"install_requires\s*=\s*\[(.*?)\]", text, flags=re.DOTALL)
    if not m:
        return out
    for item in re.findall(r"['\"]([^'\"]+)['\"]", m.group(1)):
        base = re.split(r"[<>=!~\[]", item, maxsplit=1)[0].strip()
        if base:
            out[base.lower()] = item.strip()
    return out


def discover_manifest_dependencies(repo: Path, code_roots: List[str]) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    for p in discover_named_files(repo, ["requirements.txt", "requirements-dev.txt"], code_roots):
        out[posix_rel(repo, p)] = parse_requirements_file(p)
    for p in discover_named_files(repo, ["pyproject.toml"], code_roots):
        out[posix_rel(repo, p)] = parse_pyproject_dependencies(p)
    for p in discover_named_files(repo, ["setup.py"], code_roots):
        out[posix_rel(repo, p)] = parse_setup_py_naive(p)
    return out


def discover_freeze_sources(repo: Path, code_roots: List[str]) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    for p in discover_named_files(
        repo,
        ["pip_list.txt", "pip_freeze.txt", "venv_snapshot.txt", "requirements.lock", "requirements_frozen.txt"],
        code_roots,
    ):
        out[posix_rel(repo, p)] = parse_requirements_file(p)
    return out


def discover_launcher_files(repo: Path, code_roots: List[str]) -> List[Path]:
    return discover_suffix_files(repo, [".ps1", ".bat", ".sh", ".cmd", ".json"], code_roots)


def extract_runtime_hints(path: Path) -> Set[str]:
    text = safe_read_text(path).lower()
    markers = {
        "fastapi": "fastapi",
        "uvicorn": "uvicorn",
        "pydantic": "pydantic",
        "dotenv": "python-dotenv",
        "qdrant": "qdrant-client",
        "sentence-transformers": "sentence-transformers",
        "transformers": "transformers",
        "llama_cpp": "llama-cpp-python",
        "llama-cpp-python": "llama-cpp-python",
        "mem0": "mem0ai",
        "swisseph": "pyswisseph",
        "pyswisseph": "pyswisseph",
        "watchdog": "watchdog",
        "psutil": "psutil",
        "rich": "rich",
        "click": "click",
        "posthog": "posthog",
        "loguru": "loguru",
    }
    return {pkg for marker, pkg in markers.items() if marker in text}


def infer_versions_from_current_interpreter(packages: Set[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for pkg in packages:
        try:
            version = importlib.metadata.version(pkg)
            out[pkg.lower()] = version
        except Exception:
            pass
    return out


def analyze_imports(
    repo: Path,
    mapping: Dict[str, List[str]],
    code_roots: List[str],
) -> Dict[str, SubsystemResult]:
    stdlib_names = get_stdlib_names()
    results: Dict[str, SubsystemResult] = {
        k: SubsystemResult(subsystem=k) for k in DEFAULT_SUBSYSTEM_OUTPUTS
    }

    for py_file in discover_python_files(repo, code_roots):
        rel = posix_rel(repo, py_file)
        subsystem = classify_subsystem(rel, mapping)
        results.setdefault(subsystem, SubsystemResult(subsystem=subsystem))
        results[subsystem].files_scanned.append(rel)

        imports, _err = extract_imports_from_python(py_file)
        for mod in imports:
            if is_probably_stdlib(mod, stdlib_names):
                continue
            pkg = normalize_module_to_package(mod)
            ev = results[subsystem].packages.setdefault(
                pkg,
                PackageEvidence(
                    package=pkg,
                    subsystem=subsystem,
                    suspicious_utility=(pkg in SUSPICIOUS_UTILITY_PACKAGES),
                ),
            )
            ev.imported_by_files.add(rel)
            ev.imported_as_modules.add(mod)
            ev.confidence = "CONFIRMED"

    return results


def apply_manifest_evidence(
    repo: Path,
    results: Dict[str, SubsystemResult],
    mapping: Dict[str, List[str]],
    code_roots: List[str],
) -> None:
    manifests = discover_manifest_dependencies(repo, code_roots)
    for rel, deps in manifests.items():
        subsystem = classify_subsystem(rel, mapping)
        results.setdefault(subsystem, SubsystemResult(subsystem=subsystem))
        results[subsystem].manifest_files.append(rel)

        for pkg_lower, spec in deps.items():
            name = re.split(r"(==|~=|>=|<=|>|<|!=)", spec, maxsplit=1)[0].strip() or pkg_lower
            ev = results[subsystem].packages.setdefault(
                name,
                PackageEvidence(
                    package=name,
                    subsystem=subsystem,
                    suspicious_utility=(name in SUSPICIOUS_UTILITY_PACKAGES),
                ),
            )
            ev.manifest_sources.add(rel)
            ev.confidence = "CONFIRMED"
            m = re.search(r"(==|~=|>=|<=|>|<|!=)\s*(.+)$", spec)
            if m and ev.version is None:
                ev.version = m.group(2).strip()
                ev.version_source = f"manifest:{rel}"


def apply_launcher_evidence(
    repo: Path,
    results: Dict[str, SubsystemResult],
    mapping: Dict[str, List[str]],
    code_roots: List[str],
) -> None:
    for p in discover_launcher_files(repo, code_roots):
        rel = posix_rel(repo, p)
        subsystem = classify_subsystem(rel, mapping)
        hints = extract_runtime_hints(p)
        if not hints:
            continue
        results.setdefault(subsystem, SubsystemResult(subsystem=subsystem))
        results[subsystem].launcher_files.append(rel)
        for pkg in hints:
            ev = results[subsystem].packages.setdefault(
                pkg,
                PackageEvidence(
                    package=pkg,
                    subsystem=subsystem,
                    suspicious_utility=(pkg in SUSPICIOUS_UTILITY_PACKAGES),
                ),
            )
            ev.launcher_sources.add(rel)
            if ev.confidence != "CONFIRMED":
                ev.confidence = "PROBABLE"


def apply_version_pinning(
    repo: Path,
    results: Dict[str, SubsystemResult],
    code_roots: List[str],
    allow_current_interpreter: bool,
) -> None:
    freeze_sources = discover_freeze_sources(repo, code_roots)
    for result in results.values():
        for ev in result.packages.values():
            if ev.version is not None:
                continue
            for rel, pkgs in freeze_sources.items():
                spec = pkgs.get(ev.package.lower())
                if not spec:
                    continue
                m = re.search(r"(==|~=|>=|<=|>|<|!=)\s*(.+)$", spec)
                if m:
                    ev.version = m.group(2).strip()
                    ev.version_source = f"freeze:{rel}"
                    break

    if allow_current_interpreter:
        unresolved = {
            ev.package
            for result in results.values()
            for ev in result.packages.values()
            if ev.version is None
        }
        installed = infer_versions_from_current_interpreter(unresolved)
        for result in results.values():
            for ev in result.packages.values():
                if ev.version is None and ev.package.lower() in installed:
                    ev.version = installed[ev.package.lower()]
                    ev.version_source = "installed-metadata:current-interpreter"


def sort_evidence(result: SubsystemResult) -> List[PackageEvidence]:
    return sorted(result.packages.values(), key=lambda x: x.package.lower())


def write_plain_deps(path: Path, pkgs: List[PackageEvidence]) -> None:
    ensure_dir(path.parent)
    lines = [p.package for p in pkgs] or ["# No confirmed standalone Python dependencies identified from current evidence"]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_pinned_reqs(path: Path, pkgs: List[PackageEvidence]) -> None:
    ensure_dir(path.parent)
    if not pkgs:
        lines = ["# No confirmed standalone Python dependencies identified from current evidence"]
    else:
        lines = [f"{p.package}=={p.version}" if p.version else p.package for p in pkgs]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_report(out_dir: Path, repo: Path, results: Dict[str, SubsystemResult], write_pinned: bool) -> None:
    md = out_dir / "python_dependency_audit_report.md"
    js = out_dir / "python_dependency_audit.json"

    lines: List[str] = []
    lines.append("# Python Dependency Audit Report")
    lines.append("")
    lines.append(f"**Repository:** `{repo}`")
    lines.append("")
    for key, meta in DEFAULT_SUBSYSTEM_OUTPUTS.items():
        result = results.get(key)
        if result is None:
            continue
        pkgs = sort_evidence(result)
        lines.append(f"## {meta['title']}")
        lines.append("")
        lines.append(f"- Files scanned: **{len(result.files_scanned)}**")
        lines.append(f"- Packages: **{len(pkgs)}**")
        if result.manifest_files:
            lines.append(f"- Manifest files: {', '.join(f'`{x}`' for x in result.manifest_files)}")
        if result.launcher_files:
            lines.append(f"- Launcher files: {', '.join(f'`{x}`' for x in result.launcher_files)}")
        lines.append("")
        if pkgs:
            lines.append("| Package | Version | Confidence | Imported By | Manifest | Launcher |")
            lines.append("|---|---|---|---:|---:|---:|")
            for p in pkgs:
                lines.append(
                    f"| {p.package} | {p.version or ''} | {p.confidence} | "
                    f"{len(p.imported_by_files)} | {len(p.manifest_sources)} | {len(p.launcher_sources)} |"
                )
        else:
            lines.append("_No package evidence found._")
        lines.append("")

    md.write_text("\n".join(lines), encoding="utf-8")

    payload = {
        k: {
            "files_scanned": v.files_scanned,
            "manifest_files": v.manifest_files,
            "launcher_files": v.launcher_files,
            "packages": [
                {
                    "package": p.package,
                    "version": p.version,
                    "version_source": p.version_source,
                    "confidence": p.confidence,
                    "imported_by_files": sorted(p.imported_by_files),
                    "imported_as_modules": sorted(p.imported_as_modules),
                    "manifest_sources": sorted(p.manifest_sources),
                    "launcher_sources": sorted(p.launcher_sources),
                }
                for p in sort_evidence(v)
            ],
        }
        for k, v in results.items()
    }
    js.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate repo-bounded Python dependency audit.")
    parser.add_argument("--repo", required=True, help="Repository root")
    parser.add_argument("--out", default="docs/audit", help="Output directory")
    parser.add_argument("--mapping", default=None, help="Optional subsystem mapping JSON")
    parser.add_argument("--code-roots", default=None, help="Optional JSON list of scan roots")
    parser.add_argument("--write-pinned", action="store_true", help="Write pinned requirements files")
    parser.add_argument("--no-installed-metadata", action="store_true", help="Disable current interpreter version fallback")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not repo.is_dir():
        print(f"ERROR: invalid repo path: {repo}", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    if not out_dir.is_absolute():
        out_dir = repo / out_dir
    ensure_dir(out_dir)

    mapping = load_mapping_json(Path(args.mapping).resolve() if args.mapping else None)
    code_roots = load_code_roots(Path(args.code_roots).resolve() if args.code_roots else None)

    results = analyze_imports(repo, mapping, code_roots)
    apply_manifest_evidence(repo, results, mapping, code_roots)
    apply_launcher_evidence(repo, results, mapping, code_roots)
    apply_version_pinning(repo, results, code_roots, allow_current_interpreter=not args.no_installed_metadata)

    for key, meta in DEFAULT_SUBSYSTEM_OUTPUTS.items():
        result = results.get(key, SubsystemResult(subsystem=key))
        pkgs = sort_evidence(result)
        write_plain_deps(out_dir / meta["deps"], pkgs)
        if args.write_pinned:
            write_pinned_reqs(out_dir / meta["reqs"], pkgs)

    write_report(out_dir, repo, results, args.write_pinned)

    print("Python dependency audit complete.")
    print(f"Repository: {repo}")
    print(f"Output dir: {out_dir}")
    print("")
    for key, meta in DEFAULT_SUBSYSTEM_OUTPUTS.items():
        result = results.get(key, SubsystemResult(subsystem=key))
        print(f"{meta['title']}: {len(result.packages)} packages, {len(result.files_scanned)} files scanned")
        print(f"  - {meta['deps']}")
        if args.write_pinned:
            print(f"  - {meta['reqs']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())