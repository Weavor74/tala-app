"""Provider resolution for mem0-core.

Priority order
--------------
1. ollama        — Python 'ollama' library importable AND Ollama HTTP service
                   is reachable at the configured endpoint.
2. embedded_vllm — vLLM HTTP service is reachable at the configured endpoint.
3. degraded      — neither provider is available; the MCP server stays alive
                   but returns safe empty/error responses for memory operations.

This module NEVER prompts on stdin, NEVER calls sys.exit, and NEVER raises
SystemExit.  All errors are caught and logged to stderr.
"""

import sys
import os
from typing import Dict, Optional, Tuple

try:
    import urllib.request
    import urllib.error
    import json as _json
except ImportError:  # pragma: no cover — stdlib always present
    pass

# ---------------------------------------------------------------------------
# Ollama Python library detection (import-time, once)
# ---------------------------------------------------------------------------

try:
    import ollama as _ollama_pkg  # noqa: F401
    OLLAMA_LIB_AVAILABLE = True
except ImportError:
    OLLAMA_LIB_AVAILABLE = False

# ---------------------------------------------------------------------------
# Endpoint defaults (overridable via env vars)
# ---------------------------------------------------------------------------

_DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434"
_DEFAULT_VLLM_ENDPOINT = "http://127.0.0.1:8000"


def _get_ollama_endpoint() -> str:
    return os.environ.get("OLLAMA_HOST", _DEFAULT_OLLAMA_ENDPOINT).rstrip("/")


def _get_vllm_endpoint() -> str:
    return (
        os.environ.get("TALA_VLLM_ENDPOINT")
        or os.environ.get("VLLM_BASE_URL")
        or _DEFAULT_VLLM_ENDPOINT
    ).rstrip("/")


# ---------------------------------------------------------------------------
# HTTP probes — never raise, always return bool / (bool, str|None)
# ---------------------------------------------------------------------------

def _probe_ollama(endpoint: Optional[str] = None, timeout: int = 3) -> bool:
    """Return True if the Ollama HTTP service responds at /api/tags."""
    url = (endpoint or _get_ollama_endpoint()) + "/api/tags"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _probe_vllm(endpoint: Optional[str] = None, timeout: int = 3) -> Tuple[bool, Optional[str]]:
    """
    Probe the vLLM OpenAI-compatible /v1/models endpoint.

    Returns
    -------
    (available: bool, first_model: str | None)
    """
    url = (endpoint or _get_vllm_endpoint()) + "/v1/models"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            if resp.status != 200:
                return False, None
            data = _json.loads(resp.read().decode())
            models = data.get("data", [])
            first = models[0]["id"] if models else None
            return True, first
    except Exception:
        return False, None


# ---------------------------------------------------------------------------
# Public resolver
# ---------------------------------------------------------------------------

def resolve_inference_backend(
    ollama_endpoint: Optional[str] = None,
    vllm_endpoint: Optional[str] = None,
) -> Tuple[str, Dict]:
    """
    Determine which inference backend is available.

    Returns
    -------
    (backend: str, info: dict)

    backend is one of:
      "ollama"        — Ollama Python library present and service running.
      "embedded_vllm" — vLLM service reachable at configured endpoint.
      "degraded"      — Neither provider is available.

    info contains endpoint/model metadata for the resolved backend.
    """
    resolved_ollama_ep = ollama_endpoint or _get_ollama_endpoint()
    resolved_vllm_ep = vllm_endpoint or _get_vllm_endpoint()

    # --- 1. Ollama ---
    if OLLAMA_LIB_AVAILABLE:
        if _probe_ollama(resolved_ollama_ep):
            sys.stderr.write(
                "[mem0-core] Provider check: ollama available\n"
            )
            return "ollama", {"endpoint": resolved_ollama_ep}
        else:
            sys.stderr.write(
                "[mem0-core] Provider check: ollama library present but service not running\n"
            )
    else:
        sys.stderr.write(
            "[mem0-core] Provider check: ollama unavailable "
            "(Python library not installed)\n"
        )

    # --- 2. Embedded vLLM ---
    sys.stderr.write(
        "[mem0-core] Ollama unavailable; attempting embedded local vLLM fallback.\n"
    )
    vllm_available, first_model = _probe_vllm(resolved_vllm_ep)
    if vllm_available:
        sys.stderr.write(
            f"[mem0-core] Provider check: embedded local vLLM available "
            f"at {resolved_vllm_ep}\n"
        )
        return "embedded_vllm", {
            "endpoint": resolved_vllm_ep,
            "model": first_model,
        }

    sys.stderr.write(
        f"[mem0-core] Embedded local vLLM unavailable at {resolved_vllm_ep}; "
        "running in degraded mode.\n"
    )

    # --- 3. Degraded ---
    return "degraded", {}


# ---------------------------------------------------------------------------
# mem0 config builders
# ---------------------------------------------------------------------------

_QDRANT_PATH = os.path.join(os.getcwd(), "data", "qdrant_db")

def _qdrant_vector_store() -> dict:
    return {
        "provider": "qdrant",
        "config": {"path": _QDRANT_PATH},
    }


def build_mem0_config_for_ollama(endpoint: Optional[str] = None) -> Dict:
    """Return a mem0 config dict that uses Ollama for LLM and embedder.

    The ``endpoint`` parameter is accepted for API symmetry but is not
    forwarded to mem0 because the Ollama provider reads the endpoint from
    the ``OLLAMA_HOST`` environment variable at runtime.
    """
    return {
        "vector_store": _qdrant_vector_store(),
        "embedder": {
            "provider": "ollama",
            "config": {"model": "nomic-embed-text:latest"},
        },
        "llm": {
            "provider": "ollama",
            "config": {"model": "huihui_ai/qwen3-abliterated:8b"},
        },
    }


def build_mem0_config_for_vllm(endpoint: str, model: Optional[str] = None) -> Dict:
    """
    Return a mem0 config dict that routes LLM calls through the embedded
    vLLM OpenAI-compatible endpoint.

    The embedder also uses the OpenAI-compatible endpoint; the embedding
    model name is taken from TALA_VLLM_EMBED_MODEL env var if set,
    otherwise the same model as the LLM is used (vLLM can serve both).
    """
    base_url = endpoint.rstrip("/") + "/v1"
    llm_model = (
        os.environ.get("TALA_VLLM_LLM_MODEL")
        or model
        or "default"
    )
    embed_model = (
        os.environ.get("TALA_VLLM_EMBED_MODEL")
        or llm_model
    )
    return {
        "vector_store": _qdrant_vector_store(),
        "embedder": {
            "provider": "openai",
            "config": {
                "model": embed_model,
                "openai_api_key": "local",
                "openai_api_base": base_url,
            },
        },
        "llm": {
            "provider": "openai",
            "config": {
                "model": llm_model,
                "openai_api_key": "local",
                "openai_api_base": base_url,
            },
        },
    }
