#!/usr/bin/env python3
"""
Tala-managed embedded vLLM launcher.

Windows path is intentionally uvloop-free. If the installed vLLM build still
hard-depends on uvloop in its OpenAI API entrypoint, this script exits with a
clear diagnostic instead of surfacing a raw ModuleNotFoundError.
"""

from __future__ import annotations

import importlib.util
import platform
import subprocess
import sys
from pathlib import Path


def _log(message: str) -> None:
    print(f"[VLLM] {message}", flush=True)


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _entrypoint_requires_uvloop() -> bool:
    spec = importlib.util.find_spec("vllm.entrypoints.openai.api_server")
    if spec is None or spec.origin is None:
        return False

    entrypoint = Path(spec.origin)
    if not entrypoint.exists():
        return False

    try:
        source = entrypoint.read_text(encoding="utf-8")
    except OSError:
        return False

    return "import uvloop" in source


def main(argv: list[str]) -> int:
    is_windows = platform.system().lower().startswith("win")

    if is_windows:
        _log("Windows embedded_vllm path uses standard asyncio; uvloop is not required.")
        if _entrypoint_requires_uvloop() and not _module_available("uvloop"):
            _log(
                "Embedded vLLM unavailable: the installed vLLM OpenAI API entrypoint "
                "requires uvloop, but uvloop is not supported on Windows."
            )
            _log(
                "Use ollama as primary provider or install a Windows-compatible "
                "vLLM build that does not require uvloop for API startup."
            )
            return 2

    launch_command = [sys.executable, "-m", "vllm.entrypoints.openai.api_server", *argv]
    return subprocess.call(launch_command)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
