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

sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: imports complete\n")

# Initialize FastMCP server
mcp = FastMCP("Tala Memory Graph")

# Initialize the memory system
DB_PATH = os.environ.get("TALA_MEMORY_DB", "tala_memory_v1.db")
sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: initializing MemorySystem with {DB_PATH}\n")

memory = MemorySystem(DB_PATH)
router = MemoryRouter()

sys.stderr.write(f"[{datetime.now().isoformat()}] tala-memory-graph: initialization complete\n")

@mcp.tool()
async def route_query(query: str) -> str:
    """Determines which memory engine (graph, mem0, rag) should handle the query."""
    return router.route(query)

@mcp.tool()
async def process_memory(text: str, source_ref: str = "interaction") -> List[str]:
    """Processes an interaction to extract and store memories in the graph."""
    nodes = memory.process_interaction(text, source_ref)
    return [f"Created {node.type} node: {node.title}" for node in nodes]

@mcp.tool()
async def upsert_node(node_id: str, type: str, title: str, content: str, attrs_json: str = '{}'):
    """Manually insert or update a node in the graph."""
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
    # Note: Using retrieve_context as a proxy for complex queries until full Cypher-like query is implemented
    result = memory.retrieve_context(query_text)
    return result.get("context_str", "No relevant graph context found.")

@mcp.tool()
async def search_nodes(query: str, limit: int = 10) -> List[Dict[Any, Any]]:
    """Search for nodes by title or content."""
    nodes = memory.search(query) # search returns List[NodeV1]
    return [node.model_dump() for node in nodes[:limit]]

@mcp.tool()
async def retrieve_context(query: str, limit: int = 5) -> Dict[str, Any]:
    """Retrieves deep context (node + neighbors) for a semantic query."""
    result = memory.retrieve_context(query, max_nodes=limit)
    # Convert nodes/edges to dicts for JSON serialization
    return {
        "nodes": [n.model_dump() for n in result["nodes"]],
        "edges": [e.model_dump() for e in result["edges"]],
        "context_str": result["context_str"]
    }

@mcp.tool()
async def get_node_neighborhood(node_id: str, depth: int = 1) -> List[Dict[Any, Any]]:
    """Retrieves a node and its adjacent neighbors up to a certain depth."""
    nodes = memory.get_neighborhood(node_id, depth)
    return [node.model_dump() for node in nodes]

if __name__ == "__main__":
    mcp.run()
