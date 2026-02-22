# mcp-servers/mem0-core/ — Short-Term Memory Server

Manages user facts, preferences, and contextual memory using the `mem0` library.

---

## Files

| File | Size | Description |
|---|---|---|
| `server.py` | 1 KB | **MCP Server Entry Point.** Exposes tools: `mem0_search(query, limit)`, `mem0_add_fact(fact)`, `mem0_add_turn(user_text, assistant_text)`. Uses `mem0` for storage. Runs via `mcp.run(transport='stdio')`. |
| `requirements.txt` | 18 B | Python dependencies: `mem0ai`. |
