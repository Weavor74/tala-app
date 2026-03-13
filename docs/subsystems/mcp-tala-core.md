# MCP Server: tala-core

**Source**: [mcp-servers\tala-core\server.py](../../mcp-servers/tala-core/server.py)

### Tool: `get_emotional_state`

**Description**: Returns calculated emotional state (Stub).

**Arguments**: `agent_id: str = "tala"`

**Returns**: `str`

---

### Tool: `search_memory`

**Description**: Searches memory for relevant context using semantic similarity.
    Args:
        query: The search text representing the information you are looking for.
        limit: Max results to return.
        filter_json: Optional JSON string or Dict of metadata key-value pairs to filter by.

**Arguments**: `query: str, limit: int = 3, filter_json: Optional[Any] = None`

**Returns**: `list[dict]`

---

### Tool: `ingest_file`

**Description**: Ingests a file into memory with a specific category. Supports LTMF Markdown with YAML frontmatter.

**Arguments**: `file_path: str, category: str = "general"`

**Returns**: `str`

---

### Tool: `delete_file_memory`

**Description**: Deletes all memories for a file.

**Arguments**: `file_path: str`

**Returns**: `str`

---

### Tool: `list_indexed_files`

**Description**: List all indexed source files.

**Arguments**: ``

**Returns**: `list[str]`

---

### Tool: `log_interaction`

**Description**: Logs conversation turn.

**Arguments**: `user_text: str, agent_text: str`

**Returns**: `bool`

---

### Tool: `ping`

**Description**: Standard health check.

**Arguments**: ``

**Returns**: `str`

---

### Tool: `version`

**Description**: Returns the package version.

**Arguments**: ``

**Returns**: `str`

---

### Tool: `status`

**Description**: Returns the current internal status.

**Arguments**: ``

**Returns**: `str`

---

