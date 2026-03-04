import pytest
import os
import sys
from datetime import datetime
import json
# Add src to path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'src'))
from memory_graph.graph_store import GraphStore

@pytest.fixture
def store(tmp_path):
    db_path = tmp_path / "test_graph.sqlite"
    return GraphStore(str(db_path))

def test_upsert_node(store):
    store.upsert_node("n1", "person", "Steven", {"age": 30})
    nodes = store.search_nodes("Steven")
    assert len(nodes) == 1
    assert nodes[0]['node_id'] == "n1"
    assert nodes[0]['type'] == "person"
    
    # Update
    store.upsert_node("n1", "person", "Steven", {"age": 31})
    nodes = store.search_nodes("Steven")
    assert json.loads(nodes[0]['attrs_json'])['age'] == 31

def test_upsert_edge(store):
    store.upsert_node("n1", "person", "Steven")
    store.upsert_node("n2", "dog", "Orion")
    store.upsert_edge("e1", "n1", "n2", "owns", {"bought": 2020})
    
    nb = store.get_neighborhood("n1")
    assert len(nb['nodes']) == 2
    assert len(nb['edges']) == 1
    assert nb['edges'][0]['rel_type'] == "owns"

def test_add_event(store):
    store.add_event("ev1", "Childhood memory", "Orion was a black shepherd.", "2005-01-01", ["Orion"])
    events = store.timeline_search("2000-01-01", "2010-01-01")
    assert len(events) == 1
    assert events[0]['title'] == "Childhood memory"

def test_integrity(store):
    # Missing source/target
    store.upsert_edge("e_orphan", "ghost1", "ghost2", "haunts")
    report = store.validate_integrity()
    assert len(report['fk_violations']) == 1
    assert report['fk_violations'][0]['edge_id'] == "e_orphan"


