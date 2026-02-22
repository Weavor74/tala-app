# Tala — Project Todo

> Derived from [MASTER.md](./MASTER.md) and [CODEWIKI.md](./CODEWIKI.md).  
> Status legend: 🔴 Not started · 🟡 Partial / Known issues · 🟢 Working

---

## 1. Brain Layer (LLM Inference)

- [x] 🟢 `IBrain` interface with `ping()`, `generateResponse()`, `streamResponse()` (+ `AbortSignal` support)
- [x] 🟢 `OllamaBrain` — local inference via Ollama HTTP API with streaming + abort
- [x] 🟢 `CloudBrain` — OpenAI-compatible SSE streaming (OpenAI, Gemini, Azure, Anthropic) + abort
- [x] 🟢 Hot-swap between Ollama ↔ Cloud at runtime without restart
- [x] 🟢 `InferenceService` — port scanning for Ollama, LlamaCPP, LM Studio, vLLM
- [x] 🟢 Ollama auto-installer (Windows)
- [x] 🟢 **Native tool-calling / function-calling** — Unified Native + Fallback (Regex) implemented
- [x] 🟢 **Multi-modal brain support** — Unified Cloud + Ollama vision integration (feeding screenshots to context)
- [x] 🟢 **Token usage tracking** — Real-time cumulative usage stats displayed in chat
- [ ] 🔴 **Model auto-detection** — no UI for listing available models from a connected cloud provider
- [ ] 🔴 **macOS / Linux engine installer** — `installEngine()` is Windows-only

---

## 2. Memory Architecture

### 2a. Short-Term Memory (Mem0)

- [x] 🟢 `MemoryService` with dual storage (MCP remote + local JSON fallback)
- [x] 🟢 `mem0-core` MCP server — `mem0_add`, `mem0_search`, `mem0_add_turn`
- [x] 🟢 Local JSON persistence at `tala_memory.json`
- [x] 🟢 Cascading search (remote MCP → local keyword → combined)
- [x] 🟢 **Memory pruning** — TTL and max items pruning implemented (`MemoryService.prune`)
- [x] 🟢 **Memory UI** — `MemoryViewer.tsx` CRUD sidebar component
- [ ] 🔴 **Memory categories** — all memories are flat text; no tagging or categorization

### 2b. Long-Term Memory (RAG)

- [x] 🟢 `RagService` with ChromaDB vector search
- [x] 🟢 `tala-core` MCP server — ingest, search, delete, list, log interactions
- [x] 🟢 `Library.tsx` — bulk ingestion, file management, search UI
- [ ] 🔴 **Chunking strategy** — fixed-size chunking; no semantic/recursive chunking
- [ ] 🔴 **Embedding model selection** — hardcoded; no UI to choose embedding model
- [ ] 🔴 **Cross-session conversation logging** — `logInteraction` exists but isn't always called
- [ ] 🔴 **Index health dashboard** — no way to see index size, health, or re-embedding status

### 2c. Identity / Emotion (Astro Engine)

- [x] 🟢 `AstroService` lifecycle management — spawn, query, shutdown
- [x] 🟢 Full astro-engine package (engine, 12 modules, ephemeris, schemas, services)
- [x] 🟢 Profile CRUD via MCP tools
- [x] 🟢 Fallback ephemeris when Swiss Ephemeris is unavailable
- [x] 🟢 7-axis emotion vector computation with normalization
- [ ] 🟡 **Swiss Ephemeris data files** — must be manually placed at `ASTRO_EPHE_PATH`; no auto-download
- [x] 🟢 **Emotion visualization** — `EmotionDisplay.tsx` radar chart in chat header
- [ ] 🔴 **Emotion history** — no logging of emotion state over time
- [ ] 🔴 **Multi-agent profiles UI** — profiles can be created via MCP but no dedicated UI editor

---

## 3. Agent Loop & Tools

