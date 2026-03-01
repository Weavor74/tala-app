# Phase 4 — Graph Memory Layer

The Graph Layer handles the durable storage and structural retrieval of validated memories.

## 1. Backend Comparison & Decision

| Feature | SQLite (Relational) | NetworkX (In-Memory) | Neo4j (Graph DB) |
| :--- | :--- | :--- | :--- |
| **Persistence** | Native file-based | No (must serialize) | Native server-based |
| **Performance** | High for small graphs | Very high (RAM) | High for complex paths |
| **Portability** | Excellent (1 file) | Good (JSON/Pickle) | Poor (Requires server) |
| **Determinism** | High (Transactions) | High | Variable |

**Recommendation**: **SQLite** for primary persistence + **NetworkX** for in-memory graph algorithms (k-hop, centrality) during retrieval.

## 2. SQLite Schema Design

We use a simple triplets-style schema to ensure flexibility and no vendor lock-in.

### Nodes Table
- `id` (TEXT, PK)
- `type` (TEXT)
- `content` (TEXT)
- `data_json` (TEXT) - Stores the full `MemoryNode` (metadata, provenance).
- `created_at` (DATETIME)

### Edges Table
- `id` (TEXT, PK)
- `source` (TEXT, FK)
- `target` (TEXT, FK)
- `relation` (TEXT)
- `weight` (REAL)
- `data_json` (TEXT)

## 3. Retrieval Logic: Neighborhood Expansion

To provide context to Tala, we use "k-hop" retrieval:
1. Start with an Entity (e.g., "Steve").
2. Retrieve all nodes within 1 or 2 hops (Edges).
3. Result: "Steve" -> USES -> "Tala-App" -> DEPENDS_ON -> "Vite".

## 4. Implementation (GraphStore)

```python
class GraphStore:
    """Pluggable interface for graph storage."""
    def add_node(self, node: MemoryNode): ...
    def add_edge(self, edge: MemoryEdge): ...
    def get_neighbors(self, node_id: str, depth: int = 1) -> GraphExport: ...
```
