import os
# DEPRECATED: Use root scripts/diagnose_tala.ts instead.
# This script is kept for legacy reference only.

import sys
import json
from datetime import datetime

# Add src to path
sys.path.append(os.getcwd())

from src.memory import MemorySystem, NodeType, EdgeType, ConfidenceBasis
from src.memory.schema import NodeV1, EdgeV1, Provenance, Confidence

def main():
    db_path = 'tala_memory_v1.db'
    if not os.path.exists(db_path):
        print(f"Error: Database {db_path} not found.")
        return

    ms = MemorySystem(db_path)

    print("--- STEP 2: Relationship Retrieval ---")
    # Search for Steven or any recent node
    result = ms.retrieve_context("Steven", max_nodes=3)
    nodes = result.get("nodes", [])
    if not nodes:
        print("No nodes for 'Steven'. Searching for 'User'...")
        result = ms.retrieve_context("User", max_nodes=3)
        nodes = result.get("nodes", [])
    
    for n in nodes:
        print(f"Node: [{n.type.value}] {n.title}")
        print(f"  Content snippet: {n.content[:100]}...")

    print("\n--- STEP 3: Write Episodic Memory ---")
    node_id = f"diag_{int(datetime.now().timestamp())}"
    node = NodeV1(
        id=node_id,
        type=NodeType.EVENT,
        title="Full Memory System Diagnostic",
        content="Antigravity successfully restored the tala-memory-graph MCP server and performed a full connectivity diagnostic.",
        metadata={
            "location": "Tala Core Engine",
            "emotional_context": "Successful/Analytical",
            "timestamp": datetime.now().isoformat()
        },
        provenance=Provenance(source_ref="diagnostic"),
        confidence=Confidence(score=1.0, basis=ConfidenceBasis.EXPLICIT)
    )
    ms.upsert_node(node)
    print(f"Created node: {node_id}")

    # Link to a primary node if found
    if nodes:
        target_id = nodes[0].id
        edge = EdgeV1(
            source_id=node_id,
            target_id=target_id,
            relation=EdgeType.RELATED_TO,
            weight=1.0,
            provenance=Provenance(source_ref="diagnostic"),
            confidence=Confidence(score=1.0, basis=ConfidenceBasis.EXPLICIT)
        )
        ms.upsert_edge(edge)
        print(f"Linked diagnostic node to: {nodes[0].title}")

    print("\n--- STEP 4: Verification of Retrieval ---")
    verified_result = ms.retrieve_context("Full Memory System Diagnostic")
    verified_nodes = verified_result.get("nodes", [])
    if verified_nodes:
        print(f"VERIFIED: Found {len(verified_nodes)} nodes.")
        for v in verified_nodes:
            print(f"- {v.title} (Score/Context match)")
    else:
        print("FAILED: Could not retrieve the newly created memory.")

if __name__ == "__main__":
    main()