- [x] 🟢 `AgentService.chat()` — agentic tool-use loop with streaming
- [x] 🟢 System prompt assembly (persona + guardrails + tools + memory + astro)
- [x] 🟢 `/command` shortcuts in chat input
- [x] 🟢 `ToolService` registry with 15+ registered tools
- [x] 🟢 **Conversation persistence** — Multi-session storage in `userData/chat_sessions/`
- [x] 🟢 **Context window management** — token estimation + oldest-first truncation to fit `ctxLen`
- [x] 🟢 **Streaming cancel** — `AbortController` + IPC `chat-cancel` channel
- [x] 🟢 **Keyboard Shortcuts** — Global hotkeys (`Ctrl+L`, `Ctrl+K`, `Ctrl+B`, etc.)
- [x] 🟢 **Tool call parsing** — Native JSON parsing (Ollama/OpenAI format)
- [x] 🟢 **Parallel tool execution** — Concurrent execution for independent tool calls implemented in `AgentService`
- [ ] 🔴 **Tool call retry / error recovery** — if a tool fails, the error is fed back but no structured retry logic
- [ ] 🔴 **Conversation branching** — no way to fork or rewind a conversation
- [x] 🟢 **Conversation export** — Export to Markdown/JSON implemented

---

## 4. Browser Automation

- [x] 🟢 Embedded `<webview>` with URL bar, back/forward/reload
- [x] 🟢 `browser-preload.ts` — DOM scanning, element labeling, interactive element indexing
- [x] 🟢 Agent commands: `click`, `type`, `scroll`, `get_dom`, `cursor_move`
- [x] 🟢 Screenshot capture on agent request
- [x] 🟢 **Browser Reliability** — Optimized DOM pruning, accessibility labels, and hardened IPC retries
- [x] 🟢 **Screenshot reliability** — Fixed in Tier 2
- [ ] 🔴 **Multi-tab support** — only one webview at a time
- [ ] 🔴 **Cookie / session persistence** — webview state is lost between sessions
- [ ] 🔴 **Authentication support** — no way to pass credentials or cookies to the webview
- [ ] 🔴 **browser-use-core integration** — MCP server exists but is not wired into the main agent loop

---

## 5. Visual Workflows

- [x] 🟢 `WorkflowEditor.tsx` — ReactFlow canvas with 20 node types
- [x] 🟢 `WorkflowService` — CRUD persistence as JSON files
- [x] 🟢 `WorkflowEngine` — BFS execution with branching, splitting, merging
- [x] 🟢 Import workflows from URL
- [ ] 🟡 **Node execution coverage** — some node types may have incomplete `executeNode()` implementations
- [ ] 🔴 **Workflow debugging** — no step-by-step execution or breakpoints
- [x] 🟢 **Execution history** — Past workflow runs logged with status, timing, and logs (saved in `.agent/workflow_runs/`)
- [ ] 🔴 **Error handling UI** — workflow errors are logged to console but not surfaced to the user
- [x] 🟢 **Workflow templates** — Summarize, Git, and Research templates implemented
- [ ] 🔴 **Scheduled workflows** — no cron/timer trigger; workflows are manual-only

---

## 6. Terminal & Script Execution

- [x] 🟢 `TerminalService` — spawns PowerShell (Windows) / bash (Linux/macOS)
- [x] 🟢 `Terminal.tsx` — xterm.js embedded terminal with streaming I/O
- [x] 🟢 `FunctionService` — custom Python/JS scripts with `$keyword` invocation
- [x] 🟢 Agent can execute terminal commands and read output
- [x] 🟢 **Terminal resize** — Wired `node-pty` resize to frontend layout changes
- [ ] 🔴 **Multiple terminal sessions** — only one terminal at a time
- [ ] 🔴 **Terminal history persistence** — terminal output is lost on restart
- [ ] 🔴 **Function editor UI** — functions can be created/deleted but no in-app code editor

---

## 7. File System & Git

### 7a. File Operations

- [x] 🟢 `FileService` — full CRUD (list, read, create, delete, copy, move, search)
- [x] 🟢 `FileExplorer.tsx` — tree-view with lazy loading and context menus
- [x] 🟢 Sandboxed to workspace root
- [x] 🟢 **File watching** — Chokidar-based implementation in `FileService`
- [ ] 🔴 **Binary file support** — `readFile()` is UTF-8 only; images/PDFs can't be previewed
- [ ] 🔴 **Drag-and-drop** — no drag-and-drop file upload or reordering

