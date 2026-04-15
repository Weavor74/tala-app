# Technology Stack

This document lists core technologies and the current runtime posture used in Tala.

## 1. Desktop Application

- Framework: Electron
- Runtime: Node.js
- Language: TypeScript
- UI: React
- Build: Vite

## 2. Agent and Orchestration Layer

- Agent orchestration: Electron services (`AgentService`, router, guardrails, runtime control)
- Protocol boundary: Model Context Protocol (MCP)
- IPC boundary: Electron preload/context isolation

## 3. Inference Stack (Current)

- Provider management: `InferenceProviderRegistry` + `ProviderSelectionService`
- Selection posture: deterministic, local-first waterfall
- Top-priority provider in auto mode: Ollama (when ready)
- Additional local providers: vLLM, llama.cpp, KoboldCpp
- Embedded fallbacks: `embedded_vllm`, `embedded_llamacpp`
- Optional remote path: cloud provider (configured/available only)

## 4. Canonical Memory and Retrieval

- Canonical durable memory authority: PostgreSQL
- Canonical write boundary: `MemoryAuthorityService`
- Derived memory layers: mem0, graph projections, vector projections, summaries, caches
- Vector capability: pgvector in Postgres when extension is installed

## 5. Storage Architecture

- Storage registry: `StorageProviderRegistryService`
- Role assignment policy: `StorageAssignmentPolicyService`
- Explicit storage roles: canonical memory, vector index, blob store, document store, backup target, artifact store
- Assignment rules: capability/locality/auth/health validated and deterministic

## 6. Operational Tooling

- Testing: Vitest
- Documentation gates: `docs:regen`, `docs:heal`, `docs:validate`, `docs:heal-and-validate`
- Telemetry and diagnostics: runtime health, provider probes, authority and drift checks
