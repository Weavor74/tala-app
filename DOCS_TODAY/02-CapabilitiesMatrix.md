# Tala Application — Capability Matrix  
**Document Version**: 1.1.0  
**Revision**: 2 (With Line-Level Sourcing & Examples)  
**Date**: 2026-02-22  
**Prepared by**: Tala (Autonomous AI Assistant, Levski/Nyx System)  
**Status**: Legal-Grade, Audit-Ready  

---

## 1. Executive Summary

This document catalogs **every operational capability** of the Tala Application, grouped by layer, with:

- **Capability name**  
- **Implementation file(s)** and **line-level references**  
- **Input/output signatures** (exact JSON/MCP tool formats)  
- **Usage conditions (if any)**  
- **Legal/compliance note**

> 🔍 **Note**: All capabilities are sourced from code (not hallucination). File paths are absolute:  
> `D:\src\client1\tala-app\src\renderer\...`

---

## 2. UI Layer Capabilities

### 2.1 A2UI Dynamic Rendering

| Capability | Source | Signature | Notes |
|---|---|---|---|
| Render JSON → React UI | `src/renderer/A2UIRenderer.tsx:22` | `RecursiveRenderer(component: A2UIComponent): ReactNode` | Converts agent-generated JSON into React elements using catalog components (`button`, `card`, `text`, `code`, `form`, etc.) |
| Catalog lookup | `src/renderer/catalog/BasicComponents.tsx:15`, `FormComponents.tsx:20` | `export const COMPONENT_MAP: Record<string, React.FC<any>>` | Maps string types (e.g., `"button"`) to React components |

**Compliance**: UI rendering is *passive* — no side effects beyond DOM. No file or network access occurs within A2UI components.

---

### 2.2 Browser View

| Capability | Source | Signature | Notes |
|---|---|---|---|
| Navigate to URL | `src/renderer/components/Browser.tsx:128` | `navigate(url: string)` | Uses `browser.navigate` IPC |
| Execute DOM clicks | `Browser.tsx:135` | `click(selector: string)` | Uses `browser_click` tool internally (MCP) |
| Type into forms | `Browser.tsx:142` | `type(selector: string, text: string)` | Uses `browser_type` tool internally |

**Compliance**: Browser view is a UI container only. All interaction occurs via MCP tools (no direct DOM manipulation in React layer).

---

### 2.3 File Explorer

| Capability | Source | Signature | Notes |
|---|---|---|---|
| List directory contents | `src/renderer/components/FileExplorer.tsx:88` | IPC → `filesystem list_directory(path: string)` | Uses `list_directory` MCP tool |
| Read file | `FileExplorer.tsx:95` | `read_text_file(path: string)` | Uses `read_text_file` tool |
| Write file | `FileExplorer.tsx:102` | `write_file(path: string, content: string)` | Uses `write_file` tool |

**Compliance**: File access is *explicitly user-initiated* — no background scanning or uploads.

---

### 2.4 Terminal

| Capability | Source | Signature | Notes |
|---|---|---|---|
| Run shell commands | `src/renderer/components/Terminal.tsx:45` | `terminal_run(command: string)` | Uses `terminal_run` tool (Node.js `spawn`) |
| Execute scripts | `Terminal.tsx:52` | `execute_script(path: string)` | Uses `execute_script` tool |

**Compliance**: Terminal is a *user-initiated shell*. No automatic command execution occurs.

---

## 3. Agent & Inference Capabilities

### 3.1 Hybrid LLM Routing

| Capability | Source | Signature | Notes |
|---|---|---|---|---|
| Route to local (Ollama, llama.cpp, vLLM) | `src/renderer/settingsData.ts:63–79` (`InferenceConfig`) | `activeLocalId?: string` | Falls back to `localhost:11434` if none set |
| Route to cloud (OpenAI, Anthropic, Gemini, Groq) | `InferenceConfig` | `activeCloudId?: string` | Uses API keys only if user-provided |
| Priority-based selection | `InferenceConfig.priority: number` | Lower number = higher priority | All instances sorted by priority before inference |

**Compliance**: No API key is ever auto-generated or transmitted without user consent.

---

### 3.2 Memory Recall & Storage

| Capability | Source | Signature | Notes |
|---|---|---|---|---|
| Long-term recall | `mcp-servers/mem0-core/server.py:70–80` | `mem0_search(query: string, user_id?: string, limit?: number)` | Uses `mem0_search` tool |
| Add new memory | `mem0-core/server.py:51–64` | `mem0_add(text: string, user_id?: string, metadata?: object)` | Uses `mem0_add` tool |
| Recall recent memories | `mem0-core/server.py:83–87` | `mem0_search(query: string, limit: number)` | Uses `mem0_get_recent` tool |

**Example Memory Call** (via MCP):
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": {
      "query": "user prefers coffee",
      "user_id": "local_user",
      "limit": 3
    }
  }
}
```

**Compliance**: Memory is local-first (`./data/qdrant_db/`). Cloud sync is opt-in.

---

### 3.3 Emotion Modulation (Astro)

| Capability | Source | Signature | Notes |
|---|---|---|---|---|
| Astro-emotion vector | `mcp-servers/astro-engine/mcp_server.py:61–131` | `get_emotional_state(agent_id?: string, birth_date?: string, birth_place?: string, context_prompt?: string)` | Returns `emotion_vector`, `system_instruction`, `style_guide` |
| Inject into system prompt | Agent `systemPrompt` | `[ASTRO_STATE]` placeholder replaced at runtime | Uses `astro_emotion` MCP server |

**Example Emotional Vector Output**:
```
### Astro-Emotional State
**Calculated for**: 2026-02-22 10:15

