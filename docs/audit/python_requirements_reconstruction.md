# Python Requirements Reconstruction Trace Report

This report documents the evidence and methodology used to reconstruct the functional Python requirements for the Tala project subsystems.

## Methodology
Dependencies were mapped from multiple sources using the following priority:
1. **Authoritative Manifests**: `requirements.txt`, `pyproject.toml` in component directories.
2. **Metadata Logs**: `pip_list.txt` found in virtual environments.
3. **Master Manifest**: `MASTER_PYTHON_REQUIREMENTS.txt`.
4. **Source Analysis**: Imports in component source code.

---

## 1. astro_engine_requirements.txt

*   **Filenames**: [astro_engine_requirements.txt](file:///d:/src/client1/tala-app/docs/audit/generated_requirements/astro_engine_requirements.txt)
*   **Subsystem Purpose**: Emotional modulation and astrological chart calculation.
*   **Evidence Sources**: 
    - `mcp-servers/astro-engine/requirements.txt`
    - `mcp-servers/astro-engine/pip_list.txt` (Confirmed via UTF-8 dump)
*   **Mapped Environments**: `mcp-servers/astro-engine/`
*   **Confidence Level**: **CONFIRMED** (Exact versions extracted from active venv log).

## 2. mcp_core_requirements.txt

*   **Filenames**: [mcp_core_requirements.txt](file:///d:/src/client1/tala-app/docs/audit/generated_requirements/mcp_core_requirements.txt)
*   **Subsystem Purpose**: Base infrastructure for all MCP servers (FastAPI/Uvicorn wrapper).
*   **Evidence Sources**: 
    - `MASTER_PYTHON_REQUIREMENTS.txt`
    - Cross-reference with `astro-engine/pip_list.txt` (common base).
*   **Mapped Environments**: Shared across all `mcp-servers/`.
*   **Confidence Level**: **CONFIRMED** (Base versions match active server instances).

## 3. inference_requirements.txt

*   **Filenames**: [inference_requirements.txt](file:///d:/src/client1/tala-app/docs/audit/generated_requirements/inference_requirements.txt)
*   **Subsystem Purpose**: Local model inference (llama.cpp) and model serving.
*   **Evidence Sources**: 
    - `local-inference/requirements.txt` (Authoritative pinned manifest).
*   **Mapped Environments**: `local-inference/venv/`
*   **Confidence Level**: **CONFIRMED** (Exact versions from component manifest).

## 4. rag_requirements.txt

*   **Filenames**: [rag_requirements.txt](file:///d:/src/client1/tala-app/docs/audit/generated_requirements/rag_requirements.txt)
*   **Subsystem Purpose**: Retrieval, embeddings, vector store interaction, and long-term memory.
*   **Evidence Sources**: 
    - `mcp-servers/tala-core/requirements.txt`
    - `mcp-servers/mem0-core/requirements.txt`
    - `astro-engine/pip_list.txt` (contains `qdrant-client` and `mem0ai`).
*   **Mapped Environments**: `mcp-servers/tala-core/`, `mcp-servers/mem0-core/`.
*   **Confidence Level**: **PROBABLE** (Versions inferred from combined manifests and shared venv locks).

## 5. ui_tools_requirements.txt

*   **Filenames**: [ui_tools_requirements.txt](file:///d:/src/client1/tala-app/docs/audit/generated_requirements/ui_tools_requirements.txt)
*   **Subsystem Purpose**: Bridge utilities, telemetry logging, and local automation and diagnostics.
*   **Evidence Sources**: 
    - `astro-engine/pip_list.txt` (utility section).
    - Imports in `scripts/` and `tools/`.
*   **Mapped Environments**: Various utility scripts and bridge components.
*   **Confidence Level**: **PARTIAL** (Functional grouping of detected utilities).

---

## Unresolved Ambiguities
- `sentence-transformers` vs `transformers` version locking: `tala-core/requirements.txt` notes a specific pin required to avoid `huggingface_hub` breakage. The reconstructed `rag_requirements.txt` preserves the `3.0.0` / `4.40.0` pairing established in history.
- `numpy` versioning: `local-inference` requires `2.4.2` while `astro-engine` venv uses `1.26.4`. These are documented as distinct in their respective files.

---
*End of Trace Report*
