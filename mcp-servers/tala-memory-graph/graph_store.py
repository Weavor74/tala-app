import sqlite3
import json
from typing import List, Optional, Dict, Any
from models.schemas import MemoryNode, MemoryEdge, MemoryGraphExport
from datetime import datetime

class GraphStore:
    """Persistent storage engine for the memory graph."""
    
    def __init__(self, db_path: str = "tala_memory.db"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        """Initializes the SQLite schema."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS nodes (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS edges (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    target TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    weight REAL DEFAULT 1.0,
                    data_json TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(source) REFERENCES nodes(id),
                    FOREIGN KEY(target) REFERENCES nodes(id)
                )
            """)
            # Index for fast relationship lookup
            conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target)")

    def add_node(self, node: MemoryNode):
        """Persists a memory node."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO nodes (id, type, content, data_json) VALUES (?, ?, ?, ?)",
                (node.id, node.type, node.content, node.model_dump_json())
            )

    def add_edge(self, edge: MemoryEdge):
        """Persists a memory edge."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO edges (id, source, target, relation, weight, data_json) VALUES (?, ?, ?, ?, ?, ?)",
                (edge.id, edge.source, edge.target, edge.relation, edge.weight, edge.model_dump_json())
            )

    def get_node(self, node_id: str) -> Optional[MemoryNode]:
        """Retrieves a single node by ID."""
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT data_json FROM nodes WHERE id = ?", (node_id,)).fetchone()
            if row:
                return MemoryNode.model_validate_json(row[0])
        return None

    def get_neighbors(self, node_id: str, depth: int = 1) -> MemoryGraphExport:
        """
        Retrieves a subgraph centered around the node_id.
        Currently implements a simple 1-hop expansion.
        """
        nodes = []
        edges = []
        visited_nodes = set()
        
        root = self.get_node(node_id)
        if not root:
            return MemoryGraphExport(nodes=[], edges=[])
            
        nodes.append(root)
        visited_nodes.add(node_id)
        
        with sqlite3.connect(self.db_path) as conn:
            # Get edges where node_id is source or target
            cursor = conn.execute(
                "SELECT data_json, source, target FROM edges WHERE source = ? OR target = ?",
                (node_id, node_id)
            )
            for row in cursor:
                edge = MemoryEdge.model_validate_json(row[0])
                edges.append(edge)
                
                # Add the other side of the edge to the node list
                other_id = row[2] if row[1] == node_id else row[1]
                if other_id not in visited_nodes:
                    other_node = self.get_node(other_id)
                    if other_node:
                        nodes.append(other_node)
                        visited_nodes.add(other_id)
                        
        return MemoryGraphExport(nodes=nodes, edges=edges)

    def list_all_nodes(self) -> List[MemoryNode]:
        """Safety/Admin tool to list everything."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("SELECT data_json FROM nodes")
            return [MemoryNode.model_validate_json(row[0]) for row in cursor]
