# Phase 5 — Integration with mem0

This phase bridges the **Vector Memory** (mem0) with the **Structured Graph** (Phase 4).

## 1. Dual-Storage Strategy

- **Vector (mem0)**: Excellent for fuzzy semantic search (e.g., "What did we talk about regarding themes?").
- **Graph (Tala-Graph)**: Excellent for precise relationship traversal (e.g., "What tools depend on the RiskEngine?").

### Data Flow
1. **Extraction**: Phase 2 extracts a fact.
2. **Validation**: Phase 3 validates it.
3. **Write**:
   - Fact text is sent to `mem0_add`.
   - Fact node + edges are sent to `GraphStore`.
   - Node ID and mem0 memory ID are cross-referenced in metadata.

## 2. Idempotency & De-duplication

To prevent the graph from becoming "noisy," we check for existence before writing:
- **Node Hash**: Generate a hash of `content.normalized().lower()`.
- **Match Policy**: If a node with the same hash exists, update its `Provenance` and `Confidence` instead of creating a new one.

## 3. Hybrid Retrieval

The `MemoryService` (TypeScript) or a Python orchestration layer performs hybrid retrieval:

1. **Vector First**: Search mem0 for a query (e.g., "Dependency issues").
2. **Entity Bridge**: Extract the primary Entity from the top vector result.
3. **Graph Expansion**: Expand 1-hop around that Entity in the Graph.
4. **Context Synthesis**: Combine vector text + graph expansion for the LLM prompt.

## 4. Implementation (MemoryAdapter)

```python
class MemoryAdapter:
    def __init__(self, graph: GraphStore, mem0: Any):
        self.graph = graph
        self.mem0 = mem0

    async def store_fact(self, candidate: MemoryCandidate):
        # 1. Store in mem0 (vector)
        mem0_id = await self.mem0.add(candidate.content)
        
        # 2. Store in Graph
        node = MemoryNode(...)
        node.metadata["mem0_ref"] = mem0_id
        self.graph.add_node(node)
```
