# MCP Server: world-engine

**Source**: [mcp-servers/world-engine/server.py](../../mcp-servers/world-engine/server.py)

### Tool: `analyze_structure`

**Description**: Performs a structural analysis of a file (AST-based for Python, regex for TS/JS).
    Provides classes, functions, and public interfaces.

**Arguments**: `target_path: str`

**Returns**: `Dict[str, Any]`

---

### Tool: `get_dependencies`

**Description**: Finds identifying imports in a file and attempts to resolve them within the workspace.

**Arguments**: `target_path: str, workspace_root: str`

**Returns**: `Dict[str, Any]`

---

### Tool: `workspace_overview`

**Description**: Scans the workspace to build a high-level map of components.

**Arguments**: `workspace_root: str, max_depth: int = 2`

**Returns**: `Dict[str, Any]`

---