### 7b. Git Integration

- [x] 🟢 `GitService` — full CLI wrapper (init, status, stage, commit, sync, clone, branches, stash, diff)
- [x] 🟢 `SourceControl.tsx` — basic Git panel (stage, commit, sync, clone)
- [x] 🟢 `GitView.tsx` — advanced panel (branches, stash, diff, history)
- [x] 🟢 GitHub token injection for authenticated push/pull
- [ ] 🔴 **Merge conflict resolution** — no UI for resolving conflicts
- [ ] 🔴 **PR / issue integration** — no GitHub/GitLab API integration beyond auth
- [ ] 🔴 **Git blame / annotate** — not implemented

---

## 8. Frontend & UI

- [x] 🟢 `App.tsx` — full layout with sidebar, chat, panels
- [x] 🟢 Streaming markdown chat rendering
- [x] 🟢 Toggleable panels (12 components)
- [x] 🟢 `A2UIRenderer` — agent-generated dynamic UI
- [x] 🟢 `Settings.tsx` — comprehensive configuration editor
- [x] 🟢 `UserProfile.tsx` — deep profile editor
- [x] 🟢 **A2UI component catalog** — Expanded to 15 components (Table, Form, ProgressBar, Badge, etc.)
- [x] 🟢 **Dark / light theme toggle** — Context provider + CSS variables
- [ ] 🔴 **Responsive / mobile layout** — desktop-only; no responsive breakpoints
- [x] 🟢 **Keyboard shortcuts** — Global hotkeys (`Ctrl+L`, `Ctrl+K`, `Ctrl+B`, etc.)
- [x] 🟢 **Notification system** — Toast notifications for background events
- [ ] 🔴 **Accessibility** — no ARIA labels, screen reader support, or focus management
- [x] 🟢 **Onboarding / first-run wizard** — Setup guide implemented
- [x] 🟢 **Chat message editing** — Inline edit and regenerate implemented
- [x] 🟢 **Chat history sidebar** — Session management and loading implemented

---

## 9. Configuration & Settings

- [x] 🟢 `app_settings.json` — comprehensive settings with defaults
- [x] 🟢 Settings UI with tabbed sections
- [x] 🟢 OAuth login for GitHub, Google, Azure, Discord
- [x] 🟢 MCP server configuration
- [x] 🟢 Guardrails configuration
- [x] 🟢 **Settings validation** — `SettingsManager.ts` handles corrupt JSON (backup + fallback), atomic writes
- [ ] 🔴 **Settings import/export** — no way to backup or share settings
- [ ] 🔴 **Per-workspace settings** — all settings are global; no workspace-level overrides

---

## 10. Backup & Data Safety

- [x] 🟢 `BackupService` — cross-platform zip backups via `archiver`
- [x] 🟢 Configurable interval and destination
- [x] 🟢 **Cross-platform support** — Uses Node.js `archiver` for Windows, macOS, and Linux
- [ ] 🔴 **Backup restore** — no UI or automation to restore from backup
- [ ] 🔴 **Incremental backups** — full zip every time; no delta/incremental strategy
- [ ] 🔴 **Cloud backup** — no S3/GCS/OneDrive sync

---

## 11. MCP Server Infrastructure

- [x] 🟢 `McpService` — stdio and WebSocket transport management
- [x] 🟢 Connection lifecycle (connect, disconnect, sync, dedup)
- [x] 🟢 Capabilities discovery (tools + resources)
- [x] 🟢 **MCP server health monitoring** — 30s heartbeat loop with auto-restart on crash
- [x] 🟢 **MCP tool invocation from agent** — External tools registered and invocable via `ToolService`
- [ ] 🔴 **MCP resource browsing UI** — `getCapabilities()` exists but no UI to explore resources

---

## 12. Decommissioned / Dormant

