# Component Model

This document describes the Tala system as a collection of interacting components, mapping their logical roles to physical source locations.

## 1. Core Runtime Components

### Electron Main Process
- **Path**: `electron/main.ts`
- **Purpose**: Acts as the host for all backend services and manages the application window.
- **Inputs**: OS events, lifecycle signals.
- **Outputs**: Browser windows, IPC event emission.
- **Lifecycle**: Starts on application launch; terminates all sidecar processes on exit.

### Agent Service
- **Path**: `electron/services/AgentService.ts`
- **Purpose**: The "Reasoning Engine". Coordinates the turn loop, prompt construction, and tool execution.
- **Inputs**: User messages, tool results, memory context.
- **Outputs**: Agent thoughts, tool requests, final responses.
- **Dependencies**: `ToolService`, `OllamaBrain`, `GuardrailService`.

### Tool Service
- **Path**: `electron/services/ToolService.ts`
- **Purpose**: Registry and dispatcher for all executable actions. Handles both native Electron tools and remote MCP tools.
- **Inputs**: Tool names and arguments.
- **Outputs**: Result data or error messages.
- **Dependencies**: MCP Client, local file system modules.

## 2. Inference Adapters (Brains)

### Ollama Brain
- **Path**: `electron/brains/OllamaBrain.ts`
- **Purpose**: Adapter for local Ollama instances.
- **Inputs**: Chat history, system instructions.
- **Outputs**: Text/JSON streams from the local LLM.

### Cloud Brain
- **Path**: `electron/brains/CloudBrain.ts`
- **Purpose**: Interface for external LLM providers (e.g., Anthropic, OpenAI).

## 3. MCP Service Layer (Sidecars)

### Tala Core (RAG)
- **Path**: `mcp-servers/tala-core/`
- **Purpose**: Primary Retrieval Augmented Generation (RAG) engine.
- **Inputs**: Document ingestion requests, search queries.
- **Outputs**: Context chunks, document metadata.
- **Technologies**: Python, Sentence-Transformers, ChromaDB/SQLite.

### Astro Engine
- **Path**: `mcp-servers/astro-engine/`
- **Purpose**: Calculates the agent's astrological "emotional state" based on real-time ephemeris data.
- **Logic**: Injects emotional vectors into the agent's system prompt to influence personality.

### Mem0 Core
- **Path**: `mcp-servers/mem0-core/`
- **Purpose**: Long-term fact and preference storage.
- **Inputs**: Interaction text.
- **Outputs**: Retrieved facts for personalization.

## 4. Frontend (Renderer)

### React Application
- **Path**: `src/`
- **Purpose**: User interaction and visualization layer.
- **Entry Point**: `src/App.tsx` — root component containing chat state, session management, and mode-switching logic.
- **Components** (`src/renderer/components/`):
    - `ChatSessions.tsx`: Chat session list and message rendering.
    - `Terminal.tsx`: Live command execution view (xterm integration).
    - `WorkflowEditor.tsx`: Graph-based workflow management (ReactFlow).
    - `MemoryViewer.tsx`: Vector search and memory inspection.
    - `ReflectionPanel.tsx`: Self-improvement dashboard.
    - `LogViewerPanel.tsx`: Real-time log aggregation view.
    - `AgentModeConfigPanel.tsx`: Mode selection and configuration UI.
    - `EmotionDisplay.tsx`: Astro Engine emotional state visualization.
- **Dependencies**: Electron Preload (IPC Bridge via `window.electronAPI`).

## 5. Storage Layer

### Local Filesystem
- **Path**: `data/`
- **Purpose**: Storage for `agent_profiles.json`, user settings, and application logs.

### Memory Store
- **Path**: `memory/` (Logical)
- **Purpose**: Hosts SQLite databases for the knowledge graph and vector stores for RAG.
