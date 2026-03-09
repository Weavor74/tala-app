# Tala Service Index

This document outlines the major logical services and background processes that constitute the Tala platform.

## 1. Electron Main Process (The Shell)
- **Role**: Application orchestrator, native bridge, and window manager.
- **Entrypoint**: `electron/main.ts`
- **Responsibilities**:
    - Lifecycle management.
    - IPC handling between renderer and backend.
    - Native OS interactions (filesystem, terminal).

## 2. React Renderer (The Interface)
- **Role**: Primary user interface.
- **Entrypoint**: `src/main.tsx`
- **Responsibilities**:
    - Chat interface rendering.
    - A2UI dynamic component visualization.
    - Local state management.

## 3. Local Inference Service (The Brain)
- **Role**: Local LLM execution.
- **Components**: `local-inference/`
- **Dependencies**: `llama-cpp-python`
- **Responsibilities**:
    - Loading and serving model weights from `models/`.
    - Providing an OpenAI-compatible API for the Agent Service.

## 4. MCP Servers (Extended Capabilities)
These services follow the Model Context Protocol (MCP) and are orchestrated by the `AgentService`.

### Astro Engine
- **Path**: `mcp-servers/astro-engine/`
- **Role**: Astrological emotional state calculation.
- **Logic**: Uses ephemeris data to generate emotional vectors for the agent.

### Mem0 Core
- **Path**: `mcp-servers/mem0-core/`
- **Role**: Memory continuity service.
- **Logic**: Integrates with Mem0 (local SQLite/Vector) for long-term fact storage.

### Tala Core
- **Path**: `mcp-servers/tala-core/`
- **Role**: Central RAG and Metadata service.
- **Responsibilities**: Document retrieval, prompt construction, and core agent personality constraints.

### Tala Memory Graph
- **Path**: `mcp-servers/tala-memory-graph/`
- **Role**: Graph-based relationship mapping.
- **Logic**: Maintains a knowledge graph of entities and relationships discovered during interactions.
