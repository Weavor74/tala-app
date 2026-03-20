"""
Tests for PostgresGraphStore.

These tests require a live PostgreSQL instance.  They are skipped automatically
when TALA_PG_DSN (or TALA_DATABASE_URL) is not set in the environment, so the
CI suite can run without a database.

To run locally:
    TALA_PG_DSN="postgresql://user:pass@localhost/tala_test" pytest tests/test_pg_store.py -v
"""

import json
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

PG_DSN = os.environ.get("TALA_PG_DSN") or os.environ.get("TALA_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_DSN,
    reason="TALA_PG_DSN not set — skipping PostgreSQL graph store tests",
)


@pytest.fixture(scope="module")
def pg_store():
    from memory_graph.pg_store import PostgresGraphStore

    store = PostgresGraphStore(PG_DSN)
    yield store
    # Cleanup: drop all rows inserted by these tests.
    import psycopg2

    with psycopg2.connect(PG_DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM graph_evidence WHERE evidence_id LIKE 'test_%'")
            cur.execute("DELETE FROM graph_events WHERE event_id LIKE 'test_%'")
            cur.execute("DELETE FROM graph_edges WHERE edge_id LIKE 'test_%'")
            cur.execute("DELETE FROM graph_nodes WHERE node_id LIKE 'test_%'")
        conn.commit()
    store.close()


def test_upsert_node(pg_store):
    pg_store.upsert_node("test_n1", "person", "Alice", {"age": 30})
    nodes = pg_store.search_nodes("Alice")
    assert len(nodes) >= 1
    node = next(n for n in nodes if n["node_id"] == "test_n1")
    assert node["type"] == "person"
    # Update
    pg_store.upsert_node("test_n1", "person", "Alice", {"age": 31})
    nodes = pg_store.search_nodes("Alice")
    node = next(n for n in nodes if n["node_id"] == "test_n1")
    assert json.loads(node["attrs_json"])["age"] == 31


def test_upsert_edge(pg_store):
    pg_store.upsert_node("test_n1", "person", "Alice")
    pg_store.upsert_node("test_n2", "dog", "Buddy")
    pg_store.upsert_edge("test_e1", "test_n1", "test_n2", "owns", {"bought": 2020})

    nb = pg_store.get_neighborhood("test_n1")
    assert any(n["node_id"] == "test_n2" for n in nb["nodes"])
    assert any(e["rel_type"] == "owns" for e in nb["edges"])


def test_add_event(pg_store):
    pg_store.add_event(
        "test_ev1", "Childhood memory", "Buddy was a black shepherd.", "2005-01-01"
    )
    events = pg_store.timeline_search("2000-01-01", "2010-01-01")
    assert any(e["event_id"] == "test_ev1" for e in events)
    ev = next(e for e in events if e["event_id"] == "test_ev1")
    assert ev["title"] == "Childhood memory"


def test_integrity_fk_violation(pg_store):
    pg_store.upsert_edge("test_e_orphan", "ghost1", "ghost2", "haunts")
    report = pg_store.validate_integrity()
    assert any(
        v["edge_id"] == "test_e_orphan" for v in report["fk_violations"]
    )


def test_neighborhood_depth(pg_store):
    pg_store.upsert_node("test_d1", "concept", "D1")
    pg_store.upsert_node("test_d2", "concept", "D2")
    pg_store.upsert_node("test_d3", "concept", "D3")
    pg_store.upsert_edge("test_de1", "test_d1", "test_d2", "rel")
    pg_store.upsert_edge("test_de2", "test_d2", "test_d3", "rel")

    nb1 = pg_store.get_neighborhood("test_d1", depth=1)
    assert any(n["node_id"] == "test_d2" for n in nb1["nodes"])
    assert not any(n["node_id"] == "test_d3" for n in nb1["nodes"])

    nb2 = pg_store.get_neighborhood("test_d1", depth=2)
    assert any(n["node_id"] == "test_d3" for n in nb2["nodes"])
