# Phase 7 — Testing and Observability

This phase ensures that the memory system is **auditable**, **understandable**, and **regressed**.

## 1. Traceability & Explainability

A "Memory Verdict" is generated for every retrieval, answering: **"Why was this memory shown?"**

- **Explainability Metrics**:
  - **Relevance Score**: Vector cosine similarity (mem0).
  - **Salience Multiplier**: Emotional boost (Phase 6).
  - **Graph Depth**: Hop distance from the query entity.
  - **Confidence**: Base confidence score (Phase 3).

## 2. Memory Audit Logs

Every write is logged in a deterministic `audit.log` (JSONL):
```json
{
  "timestamp": "...",
  "action": "COMMIT",
  "node_id": "node_883",
  "content": "Summarized content",
  "provenance_ref": "interaction_xyz",
  "validation_score": 0.88,
  "status": "DURABLE"
}
```

## 3. Testing Strategy

### 3.1 Unit Tests
- `test_schemas.py`: Schema validation.
- `test_validator.py`: Secret detection and confidence gating.
- `test_graph.py`: SQLite persistence and k-hop retrieval.

### 3.2 Regression Tests
- **Extraction Consistency**: Ensure the same prompt extracts the same facts from a fixed dataset.
- **Safety Bounds**: Verify that "Small Models" cannot inject insecure rules into the graph.

## 4. Observability Dashboard (Future)
A web-based "Memory Viewer" (already hinted in `MemoryViewer.tsx`) to visualize:
- Node clusters.
- High-risk/Low-confidence nodes.
- Provenance lineages.
