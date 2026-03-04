import sqlite3
import json
import os
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple

class GraphStore:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_db()

    def _get_connection(self):
        return sqlite3.connect(self.db_path)

    def _init_db(self):
        dname = os.path.dirname(self.db_path)
        if dname:
            os.makedirs(dname, exist_ok=True)
        # Load schema from relative path
        schema_path = os.path.join(os.path.dirname(__file__), 'schema.sql')
        with open(schema_path, 'r') as f:
            schema = f.read()
        
        with self._get_connection() as conn:
            conn.executescript(schema)

    def upsert_node(self, node_id: str, type: str, name: str, attrs: Dict[str, Any] = None):
        attrs_json = json.dumps(attrs or {})
        now = datetime.now().isoformat()
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO nodes (node_id, type, name, attrs_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET
                    type=excluded.type,
                    name=excluded.name,
                    attrs_json=excluded.attrs_json,
                    updated_at=excluded.updated_at
            """, (node_id, type, name, attrs_json, now))

    def upsert_edge(self, edge_id: str, src_id: str, dst_id: str, rel_type: str, attrs: Dict[str, Any] = None):
        attrs_json = json.dumps(attrs or {})
        now = datetime.now().isoformat()
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO edges (edge_id, src_id, dst_id, rel_type, attrs_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(edge_id) DO UPDATE SET
                    src_id=excluded.src_id,
                    dst_id=excluded.dst_id,
                    rel_type=excluded.rel_type,
                    attrs_json=excluded.attrs_json,
                    updated_at=excluded.updated_at
            """, (edge_id, src_id, dst_id, rel_type, attrs_json, now))

    def add_event(self, event_id: str, title: str, body: str, ts: str, entities: List[str] = None, sentiment: Dict[str, Any] = None, attrs: Dict[str, Any] = None):
        entities_json = json.dumps(entities or [])
        sentiment_json = json.dumps(sentiment or {})
        attrs_json = json.dumps(attrs or {})
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO events (event_id, title, body, ts, entities_json, sentiment_json, attrs_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_id) DO UPDATE SET
                    title=excluded.title,
                    body=excluded.body,
                    ts=excluded.ts,
                    entities_json=excluded.entities_json,
                    sentiment_json=excluded.sentiment_json,
                    attrs_json=excluded.attrs_json
            """, (event_id, title, body, ts, entities_json, sentiment_json, attrs_json))

    def link_evidence(self, evidence_id: str, kind: str, ref: str, node_id: str = None, edge_id: str = None, event_id: str = None):
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO evidence (evidence_id, kind, ref, node_id, edge_id, event_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(evidence_id) DO UPDATE SET
                    kind=excluded.kind,
                    ref=excluded.ref,
                    node_id=excluded.node_id,
                    edge_id=excluded.edge_id,
                    event_id=excluded.event_id
            """, (evidence_id, kind, ref, node_id, edge_id, event_id))

    def search_nodes(self, query: str) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM nodes WHERE name LIKE ? OR type LIKE ?", (f"%{query}%", f"%{query}%"))
            return [dict(row) for row in cursor.fetchall()]

    def get_neighborhood(self, node_id: str, depth: int = 1) -> Dict[str, List[Dict[str, Any]]]:
        nodes = {}
        edges = {}
        
        def _fetch(nid, current_depth):
            if current_depth > depth or nid in nodes:
                return
            
            with self._get_connection() as conn:
                conn.row_factory = sqlite3.Row
                # Fetch node
                res = conn.execute("SELECT * FROM nodes WHERE node_id = ?", (nid,)).fetchone()
                if res:
                    nodes[nid] = dict(res)
                
                # Fetch connected edges
                e_res = conn.execute("SELECT * FROM edges WHERE src_id = ? OR dst_id = ?", (nid, nid)).fetchall()
                for e in e_res:
                    ed = dict(e)
                    edges[ed['edge_id']] = ed
                    # Recurse
                    next_id = ed['dst_id'] if ed['src_id'] == nid else ed['src_id']
                    _fetch(next_id, current_depth + 1)

        _fetch(node_id, 0)
        return {"nodes": list(nodes.values()), "edges": list(edges.values())}

    def timeline_search(self, start_ts: str, end_ts: str) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts ASC", (start_ts, end_ts))
            return [dict(row) for row in cursor.fetchall()]

    def close(self):
        # We don't store a persistent connection usually, 
        # but this allows clearing any cached state if needed.
        pass

    def validate_integrity(self) -> Dict[str, Any]:
        report = {
            "orphan_edges": [],
            "missing_nodes": [],
            "fk_violations": []
        }
        with self._get_connection() as conn:
            conn.row_factory = sqlite3.Row
            # Check for edges pointing to non-existent nodes
            cursor = conn.execute("""
                SELECT edge_id, src_id, dst_id FROM edges 
                WHERE src_id NOT IN (SELECT node_id FROM nodes) 
                OR dst_id NOT IN (SELECT node_id FROM nodes)
            """)
            report["fk_violations"] = [dict(row) for row in cursor.fetchall()]
        return report
