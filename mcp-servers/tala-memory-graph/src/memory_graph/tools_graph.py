import os
from .graph_store import GraphStore

# Initialize store with production path
DB_PATH = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'data', 'memory_graph', 'memory_graph.sqlite')
store = GraphStore(DB_PATH)

def graph_upsert_node(node_id: str, type: str, name: str, attrs_json: str = '{}'):
    """Upserts a node into the graph."""
    import json
    attrs = json.loads(attrs_json)
    store.upsert_node(node_id, type, name, attrs)
    return f"Node {node_id} upserted."

def graph_upsert_edge(edge_id: str, src_id: str, dst_id: str, rel_type: str, attrs_json: str = '{}'):
    """Upserts an edge into the graph."""
    import json
    attrs = json.loads(attrs_json)
    store.upsert_edge(edge_id, src_id, dst_id, rel_type, attrs)
    return f"Edge {edge_id} upserted."

def graph_get_neighborhood(node_id: str, depth: int = 1):
    """Retrieves the neighborhood of a node."""
    import json
    res = store.get_neighborhood(node_id, depth)
    return json.dumps(res, indent=2)

def graph_search(query: str):
    """Searches for nodes by name or type."""
    import json
    res = store.search_nodes(query)
    return json.dumps(res, indent=2)

def graph_timeline(start_ts: str, end_ts: str):
    """Searches for events in a time range."""
    import json
    res = store.timeline_search(start_ts, end_ts)
    return json.dumps(res, indent=2)
