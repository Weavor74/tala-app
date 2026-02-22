# mcp-servers/tala-core/ — RAG & Vector Database Server

The primary long-term memory backend. Uses **ChromaDB** for vector storage and **SentenceTransformers** (`all-MiniLM-L6-v2`) for embeddings.

---

## Folders

| Folder | Description |
|---|---|
| `data/` | Runtime data — contains the `chroma_db/` directory with persisted vector database files. |
| `memory/` | _Empty._ Reserved for memory file storage. |
| `astro_engine/` | _Empty._ Legacy/stub directory for astro engine (moved to `astro-engine/`). |
| `venv/` | Python virtual environment. _Generated — do not edit._ |

---

## Files

| File | Size | Description |
|---|---|---|
| `server.py` | 13 KB | **MCP Server Entry Point.** Defines all MCP tools: `search_memory(query, limit)`, `log_interaction(user_text, agent_text)`, `ingest_file(file_path)`, `delete_file_memory(file_path)`, `list_indexed_files()`, `get_emotional_state(agent_id)`. Also contains `init_vector_store()` for ChromaDB/Pinecone/Weaviate backend selection. Runs via `mcp.run(transport='stdio')`. |
| `requirements.txt` | 134 B | Python dependencies: `mcp`, `chromadb`, `sentence-transformers`, `pydantic`. |
