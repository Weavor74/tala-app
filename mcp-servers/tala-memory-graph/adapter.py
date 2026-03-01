import hashlib
from typing import Optional, List
from graph_store import GraphStore
from extractor import MemoryCandidate
from models.schemas import MemoryNode, Provenance, ConfidenceScore

class MemoryAdapter:
    """Synchronizes vector (mem0) and graph storage."""
    
    def __init__(self, graph: GraphStore, mem0_client: Optional[any] = None):
        self.graph = graph
        self.mem0 = mem0_client

    def _generate_node_hash(self, content: str) -> str:
        """Generates a unique deterministic ID based on normalized content."""
        normalized = content.strip().lower()
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    async def sync_candidate(self, candidate: MemoryCandidate) -> str:
        """
        Stores a validated candidate in both vector and graph stores.
        Returns the Node ID.
        """
        node_id = self._generate_node_hash(candidate.content)
        
        # 1. Store in mem0 (Vector) if available
        mem0_ref = None
        if self.mem0:
            try:
                # Assuming mem0 tool/client interface
                mem0_ref = await self.mem0.add(candidate.content, metadata=candidate.metadata)
            except Exception as e:
                print(f"[Adapter] mem0 sync failed: {e}")

        # 2. Store in Graph (Structural)
        existing_node = self.graph.get_node(node_id)
        
        if existing_node:
            # Update existing node (Cumulative provenance)
            # In a real system, we'd append to a provenance list
            existing_node.confidence.overall = max(existing_node.confidence.overall, candidate.confidence)
            existing_node.updated_at = candidate.metadata.get("timestamp", existing_node.updated_at)
            self.graph.add_node(existing_node)
            return node_id
        
        # Create new node
        node = MemoryNode(
            id=node_id,
            type=candidate.type,
            content=candidate.content,
            metadata={**candidate.metadata, "mem0_ref": mem0_ref},
            provenance=Provenance(
                source_id=candidate.source_id,
                evidence_snippet=candidate.evidence,
                author=candidate.author
            ),
            confidence=ConfidenceScore(overall=candidate.confidence)
        )
        
        self.graph.add_node(node)
        
        # 3. Add Edges
        # Potential enhancement: Automated entity discovery in content
        
        return node_id

    async def hybrid_search(self, query: str, limit: int = 5) -> List[dict]:
        """
        Performs vector search followed by graph expansion.
        """
        # 1. Vector Search (fuzzy)
        # 2. Graph Expansion (structural)
        # Mock result for now
        return []
