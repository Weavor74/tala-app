from mcp.server.fastmcp import FastMCP
from .tools_graph import (
    graph_upsert_node, graph_upsert_edge, 
    graph_get_neighborhood, graph_search, graph_timeline
)
from .router import MemoryRouter

mcp = FastMCP("Tala Memory Graph (Advanced)")

@mcp.tool()
def upsert_node(node_id: str, type: str, name: str, attrs_json: str = '{}'):
    """Adds or updates a node in the memory graph."""
    return graph_upsert_node(node_id, type, name, attrs_json)

@mcp.tool()
def upsert_edge(edge_id: str, src_id: str, dst_id: str, rel_type: str, attrs_json: str = '{}'):
    """Adds or updates a relationship between nodes."""
    return graph_upsert_edge(edge_id, src_id, dst_id, rel_type, attrs_json)

@mcp.tool()
def get_neighborhood(node_id: str, depth: int = 1):
    """Finds all connected nodes within N hops."""
    return graph_get_neighborhood(node_id, depth)

@mcp.tool()
def search_nodes(query: str):
    """Keyword search across node names and types."""
    return graph_search(query)

@mcp.tool()
def timeline_search(start_ts: str, end_ts: str):
    """Retrieves events between two timestamps (ISO format)."""
    return graph_timeline(start_ts, end_ts)

@mcp.tool()
def route_query(query: str):
    """Determines which memory engine (graph, mem0, rag) should handle the query."""
    router = MemoryRouter()
    return router.route(query)

@mcp.tool()
def retrieve_context(query: str, max_nodes: int = 5, max_edges: int = 5, emotion: str = 'neutral', intensity: float = 0.5):
    """Integrated retrieval for the agent: searches nodes and gets their neighborhood."""
    import json
    # 1. Search for primary nodes
    nodes = store.search_nodes(query)
    if not nodes:
        return "No relevant memories found in graph."
    
    # 2. Get neighborhood for the top node
    top_node_id = nodes[0]['node_id']
    nb = store.get_neighborhood(top_node_id, depth=1)
    
    # 3. Format as something the agent can use
    return json.dumps(nb, indent=2)

if __name__ == "__main__":
    mcp.run()
