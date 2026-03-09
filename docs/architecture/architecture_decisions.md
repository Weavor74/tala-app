# Architectural Decisions

This document captures the key design decisions, trade-offs, and rationale behind the Tala system architecture.

## AD-01: Choice of Electron for Desktop Shell
- **Decision**: Use Electron (React + Node.js) as the primary application host.
- **Rationale**: Electron provides a mature, cross-platform environment for building high-fidelity desktop UIs with deep OS integration. It allows the reuse of modern web technologies for complex agent monitoring dashboards.
- **Trade-offs**: Higher memory footprint compared to native frameworks (e.g., Qt/Swift); security risks inherent in a browser-based shell (mitigated by strict IPC).

## AD-02: Isolated MCP Sidecar Architecture
- **Decision**: Implement extended capabilities as separate Python/Node processes using the Model Context Protocol (MCP).
- **Rationale**: 
    - **Stability**: A crash in a specialized tool (e.g., a complex PDF parser or vector engine) does not take down the entire agent.
    - **Polyglot Support**: Allows the use of Python's superior ecosystem for AI/ML (PyTorch, ChromaDB) alongside Node's superior ecosystem for desktop orchestration.
    - **Modularity**: Users can add or remove capabilities without recompiling the main application.
- **Trade-offs**: IPC overhead for tool calls; complexity in managing multiple process lifecycles.

## AD-03: Local-First Privacy (Default Offline)
- **Decision**: Prioritize local inference (Ollama/Llama.cpp) and local semantic memory.
- **Rationale**: Tala is designed for sensitive environments where data sovereignty is paramount. Local execution prevents leakage of proprietary codebase patterns or personal data to cloud providers.
- **Trade-offs**: Requires significant hardware resources (GPU/RAM) for performant inference.

## AD-04: Hybrid Inference Adapter Pattern
- **Decision**: Define a generic `IBrain` interface that can switch between local and cloud providers.
- **Rationale**: Provides a fallback for users on lower-powered hardware or those who require the superior reasoning capabilities of large-scale cloud models (e.g., Claude 3.5 Sonnet) for specific tasks.
- **Trade-offs**: Increased implementation complexity for prompt templating across different LLM APIs.

## AD-05: Multi-Layered Memory Graph
- **Decision**: Combine vector-based RAG with graph-based relational memory.
- **Rationale**: Vector search is excellent for finding relevant text snippets but poor at understanding complex relationships (e.g., "Feature A depends on Bug B"). A graph store allows the agent to build a structural understanding of the project.
- **Trade-offs**: Higher storage overhead; complexity in synchronizing the vector and graph stores.
