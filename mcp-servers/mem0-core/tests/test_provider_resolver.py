"""
Tests for provider_resolver.py (Tala-injected config path)

Test cases
----------
PR01  TALA_MEMORY_RUNTIME_CONFIG_PATH not set -> returns None (canonical_only)
PR02  Config file missing -> returns None, no SystemExit
PR03  Config file present, full_memory -> returns valid dict
PR04  Config file present, canonical_plus_embeddings -> correct extraction/embed sections
PR05  stdout cleanliness: load_tala_runtime_config never writes to stdout
PR06  build_mem0_config_from_resolution: canonical_only -> None
PR07  build_mem0_config_from_resolution: ollama -> ollama providers
PR08  build_mem0_config_from_resolution: vllm -> openai provider
PR09  build_mem0_config_from_resolution: llamacpp -> openai provider
PR10  build_mem0_config_for_vllm returns openai providers (backward compat)
PR11  build_mem0_config_for_ollama returns ollama providers (backward compat)
PR12  No SystemExit on any path
PR13  Invalid JSON in config file -> returns None gracefully
"""

import sys
import io
import os
import json
import tempfile
import importlib
import unittest
from unittest.mock import patch


def _import_resolver():
    mem0_core_dir = os.path.join(os.path.dirname(__file__), "..")
    if mem0_core_dir not in sys.path:
        sys.path.insert(0, mem0_core_dir)
    import provider_resolver
    importlib.reload(provider_resolver)
    return provider_resolver


def _write_temp_config(data):
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh)
    return path


_FULL_MEMORY = {
    "mode": "full_memory",
    "resolvedAt": "2024-01-01T00:00:00.000Z",
    "extraction": {
        "enabled": True, "providerId": "ollama", "providerType": "ollama",
        "model": "qwen2.5:7b", "baseUrl": "http://127.0.0.1:11434", "reason": "deterministic_rank",
    },
    "embeddings": {
        "enabled": True, "providerId": "ollama", "providerType": "ollama",
        "model": "nomic-embed-text:latest", "baseUrl": "http://127.0.0.1:11434", "reason": "deterministic_rank",
    },
}

_CANONICAL_PLUS = {
    "mode": "canonical_plus_embeddings",
    "resolvedAt": "2024-01-01T00:00:00.000Z",
    "extraction": {"enabled": False, "providerId": None, "providerType": "none", "model": None, "reason": "no_provider_resolved"},
    "embeddings": {"enabled": True, "providerId": "ollama", "providerType": "ollama", "model": "nomic-embed-text:latest", "baseUrl": "http://127.0.0.1:11434", "reason": "deterministic_rank"},
}

_CANONICAL_ONLY = {
    "mode": "canonical_only",
    "resolvedAt": "2024-01-01T00:00:00.000Z",
    "extraction": {"enabled": False, "providerId": None, "providerType": "none", "model": None, "reason": "no_provider_resolved"},
    "embeddings": {"enabled": False, "providerId": None, "providerType": "none", "model": None, "reason": "no_embedding_provider_resolved"},
}

_VLLM_FULL = {
    "mode": "full_memory",
    "resolvedAt": "2024-01-01T00:00:00.000Z",
    "extraction": {"enabled": True, "providerId": "vllm", "providerType": "vllm", "model": "mistral-7b", "baseUrl": "http://127.0.0.1:8000", "reason": "deterministic_rank"},
    "embeddings": {"enabled": True, "providerId": "vllm", "providerType": "vllm", "model": "mistral-7b", "baseUrl": "http://127.0.0.1:8000", "reason": "deterministic_rank"},
}

_LLAMACPP_FULL = {
    "mode": "full_memory",
    "resolvedAt": "2024-01-01T00:00:00.000Z",
    "extraction": {"enabled": True, "providerId": "llamacpp", "providerType": "llamacpp", "model": "llama-3.1-8b", "baseUrl": "http://127.0.0.1:8080", "reason": "deterministic_rank"},
    "embeddings": {"enabled": True, "providerId": "llamacpp", "providerType": "llamacpp", "model": "llama-3.1-8b", "baseUrl": "http://127.0.0.1:8080", "reason": "deterministic_rank"},
}


