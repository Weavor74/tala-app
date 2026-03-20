from __future__ import annotations
import sqlite3
import json
import re
from typing import List, Optional, Set, Tuple, Dict, Any
from abc import ABC, abstractmethod
from datetime import datetime
from .schema import NodeV1, EdgeV1

class GraphBackend(ABC):
    @abstractmethod
    def upsert_node(self, node: NodeV1): pass
    @abstractmethod
    def upsert_edge(self, edge: EdgeV1): pass
    @abstractmethod
    def get_node(self, node_id: str) -> Optional[NodeV1]: pass
    @abstractmethod
    def get_neighborhood(self, node_id: str, hops: int = 1) -> Tuple[List[NodeV1], List[EdgeV1]]: pass
    @abstractmethod
    def search_nodes(self, query: str, limit: int = 10, filters: Optional[Dict[str, Any]] = None) -> List[NodeV1]: pass
    @abstractmethod
    def retrieve_context(self, query: str, max_nodes: int = 5, max_edges: int = 5, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]: pass
    @abstractmethod
    def search_episodic(self, location: Optional[str] = None, timeframe: Optional[Tuple[datetime, datetime]] = None, limit: int = 10) -> List[NodeV1]: pass

class SQLiteGraphBackend(GraphBackend):
    def __init__(self, db_path: str = "tala_memory_v1.db"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS nodes (
                    id TEXT PRIMARY KEY,
                    version TEXT,
                    type TEXT,
                    title TEXT,
                    content TEXT,
                    data_json TEXT,
                    confidence_score REAL,
                    age REAL,
                    life_stage TEXT,
                    source_hash TEXT,
                    created_at TIMESTAMP,
                    updated_at TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS edges (
                    id TEXT PRIMARY KEY,
                    version TEXT,
                    source_id TEXT,
                    target_id TEXT,
                    relation TEXT,
                    weight REAL,
                    data_json TEXT,
                    created_at TIMESTAMP,
                    FOREIGN KEY(source_id) REFERENCES nodes(id),
                    FOREIGN KEY(target_id) REFERENCES nodes(id)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS episodic_events (
                    node_id TEXT PRIMARY KEY,
                    location_id TEXT,
                    event_timestamp TIMESTAMP,
                    emotional_state TEXT,
                    FOREIGN KEY(node_id) REFERENCES nodes(id),
                    FOREIGN KEY(location_id) REFERENCES nodes(id)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS evidence_links (
                    id TEXT PRIMARY KEY,
                    node_id TEXT,
                    source_ref TEXT,
                    quote TEXT,
                    FOREIGN KEY(node_id) REFERENCES nodes(id)
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(title)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_nodes_age ON nodes(age)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_episodic_timestamp ON episodic_events(event_timestamp)")

    def upsert_node(self, node: NodeV1, conn: Optional[sqlite3.Connection] = None):
        if conn:
            self._upsert_node_impl(conn, node)
        else:
            with sqlite3.connect(self.db_path) as conn:
                self._upsert_node_impl(conn, node)

    def _upsert_node_impl(self, conn: sqlite3.Connection, node: NodeV1):
        conn.execute("""
            INSERT INTO nodes (id, version, type, title, content, data_json, confidence_score, age, life_stage, source_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                content=excluded.content,
                data_json=excluded.data_json,
                confidence_score=excluded.confidence_score,
                age=excluded.age,
                life_stage=excluded.life_stage,
                source_hash=excluded.source_hash,
                updated_at=excluded.updated_at
        """, (
            node.id, node.version, node.type.value, node.title, node.content, 
            node.model_dump_json(), node.confidence.score, 
            node.age, node.life_stage, node.provenance.source_hash,
            node.created_at.isoformat(), datetime.now().isoformat()
        ))
        
        # Populate episodic_events if it's an event or a memory with location/time
        is_episodic = node.type.value in ["event", "memory"] and (node.metadata.get("location_id") or node.metadata.get("timestamp"))
        if is_episodic:
            location_id = node.metadata.get("location_id")
            event_ts = node.metadata.get("timestamp") or node.provenance.timestamp.isoformat()
            emotional_state = json.dumps(node.emotional_vector) if node.emotional_vector else None
            
            conn.execute("""
                INSERT INTO episodic_events (node_id, location_id, event_timestamp, emotional_state)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET
                    location_id=excluded.location_id,
                    event_timestamp=excluded.event_timestamp,
                    emotional_state=excluded.emotional_state
            """, (node.id, location_id, event_ts, emotional_state))
            
        # Populate evidence_links
        if node.provenance.evidence_quote:
            evidence_id = f"ev_{node.id}_{hash(node.provenance.source_ref)}"
            conn.execute("""
                INSERT INTO evidence_links (id, node_id, source_ref, quote)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
            """, (evidence_id, node.id, node.provenance.source_ref, node.provenance.evidence_quote))

    def upsert_edge(self, edge: EdgeV1, conn: Optional[sqlite3.Connection] = None):
        if conn:
            self._upsert_edge_impl(conn, edge)
        else:
            with sqlite3.connect(self.db_path) as conn:
                self._upsert_edge_impl(conn, edge)

    def _upsert_edge_impl(self, conn: sqlite3.Connection, edge: EdgeV1):
        conn.execute("""
            INSERT INTO edges (id, version, source_id, target_id, relation, weight, data_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                weight=excluded.weight,
                data_json=excluded.data_json
        """, (
            edge.id, edge.version, edge.source_id, edge.target_id, 
            edge.relation.value, edge.weight, edge.model_dump_json(), 
            edge.created_at.isoformat()
        ))

    def get_node(self, node_id: str) -> Optional[NodeV1]:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT data_json FROM nodes WHERE id = ?", (node_id,)).fetchone()
            if row:
                return NodeV1.model_validate_json(row[0])
        return None

    def search_nodes(self, query: str, limit: int = 10, filters: Optional[Dict[str, Any]] = None) -> List[NodeV1]:
        query_str = "SELECT data_json FROM nodes WHERE (title LIKE ? OR content LIKE ?)"
        params = [f"%{query}%", f"%{query}%"]
        
        if filters:
            if "age_min" in filters:
                query_str += " AND age >= ?"
                params.append(filters["age_min"])
            if "age_max" in filters:
                query_str += " AND age <= ?"
                params.append(filters["age_max"])
            if "type" in filters:
                query_str += " AND type = ?"
                params.append(filters["type"])
            if "id_prefix" in filters:
                query_str += " AND id LIKE ?"
                params.append(f"{filters['id_prefix']}%")

        query_str += " LIMIT ?"
        params.append(limit)

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(query_str, params)
            return [NodeV1.model_validate_json(row[0]) for row in cursor]

    def validate_integrity(self) -> Dict[str, Any]:
        """Performs validation of the graph state."""
        report = {
            "node_count": 0,
            "md_node_count": 0,
            "duplicate_ids": [],
            "missing_required_fields": 0,
            "orphan_nodes": 0,
            "timeline_breaks": []
        }
        
        with sqlite3.connect(self.db_path) as conn:
            # Basic counts
            report["node_count"] = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
            # Content-based structured check (hacky but works for report)
            report["md_node_count"] = conn.execute("SELECT COUNT(*) FROM nodes WHERE data_json LIKE '%\"format\":\"md\"%'").fetchone()[0]
            
            # Orphan nodes (no edges)
            report["orphan_nodes"] = conn.execute("""
                SELECT COUNT(*) FROM nodes 
                WHERE id NOT IN (SELECT source_id FROM edges) 
                AND id NOT IN (SELECT target_id FROM edges)
            """).fetchone()[0]
            
            # Check for timeline breaks (e.g. gaps in 'next' chaining for MEMORY types)
            mem_nodes = conn.execute("SELECT id, age FROM nodes WHERE type='memory' ORDER BY age").fetchall()
            for i in range(len(mem_nodes) - 1):
                curr_id, curr_age = mem_nodes[i]
                next_id, next_age = mem_nodes[i+1]
                edge = conn.execute("SELECT id FROM edges WHERE source_id=? AND target_id=? AND relation='next'", (curr_id, next_id)).fetchone()
                if not edge:
                    report["timeline_breaks"].append(f"Missing NEXT edge between {curr_id} (age {curr_age}) and {next_id} (age {next_age})")

        return report

    def get_neighborhood(self, node_id: str, hops: int = 1) -> Tuple[List[NodeV1], List[EdgeV1]]:
        nodes_map = {}
        edges_map = {}
        to_visit = {node_id}
        visited = set()
        root = self.get_node(node_id)
        if not root: return [], []
        nodes_map[node_id] = root
        for _ in range(hops):
            current_batch = to_visit - visited
            if not current_batch: break
            visited.update(current_batch)
            next_to_visit = set()
            with sqlite3.connect(self.db_path) as conn:
                placeholder = ','.join(['?'] * len(current_batch))
                cursor = conn.execute(f"SELECT data_json FROM edges WHERE source_id IN ({placeholder}) OR target_id IN ({placeholder})", list(current_batch) + list(current_batch))
                for row in cursor:
                    edge = EdgeV1.model_validate_json(row[0])
                    edges_map[edge.id] = edge
                    next_to_visit.add(edge.source_id)
                    next_to_visit.add(edge.target_id)
            remaining = next_to_visit - set(nodes_map.keys())
            if remaining:
                with sqlite3.connect(self.db_path) as conn:
                    p = ','.join(['?'] * len(remaining))
                    c = conn.execute(f"SELECT data_json FROM nodes WHERE id IN ({p})", list(remaining))
                    for r in c:
                        n = NodeV1.model_validate_json(r[0])
                        nodes_map[n.id] = n
            to_visit = next_to_visit
        return list(nodes_map.values()), list(edges_map.values())

    def retrieve_context(self, query: str, max_nodes: int = 5, max_edges: int = 5, filters: Optional[Dict[str, Any]] = None, user_id: Optional[str] = None) -> Dict[str, Any]:
        # Pronoun Resolution: Map "my", "me", "I", "mine" to user_id
        query_l = query.lower()
        pronouns = [r"\bmy\b", r"\bme\b", r"\bi\b", r"\bmine\b"]
        is_personal = any(re.search(p, query_l) for p in pronouns)
        
        seed_nodes = []
        if is_personal and user_id:
            # Prioritize the user node itself as a seed
            user_node = self.get_node(user_id)
            if user_node:
                seed_nodes.append(user_node)
        
        # Supplement with search results
        search_limit = 2 - len(seed_nodes)
        if search_limit > 0:
            seed_nodes.extend(self.search_nodes(query, limit=search_limit, filters=filters))

        if not seed_nodes:
            return {"nodes": [], "edges": [], "context_str": "No relevant memories found."}
        all_nodes = []
        all_edges = []
        seen_nodes = set()
        seen_edges = set()
        for seed in seed_nodes:
            ns, es = self.get_neighborhood(seed.id, hops=1)
            for n in ns:
                if n.id not in seen_nodes and len(all_nodes) < max_nodes:
                    all_nodes.append(n)
                    seen_nodes.add(n.id)
            for e in es:
                if e.id not in seen_edges and len(all_edges) < max_edges:
                    all_edges.append(e)
                    seen_edges.add(e.id)
        ctx_lines = ["--- RELEVANT MEMORIES ---"]
        node_titles = {n.id: n.title for n in all_nodes}
        for n in all_nodes:
            ctx_lines.append(f"[{n.type.upper()}] {n.title}: {n.content}")
        for e in all_edges:
            s_title = node_titles.get(e.source_id, e.source_id)
            t_title = node_titles.get(e.target_id, e.target_id)
            rel_str = e.relation.value if hasattr(e.relation, "value") else str(e.relation)
            ctx_lines.append(f"RELATION: {s_title} --({rel_str})--> {t_title}")
        return {"nodes": all_nodes, "edges": all_edges, "context_str": "\n".join(ctx_lines)}

    def search_episodic(self, location: Optional[str] = None, timeframe: Optional[Tuple[datetime, datetime]] = None, limit: int = 10) -> List[NodeV1]:
        query_str = """
            SELECT n.data_json 
            FROM nodes n
            JOIN episodic_events e ON n.id = e.node_id
            WHERE 1=1
        """
        params = []
        if location:
            query_str += " AND e.location_id = ?"
            params.append(location)
        if timeframe:
            query_str += " AND e.event_timestamp BETWEEN ? AND ?"
            params.append(timeframe[0].isoformat())
            params.append(timeframe[1].isoformat())
            
        query_str += " ORDER BY e.event_timestamp DESC LIMIT ?"
        params.append(limit)
        
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(query_str, params)
            return [NodeV1.model_validate_json(row[0]) for row in cursor]
