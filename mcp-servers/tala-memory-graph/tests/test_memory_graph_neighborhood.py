import pytest
import os
import sys
# Add src to path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))
from memory_graph.graph_store import GraphStore

@pytest.fixture
def store(tmp_path):
    db_path = tmp_path / "test_neighborhood.sqlite"
    return GraphStore(str(db_path))

def test_get_neighborhood_depth(store):
    # n1 -> n2 -> n3
    store.upsert_node("n1", "concept", "A")
    store.upsert_node("n2", "concept", "B")
    store.upsert_node("n3", "concept", "C")
    store.upsert_edge("e1", "n1", "n2", "rel")
    store.upsert_edge("e2", "n2", "n3", "rel")
    
    # Depth 1 from n1 (should get n1, n2, e1)
    nb1 = store.get_neighborhood("n1", depth=1)
    assert len(nb1['nodes']) == 2
    assert any(n['node_id'] == "n2" for n in nb1['nodes'])
    assert not any(n['node_id'] == "n3" for n in nb1['nodes'])
    
    # Depth 2 from n1 (should get n1, n2, n3, e1, e2)
    nb2 = store.get_neighborhood("n1", depth=2)
    assert len(nb2['nodes']) == 3
    assert any(n['node_id'] == "n3" for n in nb2['nodes'])
