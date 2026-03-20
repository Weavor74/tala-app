import sqlite3
import json
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
    def search_nodes(self, query: str, limit: int = 10) -> List[NodeV1]: pass
    @abstractmethod
    def retrieve_context(self, query: str, max_nodes: int = 5, max_edges: int = 5) -> Dict[str, Any]: pass

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
            conn.execute("CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(title)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)")

    def upsert_node(self, node: NodeV1):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO nodes (id, version, type, title, content, data_json, confidence_score, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    content=excluded.content,
                    data_json=excluded.data_json,
                    confidence_score=excluded.confidence_score,
                    updated_at=excluded.updated_at
            """, (
                node.id, node.version, node.type, node.title, node.content, 
                node.model_dump_json(), node.confidence.score, 
                node.created_at.isoformat(), datetime.now().isoformat()
            ))

    def upsert_edge(self, edge: EdgeV1):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO edges (id, version, source_id, target_id, relation, weight, data_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    weight=excluded.weight,
                    data_json=excluded.data_json
            """, (
                edge.id, edge.version, edge.source_id, edge.target_id, 
                edge.relation, edge.weight, edge.model_dump_json(), 
                edge.created_at.isoformat()
            ))

    def get_node(self, node_id: str) -> Optional[NodeV1]:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT data_json FROM nodes WHERE id = ?", (node_id,)).fetchone()
            if row:
                return NodeV1.model_validate_json(row[0])
        return None

    def search_nodes(self, query: str, limit: int = 10) -> List[NodeV1]:
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "SELECT data_json FROM nodes WHERE title LIKE ? OR content LIKE ? LIMIT ?",
                (f"%{query}%", f"%{query}%", limit)
            )
            return [NodeV1.model_validate_json(row[0]) for row in cursor]

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

    def retrieve_context(self, query: str, max_nodes: int = 5, max_edges: int = 5) -> Dict[str, Any]:
        seed_nodes = self.search_nodes(query, limit=2)
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