class TestEnvVarNotSet(unittest.TestCase):
    """PR01: TALA_MEMORY_RUNTIME_CONFIG_PATH absent -> None."""
    def setUp(self):
        self.r = _import_resolver()
    def _run(self):
        env = {k: v for k, v in os.environ.items() if k != "TALA_MEMORY_RUNTIME_CONFIG_PATH"}
        with patch.dict(os.environ, env, clear=True):
            return self.r.load_tala_runtime_config()
    def test_returns_none(self):
        self.assertIsNone(self._run())
    def test_no_system_exit(self):
        try: self._run()
        except SystemExit: self.fail("raised SystemExit")
    def test_no_stdout(self):
        cap = io.StringIO()
        with patch("sys.stdout", cap): self._run()
        self.assertEqual(cap.getvalue(), "")


class TestMissingFile(unittest.TestCase):
    """PR02: path set but file missing -> None."""
    def setUp(self):
        self.r = _import_resolver()
    def _run(self):
        with patch.dict(os.environ, {"TALA_MEMORY_RUNTIME_CONFIG_PATH": "/no/such/file.json"}):
            return self.r.load_tala_runtime_config()
    def test_returns_none(self):
        self.assertIsNone(self._run())
    def test_no_system_exit(self):
        try: self._run()
        except SystemExit: self.fail("raised SystemExit")


class TestFullMemoryFile(unittest.TestCase):
    """PR03: valid full_memory file -> dict with correct mode."""
    def setUp(self):
        self.r = _import_resolver()
        self.p = _write_temp_config(_FULL_MEMORY)
    def tearDown(self):
        os.unlink(self.p)
    def _run(self):
        with patch.dict(os.environ, {"TALA_MEMORY_RUNTIME_CONFIG_PATH": self.p}):
            return self.r.load_tala_runtime_config()
    def test_returns_dict(self):
        self.assertIsInstance(self._run(), dict)
    def test_mode_full_memory(self):
        self.assertEqual(self._run()["mode"], "full_memory")
    def test_no_stdout(self):
        cap = io.StringIO()
        with patch("sys.stdout", cap): self._run()
        self.assertEqual(cap.getvalue(), "")


class TestCanonicalPlusFile(unittest.TestCase):
    """PR04: canonical_plus_embeddings -> extraction disabled, embeddings enabled."""
    def setUp(self):
        self.r = _import_resolver()
        self.p = _write_temp_config(_CANONICAL_PLUS)
    def tearDown(self):
        os.unlink(self.p)
    def _run(self):
        with patch.dict(os.environ, {"TALA_MEMORY_RUNTIME_CONFIG_PATH": self.p}):
            return self.r.load_tala_runtime_config()
    def test_extraction_disabled(self):
        self.assertFalse(self._run()["extraction"]["enabled"])
    def test_embeddings_enabled(self):
        self.assertTrue(self._run()["embeddings"]["enabled"])


class TestInvalidJsonFile(unittest.TestCase):
    """PR13: invalid JSON -> None gracefully."""
    def setUp(self):
        self.r = _import_resolver()
        fd, self.p = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            fh.write("not-valid-json{{{")
    def tearDown(self):
        os.unlink(self.p)
    def test_returns_none(self):
        with patch.dict(os.environ, {"TALA_MEMORY_RUNTIME_CONFIG_PATH": self.p}):
            result = self.r.load_tala_runtime_config()
        self.assertIsNone(result)
    def test_no_system_exit(self):
        with patch.dict(os.environ, {"TALA_MEMORY_RUNTIME_CONFIG_PATH": self.p}):
            try: self.r.load_tala_runtime_config()
            except SystemExit: self.fail("raised SystemExit")


