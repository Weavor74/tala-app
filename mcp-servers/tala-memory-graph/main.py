import sys
import os
import json
from datetime import datetime
from typing import List, Dict, Any, Optional

# Log startup to stderr
sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: starting\n")

from mcp.server.fastmcp import FastMCP
from src.memory import MemorySystem, NodeType, EdgeType, ConfidenceBasis
from src.memory.schema import NodeV1, EdgeV1, Provenance, Confidence
from src.memory_graph.router import MemoryRouter
from src.memory_graph.store_factory import create_store

sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: imports complete\n")

# Initialize FastMCP server
mcp = FastMCP("Tala Memory Graph")

# Initialize store and memory system via factory.
# PostgreSQL is used when TALA_PG_DSN or TALA_DATABASE_URL is set.
# SQLite fallback is available when TALA_MEMORY_DB is set explicitly.
# If neither is available, the server starts in degraded mode: all tool calls
# return a structured error so the MCP handshake can complete and the health
# loop sees DEGRADED rather than a process-crash (FAILED).
sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: initializing store\n")
_store = None
memory = None
router = MemoryRouter()
_store_error: Optional[str] = None

try:
    _store = create_store()
    sys.stderr.write(
        f"[{datetime.now().isoformat()}] tala-memory-graph: store={type(_store).__name__}\n"
    )
    memory = MemorySystem(store=_store)
except Exception as _exc:
    _store_error = str(_exc)
    sys.stderr.write(
        f"[{datetime.now().isoformat()}] tala-memory-graph: WARNING - store init failed: {_store_error}\n"
    )
    sys.stderr.write(
        f"[{datetime.now().isoformat()}] tala-memory-graph: starting in degraded mode — tool calls will return errors\n"
    )

# Identity Migration & Unification
current_user_id = os.environ.get("TALA_USER_ID")
if memory is not None and current_user_id:
    sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: running identity migration for {current_user_id}\n")
    memory.run_identity_migration(current_user_id)
elif current_user_id is None:
    sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: WARNING - TALA_USER_ID not found in environment. Skipping identity migration.\n")

sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: initialization complete\n")


def _require_memory(tool_name: str) -> str:
    """Returns a structured error string when the store is unavailable."""
    reason = _store_error or "No database backend configured."
    return json.dumps({"ok": False, "error": f"{tool_name}: memory graph unavailable — {reason}"})


@mcp.tool()
async def route_query(query: str) -> str:
    """Determines which memory engine (graph, mem0, rag) should handle the query."""
    if memory is None:
        return _require_memory("route_query")
    return router.route(query, user_id=current_user_id)

@mcp.tool()
async def process_memory(text: str, source_ref: str = "interaction") -> List[str]:
    """Processes an interaction to extract and store memories in the graph."""
    if memory is None:
        return [_require_memory("process_memory")]
    nodes = memory.process_interaction(text, source_ref)
    return [f"Created {node.type} node: {node.title}" for node in nodes]

@mcp.tool()
async def upsert_node(node_id: str, type: str, title: str, content: str, attrs_json: str = '{}'):
    """Manually insert or update a node in the graph."""
    if memory is None:
        return _require_memory("upsert_node")
    try:
        attrs = json.loads(attrs_json)
    except:
        attrs = {}
    
    node = NodeV1(
        id=node_id,
        type=NodeType(type),
        title=title,
        content=content,
        metadata=attrs,
        provenance=Provenance(source_ref="manual"),
        confidence=Confidence(score=1.0, basis=ConfidenceBasis.EXPLICIT)
    )
    memory.upsert_node(node)
    return f"Node {node_id} upserted."

@mcp.tool()
async def upsert_edge(source_id: str, target_id: str, relation: str, weight: float = 1.0):
    """Manually insert or update an edge between nodes."""
    if memory is None:
        return _require_memory("upsert_edge")
    edge = EdgeV1(
        source_id=source_id,
        target_id=target_id,
        relation=EdgeType(relation),
        weight=weight,
        provenance=Provenance(source_ref="manual"),
        confidence=Confidence(score=1.0, basis=ConfidenceBasis.EXPLICIT)
    )
    memory.upsert_edge(edge)
    return f"Edge {source_id} -> {target_id} upserted."

@mcp.tool()
async def query_graph(query_text: str) -> str:
    """Performs a complex semantic/graph query across the local memory."""
    if memory is None:
        return _require_memory("query_graph")
    # Note: Using retrieve_context as a proxy for complex queries until full Cypher-like query is implemented
    result = memory.retrieve_context(query_text, user_id=current_user_id)
    return result.get("context_str", "No relevant graph context found.")

@mcp.tool()
async def search_nodes(query: str, limit: int = 10) -> List[Dict[Any, Any]]:
    """Search for nodes by title or content."""
    if memory is None:
        return [json.loads(_require_memory("search_nodes"))]
    nodes = memory.search(query) # search returns List[NodeV1]
    return [node.model_dump() for node in nodes[:limit]]

@mcp.tool()
async def retrieve_context(query: str, limit: int = 5) -> Dict[str, Any]:
    """Retrieves deep context (node + neighbors) for a semantic query."""
    if memory is None:
        return json.loads(_require_memory("retrieve_context"))
    result = memory.retrieve_context(query, max_nodes=limit, user_id=current_user_id)
    # Convert nodes/edges to dicts for JSON serialization
    return {
        "nodes": [n.model_dump() for n in result["nodes"]],
        "edges": [e.model_dump() for e in result["edges"]],
        "context_str": result["context_str"]
    }

@mcp.tool()
async def get_node_neighborhood(node_id: str, depth: int = 1) -> List[Dict[Any, Any]]:
    """Retrieves a node and its adjacent neighbors up to a certain depth."""
    if memory is None:
        return [json.loads(_require_memory("get_node_neighborhood"))]
    nodes = memory.get_neighborhood(node_id, depth)
    return [node.model_dump() for node in nodes]

if __name__ == "__main__":
    mcp.run()