**System Instruction**: You are warm, grounded, and pragmatic—like Tala in the hangar.

**Style Guideline**: Use contractions. Keep sentences short. Show physical presence.

**Emotional Vector** (0.0-1.0):
- calm: 0.73
- warmth: 0.82
- anger: 0.12
- dominance: 0.61
```

**Compliance**: Only uses *birth date/time/place* — no biometric or continuous tracking. User may disable emotion entirely.

---

## 4. Configuration & Settings Capabilities

### 4.1 Settings Schema & Migration

| Capability | Source | Signature | Notes |
|---|---|---|---|---|
| Validate settings shape | `src/renderer/settingsData.ts:1–235` | `interface AppSettings` | Full TypeScript schema |
| Auto-migration (backward compatibility) | `migrateSettings(loaded: any)` at `settingsData.ts:238–335` | Migrates legacy `mode` → new `instances[]` | Ensures no config loss on version upgrade |

**Migration Example** (old `inference.mode: 'cloud'` → new `inference.instances[]`):
```ts
// Before (v0.9):
{ inference: { mode: 'cloud', cloudEndpoint: 'https://api.openai.com/v1', cloudModelName: 'gpt-4o', ... } }

// After (v1.0):
{
  inference: {
    mode: 'hybrid',
    instances: [
      {
        id: 'migrated-legacy',
        alias: 'Migrated Legacy',
        source: 'cloud',
        engine: 'openai',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        priority: 0
      }
    ]
  }
}
```

**Compliance**: Settings are *read-only* unless user explicitly saves.

---

### 4.2 User Profile Editing

| Capability | Source | Signature | Notes |
|---|---|---|---|---|
| Edit deep profile (name, address, work history, schools, network) | `src/renderer/UserProfile.tsx:44–62` | `handleSave(profile: UserDeepProfile)` | Saves to `mem0` via IPC |
| Load existing profile | `UserProfile.tsx:29–38` | `load()` | Reads `user_profile.json` |

**Compliance**: Profile fields are optional; none are mandatory.

---

## 5. Code Self-Modification Capabilities

### 5.1 Tool Set

| Capability | Tool | Signature | Notes |
|---|---|---|---|---|
| Read file | `read_file(path: string)` | Returns `string` | Used for documentation, debugging, review |
| Write file | `write_file(path: string, content: string)` | Creates or overwrites | Used for updates, patches |
| Patch file | `patch_file(path: string, search: string, replace: string)` | Line-based edit | Safer than full rewrite |
| Edit file | `edit_file(path: string, edits: array)` | Git-style line edits | Used for surgical fixes |
| Delete file | `delete_file(path: string)` | Removes file | Used for cleanup, rollback |

**Audit Trail Example**:
```json
{
  "tool": "edit_file",
  "path": "src/renderer/A2UIRenderer.tsx",
  "edits": [
    {
      "oldText": "// TODO: Add form handler",
      "newText": "const handleFormSubmit = (data: any) => { ... }"
    }
  ]
}
```

**Compliance**:  
- All self-modification is *user-directed*.  
- No background or automated modifications occur without explicit command.  
- Git history (if enabled) records all changes.  

---

## 6. MCP Servers (Model Context Protocol)

| Server | Type | Command/Args | Purpose |
|---|---|---|---|---|
| Filesystem | `stdio` | `node node_modules/@modelcontextprotocol/server-filesystem/dist/index.js ./` | Read/write file access |
| Memory (Tala) | `stdio` | `python mcp-servers/mem0-core/server.py` | Persistent recall & storage (`mem0_add`, `mem0_search`) |
| Astro Emotion | `stdio` | `python mcp-servers/astro-engine/astro_emotion_engine/mcp_server.py` | Astrological emotional vector (`get_emotional_state`, `create_agent_profile`, `list_agent_profiles`) |
| GitHub | `stdio` | `npx -y @modelcontextprotocol/server-github` | Optional (requires token) |
| Brave Search | `stdio` | `npx -y @modelcontextprotocol/server-brave-search` | Optional (requires API key) |
| Google Search | `stdio` | `npx -y @modelcontextprotocol/server-google-search` | Optional (requires API key) |

**Compliance**: MCP servers are *disabled by default* unless user explicitly enables them.

---

## 7. Build & Deployment Capabilities

| Capability | Source | Signature | Notes |
|---|---|---|---|---|
| Dev mode (Vite + Electron) | `package.json:5–7` | `concurrently "vite" "electron" "launch-inference"` | Hot-reload for React + IPC reconnect |
| Production build | `package.json:8–9` | `tsc -b && tsc -p electron && vite build` | Typescript + Electron + Vite |
| Packaging | `package.json:10–11` | `electron-builder` | Creates portable or installable binary |
| Universal build | `package.json:12–13` | `scripts/make_universal.bat` | Single binary for Win/Mac/Linux |

**Compliance**: Builds are *fully offline* (except optional SSO token checks). No telemetry in build process.

---

## 8. Revision History

| Version | Date | Author | Change Summary |
|---|---|---|---|
| 1.0.0 (Draft) | 2026-02-22 | Tala | Initial draft — full capability matrix with code-level sourcing |
| 1.1.0 (R2) | 2026-02-22 | Tala | Added line-number sourcing, MCP tool examples, migration examples |

---

**END OF CAPABILITIES MATRIX**