class TestBuildConfigCanonicalOnly(unittest.TestCase):
    """PR06: canonical_only -> None."""
    def setUp(self):
        self.r = _import_resolver()
    def test_returns_none(self):
        self.assertIsNone(self.r.build_mem0_config_from_resolution(_CANONICAL_ONLY))


class TestBuildConfigOllama(unittest.TestCase):
    """PR07: full_memory ollama -> ollama llm and embedder."""
    def setUp(self):
        self.r = _import_resolver()
        self.cfg = self.r.build_mem0_config_from_resolution(_FULL_MEMORY)
    def test_llm_provider_ollama(self):
        self.assertEqual(self.cfg["llm"]["provider"], "ollama")
    def test_embedder_provider_ollama(self):
        self.assertEqual(self.cfg["embedder"]["provider"], "ollama")
    def test_vector_store_qdrant(self):
        self.assertEqual(self.cfg["vector_store"]["provider"], "qdrant")


class TestBuildConfigVllm(unittest.TestCase):
    """PR08: vllm resolution -> openai provider."""
    def setUp(self):
        self.r = _import_resolver()
        self.cfg = self.r.build_mem0_config_from_resolution(_VLLM_FULL)
    def test_llm_provider_openai(self):
        self.assertEqual(self.cfg["llm"]["provider"], "openai")
    def test_embedder_provider_openai(self):
        self.assertEqual(self.cfg["embedder"]["provider"], "openai")
    def test_base_url_contains_8000(self):
        self.assertIn("8000", self.cfg["llm"]["config"]["openai_api_base"])


class TestBuildConfigLlamaCpp(unittest.TestCase):
    """PR09: llamacpp resolution -> openai provider."""
    def setUp(self):
        self.r = _import_resolver()
        self.cfg = self.r.build_mem0_config_from_resolution(_LLAMACPP_FULL)
    def test_llm_provider_openai(self):
        self.assertEqual(self.cfg["llm"]["provider"], "openai")
    def test_base_url_contains_8080(self):
        self.assertIn("8080", self.cfg["llm"]["config"]["openai_api_base"])


class TestBackwardCompatVllmBuilder(unittest.TestCase):
    """PR10: build_mem0_config_for_vllm returns openai providers."""
    def setUp(self):
        self.r = _import_resolver()
        self.cfg = self.r.build_mem0_config_for_vllm("http://127.0.0.1:8000", "my-model")
    def test_llm_provider_openai(self):
        self.assertEqual(self.cfg["llm"]["provider"], "openai")
    def test_embedder_provider_openai(self):
        self.assertEqual(self.cfg["embedder"]["provider"], "openai")
    def test_vector_store_qdrant(self):
        self.assertEqual(self.cfg["vector_store"]["provider"], "qdrant")


class TestBackwardCompatOllamaBuilder(unittest.TestCase):
    """PR11: build_mem0_config_for_ollama returns ollama providers."""
    def setUp(self):
        self.r = _import_resolver()
        self.cfg = self.r.build_mem0_config_for_ollama()
    def test_llm_provider_ollama(self):
        self.assertEqual(self.cfg["llm"]["provider"], "ollama")
    def test_embedder_provider_ollama(self):
        self.assertEqual(self.cfg["embedder"]["provider"], "ollama")
    def test_vector_store_qdrant(self):
        self.assertEqual(self.cfg["vector_store"]["provider"], "qdrant")


class TestCanonicalPlusEmbeddingsConfig(unittest.TestCase):
    """PR04b: canonical_plus_embeddings -> no llm section, embedder present."""
    def setUp(self):
        self.r = _import_resolver()
        self.cfg = self.r.build_mem0_config_from_resolution(_CANONICAL_PLUS)
    def test_cfg_is_not_none(self):
        self.assertIsNotNone(self.cfg)
    def test_embedder_is_present(self):
        self.assertIn("embedder", self.cfg)
    def test_llm_section_absent(self):
        self.assertNotIn("llm", self.cfg)


if __name__ == "__main__":
    unittest.main()
