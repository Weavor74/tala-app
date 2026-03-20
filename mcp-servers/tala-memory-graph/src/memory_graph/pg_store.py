"""
PostgreSQL-backed graph store for tala-memory-graph.

Implements the same public interface as GraphStore (SQLite) so it can be
dropped in as a replacement.  All tables are prefixed with ``graph_`` to
coexist with the canonical entity/relationship tables created by the main
Electron app migrations.

Requires psycopg2-binary (or psycopg2).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import psycopg2
import psycopg2.extras


class PostgresGraphStore:
    """PostgreSQL-backed graph store with the same interface as GraphStore."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._init_db()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _connect(self) -> "psycopg2.extensions.connection":
        return psycopg2.connect(self._dsn)

    def _init_db(self) -> None:
        schema_path = os.path.join(os.path.dirname(__file__), "pg_schema.sql")
        with open(schema_path) as f:
            schema = f.read()
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(schema)
            conn.commit()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    # ------------------------------------------------------------------
    # Write operations
    # ------------------------------------------------------------------

    def upsert_node(
        self,
        node_id: str,
        type: str,
        name: str,
        attrs: Optional[Dict[str, Any]] = None,
    ) -> None:
        attrs_json = json.dumps(attrs or {})
        sql = """
            INSERT INTO graph_nodes (node_id, type, name, attrs_json, updated_at)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (node_id) DO UPDATE SET
                type       = EXCLUDED.type,
                name       = EXCLUDED.name,
                attrs_json = EXCLUDED.attrs_json,
                updated_at = EXCLUDED.updated_at
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (node_id, type, name, attrs_json, self._now()))
            conn.commit()

    def upsert_edge(
        self,
        edge_id: str,
        src_id: str,
        dst_id: str,
        rel_type: str,
        attrs: Optional[Dict[str, Any]] = None,
    ) -> None:
        attrs_json = json.dumps(attrs or {})
        sql = """
            INSERT INTO graph_edges (edge_id, src_id, dst_id, rel_type, attrs_json, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (edge_id) DO UPDATE SET
                src_id     = EXCLUDED.src_id,
                dst_id     = EXCLUDED.dst_id,
                rel_type   = EXCLUDED.rel_type,
                attrs_json = EXCLUDED.attrs_json,
                updated_at = EXCLUDED.updated_at
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    sql,
                    (edge_id, src_id, dst_id, rel_type, attrs_json, self._now()),
                )
            conn.commit()

    def add_event(
        self,
        event_id: str,
        title: str,
        body: str,
        ts: str,
        entities: Optional[List[str]] = None,
        sentiment: Optional[Dict[str, Any]] = None,
        attrs: Optional[Dict[str, Any]] = None,
    ) -> None:
        sql = """
            INSERT INTO graph_events
                (event_id, title, body, ts, entities_json, sentiment_json, attrs_json)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (event_id) DO UPDATE SET
                title          = EXCLUDED.title,
                body           = EXCLUDED.body,
                ts             = EXCLUDED.ts,
                entities_json  = EXCLUDED.entities_json,
                sentiment_json = EXCLUDED.sentiment_json,
                attrs_json     = EXCLUDED.attrs_json
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    sql,
                    (
                        event_id,
                        title,
                        body,
                        ts,
                        json.dumps(entities or []),
                        json.dumps(sentiment or {}),
                        json.dumps(attrs or {}),
                    ),
                )
            conn.commit()

    def link_evidence(
        self,
        evidence_id: str,
        kind: str,
        ref: str,
        node_id: Optional[str] = None,
        edge_id: Optional[str] = None,
        event_id: Optional[str] = None,
    ) -> None:
        sql = """
            INSERT INTO graph_evidence (evidence_id, kind, ref, node_id, edge_id, event_id)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (evidence_id) DO UPDATE SET
                kind     = EXCLUDED.kind,
                ref      = EXCLUDED.ref,
                node_id  = EXCLUDED.node_id,
                edge_id  = EXCLUDED.edge_id,
                event_id = EXCLUDED.event_id
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, (evidence_id, kind, ref, node_id, edge_id, event_id))
            conn.commit()

    # ------------------------------------------------------------------
    # Read operations
    # ------------------------------------------------------------------

    def search_nodes(self, query: str) -> List[Dict[str, Any]]:
        pattern = f"%{query}%"
        sql = """
            SELECT node_id, type, name, attrs_json, created_at, updated_at
            FROM graph_nodes
            WHERE name ILIKE %s OR type ILIKE %s
        """
        with self._connect() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, (pattern, pattern))
                return [dict(row) for row in cur.fetchall()]

    def get_neighborhood(
        self, node_id: str, depth: int = 1
    ) -> Dict[str, List[Dict[str, Any]]]:
        nodes: Dict[str, Dict[str, Any]] = {}
        edges: Dict[str, Dict[str, Any]] = {}

        def _fetch(
            cur: "psycopg2.extensions.cursor", nid: str, current_depth: int
        ) -> None:
            if current_depth > depth or nid in nodes:
                return
            cur.execute(
                "SELECT node_id, type, name, attrs_json, created_at, updated_at"
                " FROM graph_nodes WHERE node_id = %s",
                (nid,),
            )
            row = cur.fetchone()
            if row:
                nodes[nid] = dict(row)

            cur.execute(
                "SELECT edge_id, src_id, dst_id, rel_type, attrs_json,"
                " created_at, updated_at"
                " FROM graph_edges WHERE src_id = %s OR dst_id = %s",
                (nid, nid),
            )
            for e_row in cur.fetchall():
                ed = dict(e_row)
                edges[ed["edge_id"]] = ed
                next_id = (
                    ed["dst_id"] if ed["src_id"] == nid else ed["src_id"]
                )
                _fetch(cur, next_id, current_depth + 1)

        with self._connect() as conn:
            with conn.cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                _fetch(cur, node_id, 0)

        return {"nodes": list(nodes.values()), "edges": list(edges.values())}

    def timeline_search(
        self, start_ts: str, end_ts: str
    ) -> List[Dict[str, Any]]:
        sql = """
            SELECT event_id, title, body, ts,
                   entities_json, sentiment_json, attrs_json
            FROM graph_events
            WHERE ts BETWEEN %s AND %s
            ORDER BY ts ASC
        """
        with self._connect() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, (start_ts, end_ts))
                return [dict(row) for row in cur.fetchall()]

    def validate_integrity(self) -> Dict[str, Any]:
        sql = """
            SELECT edge_id, src_id, dst_id
            FROM graph_edges
            WHERE src_id NOT IN (SELECT node_id FROM graph_nodes)
               OR dst_id NOT IN (SELECT node_id FROM graph_nodes)
        """
        with self._connect() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql)
                return {
                    "orphan_edges": [],
                    "missing_nodes": [],
                    "fk_violations": [dict(row) for row in cur.fetchall()],
                }

    def close(self) -> None:
        """No-op: connections are opened per operation."""
