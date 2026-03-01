# Tala Structured Memory Metadata Schema (Phase 1)

**Version**: 1.0.0
**Status**: Deterministic / Production-Grade

This document defines the schema for Tala's long-term cognitive backbone. The schema is designed for **traceability**, **explainability**, and **auditability**.

## 1. Design Philosophy

- **Small Ontology**: We limit complexity by using a restricted set of Node and Edge types.
- **Evidence-First**: Every memory atom MUST have a `Provenance` block.
- **Confidence Vectors**: Confidence is not just a number; it includes model certainty and user verification status.
- **Astro Integration**: Emotional context is stored in `metadata`, influencing retrieval priority (salience) without corrupting facts.

## 2. Component Reference

### 2.1 Nodes (`MemoryNode`)
The fundamental atoms of memory.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | UUID | Unique identifier. |
| `type` | Enum | `entity`, `concept`, `event`, or `rule`. |
| `content` | String | The ground truth fact or summary. |
| `provenance` | Object | Traceability metadata (Source, Evidence, Author). |
| `confidence` | Object | Multi-vector scoring. |
| `privacy` | Enum | `internal`, `private`, or `shared`. |
| `retention` | Enum | `ephemeral`, `durable`, or `expiring`. |

### 2.2 Edges (`MemoryEdge`)
Directed relationships between nodes.

| Field | Type | Description |
| :--- | :--- | :--- |
| `source` | UUID | ID of the origin node. |
| `target` | UUID | ID of the destination node. |
| `relation` | Enum | `owns`, `uses`, `depends_on`, `related_to`, `defines`, `caused_by`. |
| `weight` | Float | (0.0 - 10.0) Relationship strength. |

### 2.3 Provenance
Required for all durable memories.

- **Source ID**: The file path, session ID, or tool name.
- **Evidence Snippet**: The exact quote from the user or tool output.
- **Author**: The entity that generated the extraction.

## 3. Validation Rules

1. **Schema Match**: All writes must validate against the Pydantic models in `models/schemas.py`.
2. **Confidence Threshold**: Memories with `overall_confidence < 0.4` (configurable) are treated as "candidates" and not stored in the core graph.
3. **Evidence Requirement**: Durable memories without a valid `evidence_snippet` are rejected.
4. **Author Integrity**: Users can override/author truth; SLMs can only suggest.

## 4. Examples

### Codebase Entity
```json
{
  "type": "entity",
  "content": "tala-app is a Vite-based Electron application.",
  "provenance": {
    "source_id": "package.json",
    "evidence_snippet": "\"name\": \"tala-app\", \"devDependencies\": { \"vite\": \"...\" }",
    "author": "agent-ingest"
  },
  "confidence": { "overall": 1.0 }
}
```

### Event Memory
```json
{
  "type": "event",
  "content": "Tool 'self_modify' failed on file 'RiskEngine.ts' due to permission error.",
  "provenance": {
    "source_id": "session_882",
    "evidence_snippet": "Error: EPERM: operation not permitted, open 'RiskEngine.ts'",
    "author": "system"
  },
  "confidence": { "overall": 1.0 }
}
```
