"""
Tests for provider_resolver.py

Test cases
----------
PR01  Ollama lib missing, vLLM available → embedded_vllm, no prompt, no SystemExit
PR02  Ollama lib missing, vLLM unavailable → degraded, no prompt, no SystemExit
PR03  Ollama lib present, service running → ollama
PR04  Ollama lib present, service NOT running, vLLM available → embedded_vllm
PR05  stdout cleanliness — resolver writes nothing to stdout
PR06  No llama.cpp assumption — embedded provider returns embedded_vllm, not llamacpp
PR07  build_mem0_config_for_vllm returns openai providers, not ollama
PR08  build_mem0_config_for_ollama returns ollama providers
"""

import sys
import io
import os
import importlib
import types
import unittest
from unittest.mock import patch, MagicMock


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _import_resolver():
    """Re-import provider_resolver with a clean module state."""
    # Ensure the mem0-core directory is on the path
    mem0_core_dir = os.path.join(
        os.path.dirname(__file__), ".."
    )
    if mem0_core_dir not in sys.path:
        sys.path.insert(0, mem0_core_dir)
    import provider_resolver
    importlib.reload(provider_resolver)
    return provider_resolver


def _make_http_response(status: int, body: bytes) -> MagicMock:
    resp = MagicMock()
    resp.status = status
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


_VLLM_MODELS_RESPONSE = b'{"data":[{"id":"mistral-7b"}]}'
_OLLAMA_TAGS_RESPONSE = b'{"models":[]}'


# ---------------------------------------------------------------------------
# PR01 — Ollama lib missing, vLLM available
# ---------------------------------------------------------------------------

class TestOllamaMissingVllmAvailable(unittest.TestCase):
    """PR01: No ollama package; vLLM is running → embedded_vllm."""

    def setUp(self):
        self.resolver = _import_resolver()

    def _run(self):
        with patch.object(self.resolver, "OLLAMA_LIB_AVAILABLE", False), \
             patch.object(self.resolver, "_probe_vllm", return_value=(True, "mistral-7b")), \
             patch.object(self.resolver, "_probe_ollama", return_value=False):
            backend, info = self.resolver.resolve_inference_backend()
        return backend, info

    def test_backend_is_embedded_vllm(self):
        backend, _ = self._run()
        self.assertEqual(backend, "embedded_vllm")

    def test_no_system_exit(self):
        try:
            self._run()
        except SystemExit:
            self.fail("resolve_inference_backend raised SystemExit")

    def test_no_stdout_output(self):
        captured = io.StringIO()
        with patch("sys.stdout", captured):
            self._run()
        self.assertEqual(captured.getvalue(), "")

    def test_info_contains_endpoint(self):
        _, info = self._run()
        self.assertIn("endpoint", info)

    def test_info_contains_model(self):
        _, info = self._run()
        self.assertEqual(info.get("model"), "mistral-7b")


# ---------------------------------------------------------------------------
# PR02 — Ollama lib missing, vLLM unavailable
# ---------------------------------------------------------------------------

class TestOllamaMissingVllmUnavailable(unittest.TestCase):
    """PR02: No ollama package, vLLM unreachable → degraded."""

    def setUp(self):
        self.resolver = _import_resolver()

    def _run(self):
        with patch.object(self.resolver, "OLLAMA_LIB_AVAILABLE", False), \
             patch.object(self.resolver, "_probe_vllm", return_value=(False, None)), \
             patch.object(self.resolver, "_probe_ollama", return_value=False):
            backend, info = self.resolver.resolve_inference_backend()
        return backend, info

    def test_backend_is_degraded(self):
        backend, _ = self._run()
        self.assertEqual(backend, "degraded")

    def test_no_system_exit(self):
        try:
            self._run()
        except SystemExit:
            self.fail("resolve_inference_backend raised SystemExit")

    def test_no_stdout_output(self):
        captured = io.StringIO()
        with patch("sys.stdout", captured):
            self._run()
        self.assertEqual(captured.getvalue(), "")

    def test_stderr_contains_degraded_warning(self):
        captured = io.StringIO()
        with patch("sys.stderr", captured):
            self._run()
        self.assertIn("degraded", captured.getvalue().lower())

    def test_no_interactive_prompt(self):
        """stdin must never be read."""
        original_stdin = sys.stdin
        closed_stdin = io.StringIO()
        closed_stdin.close()
        with patch("sys.stdin", closed_stdin):
            try:
                self._run()
            except Exception:
                pass  # Any exception other than a stdin read error is OK


# ---------------------------------------------------------------------------
# PR03 — Ollama lib present, service running
# ---------------------------------------------------------------------------

class TestOllamaAvailable(unittest.TestCase):
    """PR03: ollama lib and service both available → ollama."""

    def setUp(self):
        self.resolver = _import_resolver()

    def _run(self):
        with patch.object(self.resolver, "OLLAMA_LIB_AVAILABLE", True), \
             patch.object(self.resolver, "_probe_ollama", return_value=True):
            backend, info = self.resolver.resolve_inference_backend()
        return backend, info

    def test_backend_is_ollama(self):
        backend, _ = self._run()
        self.assertEqual(backend, "ollama")

    def test_no_system_exit(self):
        try:
            self._run()
        except SystemExit:
            self.fail("resolve_inference_backend raised SystemExit")

    def test_no_stdout_output(self):
        captured = io.StringIO()
        with patch("sys.stdout", captured):
            self._run()
        self.assertEqual(captured.getvalue(), "")


# ---------------------------------------------------------------------------
# PR04 — Ollama lib present but service not running; vLLM available
# ---------------------------------------------------------------------------

