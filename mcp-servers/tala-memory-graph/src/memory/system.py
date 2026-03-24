from __future__ import annotations
from typing import List, Dict, Any, Optional
from .graph import SQLiteGraphBackend
from .schema import NodeV1, EdgeV1
from .extract import MemoryExtractor
from .validate import MemoryValidator
from .emotion import EmotionWeighter
from .logger import AuditLogger

from .extract import MemoryExtractor, LTMFExtractor
from .validate import MemoryValidator
from .emotion import EmotionWeighter
from .logger import AuditLogger
import os
import sqlite3
from .schema import NodeV1, EdgeV1, EdgeType, Provenance, Confidence, ConfidenceBasis

class MemorySystem:
    """
    Unified entry point for the Tala Memory System.
    Coordinates extraction, validation, storage, and LTMF migration.
    """

    def __init__(self, db_path: str = "tala_memory_v1.db", log_path: str = "memory_audit.jsonl"):
        self.graph = SQLiteGraphBackend(db_path)
        self.extractor = MemoryExtractor()
        self.ltmf_extractor = LTMFExtractor()
        self.validator = MemoryValidator()
        self.logger = AuditLogger(log_path)
        self.use_structured = True # USE_STRUCTURED_LTMF_MD feature flag

    def upsert_node(self, node: NodeV1, conn: Optional[sqlite3.Connection] = None):
        self.graph.upsert_node(node, conn=conn)

    def upsert_edge(self, edge: EdgeV1, conn: Optional[sqlite3.Connection] = None):
        self.graph.upsert_edge(edge, conn=conn)

    def search(self, query: str, filters: Optional[Dict[str, Any]] = None) -> List[NodeV1]:
        return self.graph.search_nodes(query, filters=filters)

    def search_episodic(self, location: Optional[str] = None, timeframe: Optional[Tuple[datetime, datetime]] = None, limit: int = 10) -> List[NodeV1]:
        return self.graph.search_episodic(location, timeframe, limit)

    def retrieve_context(self, query: str, max_nodes: int = 5, max_edges: int = 5, 
                         emotion: str = "neutral", intensity: float = 0.5,
                         filters: Optional[Dict[str, Any]] = None,
                         user_id: Optional[str] = None) -> Dict[str, Any]:
        """Retrieves context with optional emotional weighting and filters."""
        # 1. Base Retrieval
        result = self.graph.retrieve_context(query, max_nodes, max_edges, filters=filters, user_id=user_id)
        
        # 2. Emotional Weighting
        weighter = EmotionWeighter(emotion, intensity)
        result["nodes"] = weighter.reorder_results(result["nodes"])
        
        # 3. Re-format context_str after reordering node list
        ctx_lines = ["--- RELEVANT MEMORIES (EMOTION: {}) ---".format(emotion.upper())]
        node_titles = {n.id: n.title for n in result["nodes"]}
        for n in result["nodes"]:
            ctx_lines.append(f"[{n.type.upper()}] {n.title}: {n.content}")
        
        for e in result["edges"]:
            s_title = node_titles.get(e.source_id, e.source_id)
            t_title = node_titles.get(e.target_id, e.target_id)
            rel_str = e.relation.value if hasattr(e.relation, "value") else str(e.relation)
            ctx_lines.append(f"RELATION: {s_title} --({rel_str})--> {t_title}")
            
        result["context_str"] = "\n".join(ctx_lines)
        return result

    def ingest_ltmf_file(self, file_path: str, conn: Optional[sqlite3.Connection] = None) -> List[str]:
        """Idempotent ingestion of a single LTMF file."""
        nodes, edges = self.ltmf_extractor.extract_from_file(file_path)
        stored_ids = []
        
        # First, ensure all nodes are valid and stored
        title_to_id = {}
        for nc in nodes:
            nc.metadata['source_path'] = file_path
            is_valid, reason, node = self.validator.validate_node(nc)
            if is_valid and node:
                self.upsert_node(node, conn=conn)
                stored_ids.append(node.id)
                title_to_id[node.title] = node.id
            else:
                import sys; sys.stderr.write(f"[VALIDATION FAILED] {nc.title}: {reason}\n")
        
        # Then, store edges. If edge has title but no id, resolve it.
        for ec in edges:
            if ec.target_title and not ec.target_id:
                ec.target_id = title_to_id.get(ec.target_title)
            
            if ec.source_id and ec.target_id:
                is_valid, reason, edge = self.validator.validate_edge(ec, ec.source_id, ec.target_id)
                if is_valid and edge:
                    self.upsert_edge(edge, conn=conn)

        return stored_ids

    def ingest_ltmf_directory(self, dir_path: str) -> Dict[str, int]:
        """Recursively scans and ingests all .md files in a single session/transaction."""
        results = {"success": 0, "error": 0}
        with sqlite3.connect(self.graph.db_path) as conn:
            conn.execute("PRAGMA journal_mode=WAL") # Optimization for concurrent reads
            conn.execute("PRAGMA synchronous=NORMAL")
            for root, _, files in os.walk(dir_path):
                for file in files:
                    if file.endswith('.md'):
                        try:
                            self.ingest_ltmf_file(os.path.join(root, file), conn=conn)
                            results["success"] += 1
                            if results["success"] % 50 == 0:
                                import sys; sys.stderr.write(f"[MemorySystem] Ingested {results['success']} files...\n")
                        except Exception as e:
                            import sys; sys.stderr.write(f"[MemorySystem] Failed to ingest {file}: {e}\n")
                            results["error"] += 1
            conn.commit()
        return results

    def link_timeline(self):
        """Creates NEXT/PREV edges for MEMORY nodes based on age."""
        # Retrieve all memory nodes sorted by age
        query = "SELECT data_json FROM nodes WHERE type='memory' ORDER BY age"
        with sqlite3.connect(self.graph.db_path) as conn:
            cursor = conn.execute(query)
            memories = [NodeV1.model_validate_json(row[0]) for row in cursor]
        
        for i in range(len(memories) - 1):
            curr = memories[i]
            nxt = memories[i+1]
            
            # Create NEXT edge
            edge_id = f"next_{curr.id}_{nxt.id}"
            next_edge = EdgeV1(
                id=edge_id,
                source_id=curr.id,
                target_id=nxt.id,
                relation=EdgeType.NEXT,
                provenance=Provenance(source_ref="timeline_linker"),
                confidence=Confidence(score=1.0, basis=ConfidenceBasis.COMPUTED)
            )
            self.upsert_edge(next_edge)
            
            # Create PREV edge
            edge_id_prev = f"prev_{nxt.id}_{curr.id}"
            prev_edge = EdgeV1(
                id=edge_id_prev,
                source_id=nxt.id,
                target_id=curr.id,
                relation=EdgeType.PREV,
                provenance=Provenance(source_ref="timeline_linker"),
                confidence=Confidence(score=1.0, basis=ConfidenceBasis.COMPUTED)
            )
            self.upsert_edge(prev_edge)

    def run_identity_migration(self, current_user_id: str):
        """
        Migrates legacy 'user' nodes to the current canonical UUID.
        Identifies nodes by entity_type == 'user' where ID is not a UUID.
        """
        if not current_user_id or len(current_user_id) < 32:
            return

        import json
        import re
        
        # UUID regex (simple)
        uuid_pattern = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
        
        query = "SELECT node_id, name, attrs_json, data_json FROM nodes WHERE type='entity' AND name IN (SELECT name FROM nodes WHERE type='entity')" 
        # Actually, let's just look for user-like entities.
        # In current schema, 'type' is NodeType.ENTITY (which is "entity")
        
        with sqlite3.connect(self.graph.db_path) as conn:
            cursor = conn.execute("SELECT node_id, title, metadata, data_json FROM nodes WHERE type='entity'")
            # The schema uses 'title' not 'name' in the NodeV1 model, but 'name' in the DB table 'nodes'?
            # Let's check the schema.sql again. 
            # node_id, type, name, attrs_json
            
            cursor = conn.execute("SELECT node_id, name, attrs_json FROM nodes WHERE type='entity'")
            rows = cursor.fetchall()
            
            migration_count = 0
            for node_id, name, attrs_json in rows:
                try:
                    attrs = json.loads(attrs_json)
                except:
                    attrs = {}
                
                is_user = attrs.get('entity_type') == 'user' or name.lower() in ['user', 'primary-user', 'human']
                
                if is_user:
                    # Check if ID is NOT a valid UUID
                    if not uuid_pattern.match(node_id):
                        # Migrate!
                        new_id = current_user_id
                        
                        # Store old ID as alias
                        aliases = attrs.get('aliases', [])
                        if node_id not in aliases:
                            aliases.append(node_id)
                        attrs['aliases'] = aliases
                        attrs['migration_source'] = 'legacy_id_hardening'
                        
                        # Update the DB
                        conn.execute(
                            "UPDATE nodes SET node_id = ?, attrs_json = ? WHERE node_id = ?",
                            (new_id, json.dumps(attrs), node_id)
                        )
                        # Also update edges!
                        conn.execute("UPDATE edges SET src_id = ? WHERE src_id = ?", (new_id, node_id))
                        conn.execute("UPDATE edges SET dst_id = ? WHERE dst_id = ?", (new_id, node_id))
                        
                        migration_count += 1
            
            if migration_count > 0:
                conn.commit()
                import sys
                sys.stderr.write(f"[MemorySystem] Identity migration completed for {migration_count} legacy user nodes.\n")

    def process_interaction(self, text: str, source_ref: str) -> List[str]:
        """Processes raw text interaction to extract and store nodes/edges."""
        nodes, edges = self.extractor.extract(text, source_ref)
        stored_ids = []
        title_to_id = {}

        for nc in nodes:
            is_valid, reason, node = self.validator.validate_node(nc)
            if is_valid and node:
                self.upsert_node(node)
                stored_ids.append(node.id)
                title_to_id[node.title] = node.id
                self.logger.log_commit(node.id, node.content, node.confidence.score)
            else:
                import sys; sys.stderr.write(f"[Interaction Validation Failed] {nc.title}: {reason}\n")

        # Resolve edges (e.g., link event to location)
        for ec in edges:
            if not ec.source_id and len(stored_ids) > 0:
                ec.source_id = stored_ids[0] # Link to the first node (usually the memory)
            
            if ec.target_title and not ec.target_id:
                ec.target_id = title_to_id.get(ec.target_title)

            if ec.source_id and ec.target_id:
                is_valid, reason, edge = self.validator.validate_edge(ec, ec.source_id, ec.target_id)
                if is_valid and edge:
                    self.upsert_edge(edge)

        return stored_ids
