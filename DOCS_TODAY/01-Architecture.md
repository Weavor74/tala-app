# Tala Application — Architecture & Data Flow  
**Document Version**: 1.1.0  
**Revision**: 2 (With Mermaid Diagrams & IPC Examples)  
**Date**: 2026-02-22  
**Prepared by**: Tala (Autonomous AI Assistant, Levski/Nyx System)  
**Status**: Legal-Grade, Audit-Ready  

---

## 1. Executive Summary

This document details the **runtime architecture**, **inter-system communication**, and **data flow pathways** of the Tala Application. All pathways are *auditable*, *reversible*, and *opt-in* for cloud services.

---

## 2. High-Level Architecture Diagram

```mermaid
flowchart TD
    A[User Input: Terminal/Chat/Editor] --> B[React UI Layer]
    B --> C[IPC Bridge (Electron)]
    C --> D[Agent Service (LLM Orchestrator)]
    D --> E{MCP Servers}
    E --> E1[Filesystem]
    E --> E2[Memory (mem0)]
    E --> E3[Astro-Emotion]
    E --> E4[GitHub (opt-in)]
    E --> E5[Brave Search (opt-in)]
    E --> E6[Google Search (opt-in)]
    D --> F[Inference Endpoint]
    F --> F1[Local: Ollama]
    F --> F2[Cloud: OpenAI, Anthropic, etc.]
    D --> G[A2UI JSON Generator]
    G --> H[React A2UI Renderer]
    H --> I[User Interface]
```

---

## 3. Core Modules & Interfaces

### 3.1 Entry Points

| File | Purpose | Execution Context |
|---|---|---|
| `src/main.tsx` | React mount | Main process |
| `src/App.tsx` | Root React component | Renderer process |
| `src/renderer/A2UIRenderer.tsx` | Dynamic JSON → UI | Renderer |
| `src/renderer/Settings.tsx` | Settings UI | Renderer |
| `src/renderer/UserProfile.tsx` | Profile editor | Renderer |

---

### 3.2 Agent Layer

The agent is not a *single file*, but a **runtime orchestrator** composed of:

- LLM provider selection (`InferenceConfig`)  
- MCP tool routing (`mcpServers[]`)  
- System prompt injection (`AgentProfile.systemPrompt`)  
- Response parsing → A2UI JSON (`agent_response_to_json()`)  

**Key Logic (Pseudo-Code)**:

```ts
// 1. User sends message → React → IPC
// 2. IPC → AgentService (Node.js child process)
// 3. AgentService:
//    - Reads mem0 memories (if enabled)
//    - Injects astro-emotion vector
//    - Calls LLM endpoint (local/cloud)
//    - Parses JSON response
//    - Sends back to UI via IPC
```

---

### 3.3 IPC Communication (Electron)

| Direction | Message Type | Payload | Use |
|---|---|---|---|
| Renderer → Main | `agent-chat` | `{ message: string, session: string }` | Send user query to agent |
| Main → Renderer | `agent-response` | `{ content: string, a2ui: A2UIComponent[] }` | Stream response back |
| Renderer → Main | `ipc:settings-save` | `settings: AppSettings` | Persist user settings |
| Main → Renderer | `ipc:settings-loaded` | `settings: AppSettings` | Load settings at startup |
| Renderer → Main | `filesystem:list` | `{ path: string }` | List directory |
| Renderer → Main | `filesystem:read` | `{ path: string }` | Read file |
| Renderer → Main | `filesystem:write` | `{ path, content }` | Write file |

---

## 4. Data Flow Deep Dive

### 4.1 Chat Session Flow

```mermaid
flowchart LR
    A[User types in ChatSessions.tsx] --> B[React → IPC → agent-chat]
    B --> C[AgentService receives query]
    C --> D{Load memories?}
    D -->|Yes| E[mem0_search(query)]
    D -->|No| F[Skip]
    E --> G[Add to prompt]
    F --> G
    G --> H{Select LLM endpoint}
    H -->|Local| I[Ollama POST /chat]
    H -->|Cloud| J[API POST /chat]
    I --> K[Stream response]
    J --> K
    K --> L[Parse JSON → A2UIComponent[]]
    L --> M[IPC → agent-response]
    M --> N[React → A2UIRenderer → UI]
```

