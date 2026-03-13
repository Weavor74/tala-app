# 05 — Storage, Privacy & Retention

**Document Version**: 1.0.0
**Status**: Legal-Grade, Audit-Ready

## 1. Storage Architecture

All reflection data is stored within the application's local `data` directory.

- **Reflections**: `./memory/reflections/` (JSONL format for high-speed append).
- **Proposals**: `./memory/proposals/` (JSON).
- **Outcomes**: `./memory/outcomes/` (JSON).
- **Index**: `./memory/reflection_index.json` (Consolidated metadata for UI).

## 2. Privacy & Sovereignty

- **No Remote Telemetry**: Reports are never sent to a central server.
- **Local Vectors**: If the Reflection Engine uses semantic search, it relies on the local `tala-core` RAG server.
- **PII Protection**: TALA is instructed to redact or skip sections of logs containing sensitive user information (passwords, specific personal addresses) during the "Analyze" stage.

## 3. Retention Policy

To prevent the application storage from growing indefinitely, a configurable retention policy is enforced:

- **Default Retention**: 30 Days (configurable via `reflection.retentionDays`).
- **Cleanup Cycle**: Every 24 hours, the `ArtifactStore` purges records older than the retention limit.
- **Pinned Records**: Users can "Pin" specific reflections or outcomes to exempt them from auto-purge.

---
**END OF STORAGE SPECIFICATION**