- [x] 🟡 `DiscordService` — code retained but decommissioned; bot token removed
- [ ] 🔴 **Remove or archive DiscordService** — dead code still imports `discord.js` and adds bundle weight
- [ ] 🔴 **Email node (`email_read`)** — WorkflowEngine has IMAP support via `imapflow` but it's untested and has no UI configuration

---

## 13. Testing & Quality

- [ ] 🔴 **Unit tests** — zero test files exist in the project
- [ ] 🔴 **Integration tests** — no end-to-end test suite
- [ ] 🔴 **CI/CD pipeline** — no GitHub Actions, Jenkins, or any automated pipeline
- [ ] 🔴 **Linting** — no ESLint/Prettier configuration
- [ ] 🔴 **Type coverage** — many `any` types throughout TypeScript files
- [x] 🟢 **Error boundaries** — `ErrorBoundary.tsx` catches render errors with retry UI

---

## 14. Build, Deploy & Distribution

- [ ] 🔴 **Production build** — no `electron-builder` config for packaging as `.exe` / `.dmg` / `.AppImage`
- [ ] 🔴 **Auto-updater** — no Squirrel/electron-updater integration
- [ ] 🔴 **Code signing** — no certificate for Windows/macOS signing
- [ ] 🔴 **Installer** — no NSIS/DMG installer configuration
- [ ] 🔴 **Environment-specific configs** — no `dev` vs `prod` settings separation

---

## 15. Documentation

- [x] 🟢 Inline docstrings in all 79 source files (JSDoc + Python docstrings)
- [x] 🟢 `CODEWIKI.md` — file-by-file API reference
- [x] 🟢 `MASTER.md` — project overview and architecture description
- [ ] 🔴 **API documentation site** — no generated docs (TypeDoc, Sphinx, etc.)
- [ ] 🔴 **Contributing guide** — no `CONTRIBUTING.md`
- [ ] 🔴 **Changelog** — no `CHANGELOG.md`
- [ ] 🔴 **License** — no `LICENSE` file

---

## Priority Recommendations

### 🔥 Critical (Stability) — ✅ ALL RESOLVED
1. ~~Conversation persistence~~ — ✅ `chat_history.json` persistence
2. ~~Settings validation~~ — ✅ `SettingsManager.ts` with backup + fallback
3. ~~React error boundaries~~ — ✅ `ErrorBoundary.tsx`
4. ~~Context window management~~ — ✅ token estimation + truncation
5. ~~MCP server health monitoring~~ — ✅ 30s heartbeat + auto-restart
6. ~~Streaming cancel~~ — ✅ `AbortController` + IPC channel

### ⚡ High Impact (User Experience) — ✅ ALL RESOLVED
7. ~~Chat history sidebar~~ — ✅ `ChatSessions.tsx`
8. ~~Memory UI~~ — ✅ `MemoryViewer.tsx`
9. ~~Emotion visualization~~ — ✅ `EmotionDisplay.tsx`
10. ~~Keyboard shortcuts~~ — ✅ Global `App.tsx` handlers
11. ~~Browser Reliability~~ — ✅ Optimized DOM pruning and IPC retries
12. ~~Multi-modal support~~ — ✅ Unified Cloud + Ollama vision integration
13. ~~Cross-platform backup~~ — ✅ archiver-based implementation

### 🧱 Foundation (Developer Experience)
11. Unit tests — start with AgentService and ToolService
12. Linting (ESLint + Prettier)
13. CI/CD pipeline
14. ~~Token usage tracking~~ — ✅ Cumulative metadata + context persistence fix
15. Type coverage — eliminate `any` types

### 🚀 Tier 4 (Scale & Autonomy)
17. **Conversation branching** — Fork conversations to explore alternate paths
18. **Workflow Scheduling** — Cron/timer triggers for automated runs
19. **Browser session persistence** — Cookies and state survive between sessions
20. **Multi-modal CloudBrain** — Vision support for Cloud brains (from Tier 3)

---

*Reference: [MASTER.md](./MASTER.md) for architecture · [CODEWIKI.md](./CODEWIKI.md) for file-level details*