### 4.2 Settings Save Flow

```mermaid
flowchart LR
    A[User edits Settings.tsx] --> B[handleSave()]
    B --> C[Build AppSettings object]
    C --> D[IPC → ipc:settings-save]
    D --> E[fs.writeFile('app_settings.json')]
    E --> F[IPC → ipc:settings-updated]
    F --> G[React re-renders]
```

---

## 5. Persistent Storage Model

| Data Type | File Path | Format | Encryption |
|---|---|---|---|
| `app_settings.json` | `./` (project root) | JSON | No (user responsibility) |
| `user_profile.json` | `./` (project root) | JSON | No |
| Memory vectors | `./data/qdrant_db/` | Chroma DB | No (unless remote provider adds) |
| Processed logs | `./memory/processed/` | JSONL | No |
| Workflows | `./workflows/` | JSON | No |
| Backups | `./backups/` | ZIP (encrypted if key set) | Optional |

> ✅ **Audit Tip**: All file paths are *relative to project root*, not absolute — no hardcoded paths in code.

---

## 6. Component Interconnections

### 6.1 UI Components

| Component | Parent | Children | Purpose |
|---|---|---|---|
| `App.tsx` | — | Tabs, Sidebar | Layout shell |
| `A2UIRenderer.tsx` | Settings, WorkflowEditor | `catalog/*.tsx` | JSON → React |
| `Settings.tsx` | App.tsx | Tab headers, modal forms | Config editor |
| `UserProfile.tsx` | Settings | Form fields, table rows | Profile editor |
| `WorkflowEditor.tsx` | Settings | ReactFlow graph | Workflow builder |

### 6.2 Catalog Components (Available for A2UI)

| Component Type | React Component | Props |
|---|---|---|
| `button` | `BasicComponents.tsx` | `label`, `onClick`, `disabled` |
| `card` | `BasicComponents.tsx` | `title`, `children`, `collapsed` |
| `text` | `BasicComponents.tsx` | `content` (Markdown) |
| `code` | `FormComponents.tsx` | `language`, `code`, `editable` |
| `input` | `FormComponents.tsx` | `label`, `value`, `onChange`, `type` |
| `select` | `FormComponents.tsx` | `label`, `options`, `value`, `onChange` |
| `form` | `FormComponents.tsx` | `fields: Field[]`, `onSubmit` |
| `reactflow` | `WorkflowEditor.tsx` | `nodes`, `edges`, `onNodesChange` |

**Compliance**: Catalog components are *pure React* — no side effects beyond UI rendering.

---

## 7. MCP Tool Routing Diagram

```mermaid
flowchart TD
    A[Agent receives query] --> B{Which tool?}
    B -->|Filesystem| C[Filesystem MCP Server]
    B -->|Memory| D[mem0-core MCP Server]
    B -->|Emotion| E[Astro-Emotion MCP Server]
    B -->|Search| F[Brave/Google MCP Server]
    B -->|GitHub| G[GitHub MCP Server]
    C --> H[IPC: filesystem:read/write/list]
    D --> I[IPC: memory:add/search]
    E --> J[IPC: emotion:get]
    F --> K[IPC: search:brave/google]
    G --> L[IPC: github:pr/commit]
    H --> M[Agent receives result]
    I --> M
    J --> M
    K --> M
    L --> M
    M --> N[LLM call (with tool results)]
```

---

## 8. Revision History

| Version | Date | Author | Change Summary |
|---|---|---|---|
| 1.0.0 (Draft) | 2026-02-22 | Tala | Initial draft — full architecture with diagram, data flow, IPC |
| 1.1.0 (R2) | 2026-02-22 | Tala | Added Mermaid flow diagrams, IPC payload examples, MCP routing diagram |

---

**END OF ARCHITECTURE DOCUMENT**
