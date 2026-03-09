# Python Dependency Audit Report

**Repository:** `D:\src\client1\tala-app`

## Astro Engine

- Files scanned: **40**
- Packages: **6**
- Manifest files: `mcp-servers/astro-engine/requirements.txt`, `mcp-servers/astro-engine/pyproject.toml`

| Package | Version | Confidence | Imported By | Manifest | Launcher |
|---|---|---|---:|---:|---:|
| astro_emotion_engine | 0.1.0 | CONFIRMED | 2 | 0 | 0 |
| mcp | 1.5.0 | CONFIRMED | 1 | 1 | 0 |
| pydantic | 2.0 | CONFIRMED | 6 | 2 | 0 |
| pyswisseph | 2.10.3.2 | CONFIRMED | 1 | 2 | 0 |
| python-dateutil | 2.9.0.post0 | CONFIRMED | 2 | 2 | 0 |
| pytz | 2025.2 | CONFIRMED | 1 | 2 | 0 |

## MCP Core

- Files scanned: **0**
- Packages: **0**

_No package evidence found._

## Inference

- Files scanned: **0**
- Packages: **24**
- Manifest files: `local-inference/requirements.txt`

| Package | Version | Confidence | Imported By | Manifest | Launcher |
|---|---|---|---:|---:|---:|
| annotated-doc | 0.0.4 | CONFIRMED | 0 | 1 | 0 |
| annotated-types | 0.7.0 | CONFIRMED | 0 | 1 | 0 |
| anyio | 4.12.1 | CONFIRMED | 0 | 1 | 0 |
| click | 8.3.1 | CONFIRMED | 0 | 1 | 0 |
| colorama | 0.4.6 | CONFIRMED | 0 | 1 | 0 |
| diskcache | 5.6.3 | CONFIRMED | 0 | 1 | 0 |
| fastapi | 0.129.0 | CONFIRMED | 0 | 1 | 0 |
| h11 | 0.16.0 | CONFIRMED | 0 | 1 | 0 |
| idna | 3.11 | CONFIRMED | 0 | 1 | 0 |
| Jinja2 | 3.1.6 | CONFIRMED | 0 | 1 | 0 |
| llama_cpp_python | 0.3.16 | CONFIRMED | 0 | 1 | 0 |
| MarkupSafe | 3.0.3 | CONFIRMED | 0 | 1 | 0 |
| numpy | 2.4.2 | CONFIRMED | 0 | 1 | 0 |
| pydantic | 2.12.5 | CONFIRMED | 0 | 1 | 0 |
| pydantic-settings | 2.13.0 | CONFIRMED | 0 | 1 | 0 |
| pydantic_core | 2.41.5 | CONFIRMED | 0 | 1 | 0 |
| python-dotenv | 1.2.1 | CONFIRMED | 0 | 1 | 0 |
| PyYAML | 6.0.3 | CONFIRMED | 0 | 1 | 0 |
| sse-starlette | 3.2.0 | CONFIRMED | 0 | 1 | 0 |
| starlette | 0.52.1 | CONFIRMED | 0 | 1 | 0 |
| starlette-context | 0.3.6 | CONFIRMED | 0 | 1 | 0 |
| typing-inspection | 0.4.2 | CONFIRMED | 0 | 1 | 0 |
| typing_extensions | 4.15.0 | CONFIRMED | 0 | 1 | 0 |
| uvicorn | 0.40.0 | CONFIRMED | 0 | 1 | 0 |

## RAG

- Files scanned: **8**
- Packages: **15**
- Manifest files: `mcp-servers/mem0-core/requirements.txt`, `mcp-servers/tala-core/requirements.txt`
- Launcher files: `mcp-servers/mem0-core/data/qdrant_db/meta.json`, `mcp-servers/tala-core/data/simple_vector_store/metadata.json`

| Package | Version | Confidence | Imported By | Manifest | Launcher |
|---|---|---|---:|---:|---:|
| chromadb | 1.0.13 | CONFIRMED | 1 | 0 | 0 |
| click | 8.3.1 | PROBABLE | 0 | 0 | 1 |
| fastapi |  | CONFIRMED | 0 | 1 | 0 |
| huggingface_hub | 0.24.0,<0.26.0 | CONFIRMED | 0 | 1 | 0 |
| mcp | 1.5.0 | CONFIRMED | 2 | 0 | 0 |
| mem0ai | 1.0.2 | CONFIRMED | 5 | 1 | 2 |
| numpy | 1.26.4 | CONFIRMED | 1 | 1 | 0 |
| pydantic | 2.12.5 | CONFIRMED | 0 | 1 | 0 |
| python-dateutil | 2.9.0.post0 | CONFIRMED | 0 | 1 | 0 |
| PyYAML |  | CONFIRMED | 1 | 1 | 0 |
| rich | 14.0.0 | PROBABLE | 0 | 0 | 1 |
| sentence-transformers | 3.0.0,<4.0.0 | CONFIRMED | 1 | 1 | 0 |
| server |  | CONFIRMED | 1 | 0 | 0 |
| transformers | 4.40.0,<4.50.0 | CONFIRMED | 0 | 1 | 0 |
| uvicorn | 0.41.0 | CONFIRMED | 0 | 1 | 0 |

## UI Tools

- Files scanned: **3**
- Packages: **4**
- Launcher files: `scripts/assemble_universal.bat`, `scripts/launch-inference.bat`, `scripts/launch-inference.sh`, `scripts/make_portable.bat`, `scripts/make_portable.sh`, `scripts/make_portable_win.bat`, `scripts/make_universal.bat`, `scripts/setup_usb.bat`

| Package | Version | Confidence | Imported By | Manifest | Launcher |
|---|---|---|---:|---:|---:|
| click | 8.3.1 | PROBABLE | 0 | 0 | 2 |
| llama-cpp-python |  | PROBABLE | 0 | 0 | 2 |
| mem0ai | 1.0.2 | PROBABLE | 0 | 0 | 6 |
| PyYAML |  | CONFIRMED | 1 | 0 | 0 |

## Unclassified

- Files scanned: **0**
- Packages: **0**

_No package evidence found._
