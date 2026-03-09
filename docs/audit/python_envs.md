# Tala Python Environments Audit

This document details the Python virtual environments and dependency sets discovered in the repository.

## Discovered Environments

| Location | Role | Manifest | Main Dependencies |
| :--- | :--- | :--- | :--- |
| Root | Global/Master Requirements | `MASTER_PYTHON_REQUIREMENTS.txt` | `fastapi`, `uvicorn`, `mem0ai`, `llama-cpp-python` |
| `local-inference/venv/` | Local LLM Runner | `local-inference/requirements.txt` | `llama-cpp-python` (v0.3.16), `numpy` (v2.4.2), `fastapi` |
| `mcp-servers/astro-engine/` | MCP: Astrology | `requirements.txt` | `pyswisseph`, `swisseph`, `mcp` |
| `mcp-servers/mem0-core/` | MCP: Mem0 Interaction | `requirements.txt` | `mem0ai`, `mcp` |
| `mcp-servers/tala-core/venv/` | MCP: RAG & Core Analytics | `requirements.txt` | `sentence-transformers`, `huggingface_hub`, `transformers` |
| `mcp-servers/tala-memory-graph/.venv/` | MCP: Memory Graph | `pyproject.toml` | `mcp`, `fastmcp`, `pydantic` |
| `bin/python-win/` | Bundled Distribution | N/A | Full Python 3.13 distribution for portable execution. |

## License Identification (Major Dependencies)

| Dependency | License |
| :--- | :--- |
| `fastapi` | MIT |
| `uvicorn` | BSD-3-Clause |
| `pydantic` | MIT |
| `numpy` | BSD-3-Clause |
| `llama-cpp-python` | MIT |
| `mem0ai` | MIT |
| `transformers` | Apache-2.0 |
| `sentence-transformers` | Apache-2.0 |
| `huggingface_hub` | Apache-2.0 |
| `mcp` | MIT |
| `pyswisseph` | AGPL-3.0 (Swiss Ephemeris) |
| `PyYAML` | MIT |

> [!NOTE]
> `pyswisseph` depends on the Swiss Ephemeris which is licensed under AGPL-3.0 for free use.
