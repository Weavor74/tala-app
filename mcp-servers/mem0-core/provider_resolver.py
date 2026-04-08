"""Provider resolution for mem0-core.

This module reads the Tala-injected MemoryRuntimeResolution config and converts
it into a mem0 config dict.  It never probes inference endpoints directly —
provider discovery belongs in Tala's ProviderSelectionService / MemoryProviderResolver.

Config injection
----------------
Tala writes a MemoryRuntimeResolution JSON file before launching mem0-core and
passes its path via TALA_MEMORY_RUNTIME_CONFIG_PATH.  If that env var is absent
(e.g. standalone testing), the module falls back to canonical_only mode.

This module NEVER prompts on stdin, NEVER calls sys.exit, and NEVER raises
SystemExit.  All errors are caught and logged to stderr.
"""

import sys
import os
import json as _json
from typing import Dict, Optional, Tuple

# ---------------------------------------------------------------------------
# Tala-injected runtime config
# ---------------------------------------------------------------------------

def load_tala_runtime_config() -> Optional[Dict]:
    """
    Load the MemoryRuntimeResolution JSON written by Tala before mem0-core starts.

    Returns the parsed dict on success, or None if the env var is absent or the
    file cannot be read.  Never raises.
    """
    config_path = os.environ.get("TALA_MEMORY_RUNTIME_CONFIG_PATH", "").strip()
    if not config_path:
        sys.stderr.write(
            "[mem0-core] TALA_MEMORY_RUNTIME_CONFIG_PATH not set; "
            "running in canonical_only mode.\n"
        )
        return None

    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            data = _json.load(fh)
        sys.stderr.write("[mem0-core] Loaded Tala memory runtime config\n")
        return data
    except FileNotFoundError:
        sys.stderr.write(
            f"[mem0-core] Runtime config file not found: {config_path}; "
            "running in canonical_only mode.\n"
        )
        return None
    except Exception as exc:
        sys.stderr.write(
            f"[mem0-core] Failed to load runtime config ({type(exc).__name__}: {exc}); "
            "running in canonical_only mode.\n"
        )
        return None


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
    Return a mem0 config dict that routes LLM calls through a
    vLLM OpenAI-compatible endpoint.
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


def build_mem0_config_for_llamacpp(endpoint: str, model: Optional[str] = None) -> Dict:
    """Return a mem0 config dict that routes through a llama.cpp OpenAI-compatible server."""
    base_url = endpoint.rstrip("/") + "/v1"
    llm_model = model or "local-model"
    return {
        "vector_store": _qdrant_vector_store(),
        "embedder": {
            "provider": "openai",
            "config": {
                "model": llm_model,
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


def build_mem0_config_from_resolution(resolution: Dict) -> Optional[Dict]:
    """
    Build a mem0 config dict from a MemoryRuntimeResolution dict injected by Tala.

    Returns None when mode is canonical_only (no provider available).

    The resolution shape is:
    {
        "extraction": { "enabled": bool, "providerType": str, "model": str|null, "baseUrl": str|null, ... },
        "embeddings": { "enabled": bool, "providerType": str, "model": str|null, "baseUrl": str|null, ... },
        "mode": "canonical_only" | "canonical_plus_embeddings" | "full_memory",
        "resolvedAt": str
    }
    """
    mode = resolution.get("mode", "canonical_only")
    extraction = resolution.get("extraction", {})
    embeddings = resolution.get("embeddings", {})

    sys.stderr.write(f"[mem0-core] Mode: {mode}\n")

    if mode == "canonical_only":
        sys.stderr.write("[mem0-core] Extraction provider: none\n")
        sys.stderr.write("[mem0-core] Embedding provider: none\n")
        return None

    # Determine extraction config (LLM side)
    llm_config = _build_llm_section(extraction)

    # Determine embedder config
    embedder_config = _build_embedder_section(embeddings)

    ext_type = extraction.get("providerType", "none")
    ext_model = extraction.get("model") or "none"
    emb_type = embeddings.get("providerType", "none")
    emb_model = embeddings.get("model") or "none"
    sys.stderr.write(f"[mem0-core] Extraction provider: {ext_type} / {ext_model}\n")
    sys.stderr.write(f"[mem0-core] Embedding provider: {emb_type} / {emb_model}\n")

    if llm_config is None and embedder_config is None:
        return None

    cfg: Dict = {"vector_store": _qdrant_vector_store()}
    if llm_config is not None:
        cfg["llm"] = llm_config
    if embedder_config is not None:
        cfg["embedder"] = embedder_config

    return cfg


def _build_llm_section(backend: Dict) -> Optional[Dict]:
    """Build the mem0 'llm' config section from a ResolvedMemoryBackend dict."""
    if not backend.get("enabled"):
        return None

    provider_type = backend.get("providerType", "none")
    model = backend.get("model") or "default"
    base_url = backend.get("baseUrl", "")

    if provider_type == "ollama":
        return {
            "provider": "ollama",
            "config": {"model": model},
        }
    elif provider_type in ("vllm", "llamacpp", "openai_compatible", "other"):
        api_base = (base_url.rstrip("/") + "/v1") if base_url else "http://127.0.0.1:8080/v1"
        return {
            "provider": "openai",
            "config": {
                "model": model,
                "openai_api_key": "local",
                "openai_api_base": api_base,
            },
        }
    elif provider_type in ("openai", "anthropic", "gemini"):
        cfg: Dict = {"provider": provider_type, "config": {"model": model}}
        if base_url:
            cfg["config"]["openai_api_base"] = base_url
        api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("TALA_CLOUD_API_KEY")
        if api_key:
            cfg["config"]["openai_api_key"] = api_key
        return cfg

    return None


def _build_embedder_section(backend: Dict) -> Optional[Dict]:
    """Build the mem0 'embedder' config section from a ResolvedMemoryBackend dict."""
    if not backend.get("enabled"):
        return None

    provider_type = backend.get("providerType", "none")
    model = backend.get("model") or "nomic-embed-text:latest"
    base_url = backend.get("baseUrl", "")
    dimensions = backend.get("dimensions")

    if provider_type == "ollama":
        cfg: Dict = {
            "provider": "ollama",
            "config": {"model": model},
        }
        if dimensions:
            cfg["config"]["embedding_dims"] = dimensions
        return cfg
    elif provider_type in ("vllm", "llamacpp", "openai_compatible", "other"):
        api_base = (base_url.rstrip("/") + "/v1") if base_url else "http://127.0.0.1:8080/v1"
        cfg = {
            "provider": "openai",
            "config": {
                "model": model,
                "openai_api_key": "local",
                "openai_api_base": api_base,
            },
        }
        if dimensions:
            cfg["config"]["embedding_dims"] = dimensions
        return cfg
    elif provider_type in ("openai", "anthropic", "gemini"):
        cfg = {"provider": provider_type, "config": {"model": model}}
        if base_url:
            cfg["config"]["openai_api_base"] = base_url
        api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("TALA_CLOUD_API_KEY")
        if api_key:
            cfg["config"]["openai_api_key"] = api_key
        if dimensions:
            cfg["config"]["embedding_dims"] = dimensions
        return cfg

    return None


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
