"""
src.memory — high-level pydantic-based memory API for tala-memory-graph.

Wraps the lower-level graph store (GraphStore or PostgresGraphStore) and
exposes a clean interface using validated NodeV1 / EdgeV1 models.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from .schema import (
    Confidence,
    ConfidenceBasis,
    EdgeType,
    EdgeV1,
    NodeType,
    NodeV1,
    Provenance,
)
from ..memory_graph.graph_store import GraphStore

__all__ = [
    "MemorySystem",
    "NodeType",
    "EdgeType",
    "ConfidenceBasis",
]


def _safe_node_type(value: str) -> NodeType:
    try:
        return NodeType(value)
    except ValueError:
        return NodeType.FACT


def _safe_edge_type(value: str) -> EdgeType:
    try:
        return EdgeType(value)
    except ValueError:
        return EdgeType.RELATED_TO


def _row_to_node(row: Dict[str, Any]) -> NodeV1:
    """Convert a raw GraphStore node dict to a NodeV1 pydantic model."""
    attrs: Dict[str, Any] = {}
    try:
        attrs = json.loads(row.get("attrs_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        pass

    prov_data = attrs.pop("provenance", {}) or {}
    conf_data = attrs.pop("confidence", {}) or {}
    content = attrs.pop("content", "") or ""
    metadata = attrs.pop("metadata", attrs) if "metadata" in attrs else attrs

    return NodeV1(
        id=row["node_id"],
        type=_safe_node_type(row.get("type", "fact")),
        title=row.get("name", ""),
        content=content,
        metadata=metadata,
        provenance=Provenance(**prov_data) if prov_data else Provenance(),
        confidence=Confidence(**conf_data) if conf_data else Confidence(),
    )


def _row_to_edge(row: Dict[str, Any]) -> EdgeV1:
    """Convert a raw GraphStore edge dict to an EdgeV1 pydantic model."""
    attrs: Dict[str, Any] = {}
    try:
        attrs = json.loads(row.get("attrs_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        pass

    prov_data = attrs.pop("provenance", {}) or {}
    conf_data = attrs.pop("confidence", {}) or {}
    weight = attrs.pop("weight", 1.0)

    return EdgeV1(
        source_id=row["src_id"],
        target_id=row["dst_id"],
        relation=_safe_edge_type(row.get("rel_type", "related_to")),
        weight=float(weight),
        provenance=Provenance(**prov_data) if prov_data else Provenance(),
        confidence=Confidence(**conf_data) if conf_data else Confidence(),
    )


def _node_to_row_args(node: NodeV1) -> tuple:
    """Convert a NodeV1 to args for GraphStore.upsert_node."""
    attrs = {
        "content": node.content,
        "metadata": node.metadata,
        "provenance": node.provenance.model_dump(),
        "confidence": node.confidence.model_dump(),
    }
    return node.id, node.type.value, node.title, attrs


def _edge_to_row_args(edge: EdgeV1) -> tuple:
    """Convert an EdgeV1 to args for GraphStore.upsert_edge."""
    edge_id = hashlib.md5(
        f"{edge.source_id}:{edge.target_id}:{edge.relation.value}".encode()
    ).hexdigest()
    attrs = {
        "weight": edge.weight,
        "provenance": edge.provenance.model_dump(),
        "confidence": edge.confidence.model_dump(),
    }
    return edge_id, edge.source_id, edge.target_id, edge.relation.value, attrs


class MemorySystem:
    """
    High-level memory interface backed by a graph store.

    Accepts either an explicit *store* instance (preferred) or a *db_path*
    string for backwards-compatible SQLite initialisation.  When neither is
    supplied an error is raised so misconfigured callers fail loudly.

    All public methods accept and return pydantic models (NodeV1, EdgeV1) so
    callers never have to deal with raw SQL rows or JSON serialisation.
    """

    def __init__(
        self,
        db_path: Optional[str] = None,
        store: Optional[Any] = None,
    ) -> None:
        if store is not None:
            self._store = store
        elif db_path is not None:
            self._store = GraphStore(db_path)
        else:
            raise ValueError(
                "MemorySystem requires either a 'store' instance or a 'db_path' string."
            )

    # ------------------------------------------------------------------
    # Identity
    # ------------------------------------------------------------------

    def run_identity_migration(self, user_id: str) -> None:
        """
        Ensure a PERSON node exists for the primary user and merge any
        legacy anonymous nodes that reference the same identity.

        This is a best-effort operation; failures are non-fatal.
        """
        try:
            existing = self._store.search_nodes(user_id)
            already_present = any(
                r.get("type") == "person" and r.get("node_id") == user_id
                for r in existing
            )
            if not already_present:
                self._store.upsert_node(
                    user_id,
                    NodeType.PERSON.value,
                    user_id,
                    {
                        "content": f"Primary user identity: {user_id}",
                        "metadata": {"migrated_at": datetime.now().isoformat()},
                        "provenance": {"source_ref": "identity_migration"},
                        "confidence": {
                            "score": 1.0,
                            "basis": ConfidenceBasis.EXPLICIT.value,
                        },
                    },
                )
        except (OSError, ValueError, KeyError):
            # Migration is best-effort; storage or schema errors are non-fatal
            pass

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def upsert_node(self, node: NodeV1) -> None:
        node_id, type_val, title, attrs = _node_to_row_args(node)
        self._store.upsert_node(node_id, type_val, title, attrs)

    def upsert_edge(self, edge: EdgeV1) -> None:
        edge_id, src, dst, rel, attrs = _edge_to_row_args(edge)
        self._store.upsert_edge(edge_id, src, dst, rel, attrs)

    # ------------------------------------------------------------------
    # Interaction processing
    # ------------------------------------------------------------------

    def process_interaction(
        self, text: str, source_ref: str = "interaction"
    ) -> List[NodeV1]:
        """
        Extract and store a memory from a raw interaction string.

        For now this creates a single EVENT node capturing the full text.
        Future: run NER / entity extraction and emit multiple typed nodes.
        """
        node_id = f"evt_{uuid.uuid4().hex[:12]}"
        # Use the first 80 chars as a title; full text goes to content.
        title = text[:80].strip()
        node = NodeV1(
            id=node_id,
            type=NodeType.EVENT,
            title=title,
            content=text,
            metadata={"source_ref": source_ref, "ts": datetime.now().isoformat()},
            provenance=Provenance(source_ref=source_ref),
            confidence=Confidence(
                score=0.9, basis=ConfidenceBasis.OBSERVED
            ),
        )
        self.upsert_node(node)
        return [node]

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def search(self, query: str) -> List[NodeV1]:
        """Return nodes whose name or type matches the query string."""
        rows = self._store.search_nodes(query)
        return [_row_to_node(r) for r in rows]

    def get_neighborhood(self, node_id: str, depth: int = 1) -> List[NodeV1]:
        """Return the node and all neighbours up to *depth* hops."""
        result = self._store.get_neighborhood(node_id, depth)
        return [_row_to_node(r) for r in result.get("nodes", [])]

    def retrieve_context(
        self,
        query: str,
        max_nodes: int = 5,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Perform a best-effort semantic/keyword retrieval.

        Returns a dict with keys:
          - ``nodes``      : List[NodeV1]
          - ``edges``      : List[EdgeV1]
          - ``context_str``: human-readable summary string
        """
        raw_nodes = self._store.search_nodes(query)
        if user_id:
            # Also pull in identity-linked nodes and merge (deduplicated)
            id_nodes = self._store.search_nodes(user_id)
            seen = {r["node_id"] for r in raw_nodes}
            for r in id_nodes:
                if r["node_id"] not in seen:
                    raw_nodes.append(r)
                    seen.add(r["node_id"])
        top_nodes = raw_nodes[:max_nodes]

        all_node_rows: Dict[str, Any] = {}
        all_edge_rows: Dict[str, Any] = {}

        for row in top_nodes:
            nid = row["node_id"]
            nb = self._store.get_neighborhood(nid, depth=1)
            for n in nb.get("nodes", []):
                all_node_rows[n["node_id"]] = n
            for e in nb.get("edges", []):
                all_edge_rows[e["edge_id"]] = e

        nodes = [_row_to_node(r) for r in all_node_rows.values()]
        edges = [_row_to_edge(r) for r in all_edge_rows.values()]

        if not nodes:
            return {
                "nodes": [],
                "edges": [],
                "context_str": "No relevant graph context found.",
            }

        lines = [f"[{n.type.value.upper()}] {n.title}" for n in nodes[:max_nodes]]
        context_str = "Graph context:\n" + "\n".join(lines)

        return {"nodes": nodes, "edges": edges, "context_str": context_str}