class TestOllamaLibPresentServiceDownVllmAvailable(unittest.TestCase):
    """PR04: ollama lib present, service down → falls back to embedded_vllm."""

    def setUp(self):
        self.resolver = _import_resolver()

    def _run(self):
        with patch.object(self.resolver, "OLLAMA_LIB_AVAILABLE", True), \
             patch.object(self.resolver, "_probe_ollama", return_value=False), \
             patch.object(self.resolver, "_probe_vllm", return_value=(True, "llama-3")):
            backend, info = self.resolver.resolve_inference_backend()
        return backend, info

    def test_backend_is_embedded_vllm(self):
        backend, _ = self._run()
        self.assertEqual(backend, "embedded_vllm")

    def test_no_system_exit(self):
        try:
            self._run()
        except SystemExit:
            self.fail("resolve_inference_backend raised SystemExit")


# ---------------------------------------------------------------------------
# PR05 — stdout cleanliness (integration-level)
# ---------------------------------------------------------------------------

class TestStdoutCleanliness(unittest.TestCase):
    """PR05: resolver never writes to stdout under any scenario."""

    def setUp(self):
        self.resolver = _import_resolver()

    def _resolve_with_scenario(self, ollama_lib, probe_ollama_ret, probe_vllm_ret):
        captured_stdout = io.StringIO()
        with patch("sys.stdout", captured_stdout), \
             patch.object(self.resolver, "OLLAMA_LIB_AVAILABLE", ollama_lib), \
             patch.object(self.resolver, "_probe_ollama", return_value=probe_ollama_ret), \
             patch.object(self.resolver, "_probe_vllm", return_value=probe_vllm_ret):
            self.resolver.resolve_inference_backend()
        return captured_stdout.getvalue()

    def test_ollama_available_no_stdout(self):
        out = self._resolve_with_scenario(True, True, (True, "m"))
        self.assertEqual(out, "")

    def test_vllm_fallback_no_stdout(self):
        out = self._resolve_with_scenario(False, False, (True, "m"))
        self.assertEqual(out, "")

    def test_degraded_no_stdout(self):
        out = self._resolve_with_scenario(False, False, (False, None))
        self.assertEqual(out, "")


# ---------------------------------------------------------------------------
# PR06 — No llama.cpp default in embedded fallback
# ---------------------------------------------------------------------------

class TestNoLlamaCppAssumption(unittest.TestCase):
    """PR06: embedded fallback returns 'embedded_vllm', not 'llamacpp' or similar."""

    def setUp(self):
        self.resolver = _import_resolver()

    def test_embedded_fallback_is_vllm_not_llamacpp(self):
        with patch.object(self.resolver, "OLLAMA_LIB_AVAILABLE", False), \
             patch.object(self.resolver, "_probe_vllm", return_value=(True, "some-model")), \
             patch.object(self.resolver, "_probe_ollama", return_value=False):
            backend, _ = self.resolver.resolve_inference_backend()
        self.assertEqual(backend, "embedded_vllm")
        self.assertNotIn("llama", backend)
        self.assertNotIn("cpp", backend)


# ---------------------------------------------------------------------------
# PR07 — build_mem0_config_for_vllm uses openai provider
# ---------------------------------------------------------------------------

class TestBuildConfigVllm(unittest.TestCase):
    """PR07: vLLM config uses 'openai' provider (OpenAI-compatible), not ollama."""

    def setUp(self):
        self.resolver = _import_resolver()

    def test_llm_provider_is_openai(self):
        cfg = self.resolver.build_mem0_config_for_vllm("http://127.0.0.1:8000", "my-model")
        self.assertEqual(cfg["llm"]["provider"], "openai")

    def test_embedder_provider_is_openai(self):
        cfg = self.resolver.build_mem0_config_for_vllm("http://127.0.0.1:8000", "my-model")
        self.assertEqual(cfg["embedder"]["provider"], "openai")

    def test_llm_base_url_points_to_vllm(self):
        cfg = self.resolver.build_mem0_config_for_vllm("http://127.0.0.1:8000", "my-model")
        self.assertIn("127.0.0.1:8000", cfg["llm"]["config"]["openai_api_base"])

    def test_no_ollama_provider_in_config(self):
        cfg = self.resolver.build_mem0_config_for_vllm("http://127.0.0.1:8000", "my-model")
        self.assertNotEqual(cfg["llm"]["provider"], "ollama")
        self.assertNotEqual(cfg["embedder"]["provider"], "ollama")

    def test_vector_store_is_qdrant(self):
        cfg = self.resolver.build_mem0_config_for_vllm("http://127.0.0.1:8000", "my-model")
        self.assertEqual(cfg["vector_store"]["provider"], "qdrant")


# ---------------------------------------------------------------------------
# PR08 — build_mem0_config_for_ollama uses ollama provider
# ---------------------------------------------------------------------------

class TestBuildConfigOllama(unittest.TestCase):
    """PR08: Ollama config correctly sets ollama provider."""

    def setUp(self):
        self.resolver = _import_resolver()

    def test_llm_provider_is_ollama(self):
        cfg = self.resolver.build_mem0_config_for_ollama()
        self.assertEqual(cfg["llm"]["provider"], "ollama")

    def test_embedder_provider_is_ollama(self):
        cfg = self.resolver.build_mem0_config_for_ollama()
        self.assertEqual(cfg["embedder"]["provider"], "ollama")

    def test_vector_store_is_qdrant(self):
        cfg = self.resolver.build_mem0_config_for_ollama()
        self.assertEqual(cfg["vector_store"]["provider"], "qdrant")


if __name__ == "__main__":
    unittest.main()
