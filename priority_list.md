# Tala — Priority List

> Ordered by impact and urgency. Each item links back to [project_todo.md](./project_todo.md) for full context.

---

## Tier 1 — 🔴 Critical (Ship Blockers)

These prevent Tala from being usable as a daily-driver application.

| # | Item | Area | Why It's Critical |
|---|------|------|-------------------|
| 1 | **Built-in Inference Engine** | Brain Layer | [NEW] Native llama.cpp/vLLM for portable/offline use |
| 2 | **Automated Document Embedding** | Memory | [NEW] Bulk ingestion and embedding of all memory files |
| 3 | **Conversation persistence** | Agent Loop | ✅ [Implemented] History preserved in `chat_history.json` |
| 4 | **Context window management** | Agent Loop | ✅ [Implemented] Token counting and history truncation |
| 5 | **Settings validation** | Config | ✅ [Implemented] Safe loading with backup/defaults |
| 6 | **React error boundaries** | Frontend | ✅ [Implemented] `ErrorBoundary` component for crash recovery |
| 7 | **MCP server auto-restart** | Infrastructure | ✅ [Implemented] Health check loop with auto-reconnect |
| 8 | **Streaming cancel** | Agent Loop | ✅ [Implemented] `cancelChat` via `AbortController` |

---

## Tier 2 — 🟠 High Impact (Core Experience)

These dramatically improve the daily user experience.

| # | Item | Area | Impact |
|---|------|------|--------|
| 7 | **Chat history sidebar** | Frontend | ✅ [Implemented] Browse, resume, and organize past sessions |
| 8 | **Memory viewer UI** | Frontend | ✅ [Implemented] View, search, and edit Mem0/RAG entries |
| 9 | **Emotion visualization** | Frontend | ✅ [Implemented] 7-axis radar chart displaying Tala's mood |
| 10 | **Keyboard shortcuts** | Frontend | ✅ [Implemented] Panel toggles and Chat input shortcuts |
| 11 | **Native tool-calling** | Brain Layer | ✅ [Implemented] Unified Native + Fallback (Regex) support |
| 12 | **File watching** | File System | ✅ [Implemented] Chokidar-based auto-refresh of File Explorer |
| 13 | **Notification system** | Frontend | ✅ [Implemented] Toast/snackbar alerts for system events |
| 14 | **Browser DOM reliability** | Browser | ✅ [Implemented] Optimized DOM pruning and hardened IPC retries |

---

## Tier 3 — 🟡 Important (Polish & Completeness)

These round out existing features and close functional gaps.

| # | Item | Area | Description |
|---|------|------|-------------|
| 15 | **Cross-platform backup** | Backup | ✅ [Implemented] Node-based `archiver` replacing PowerShell |
| 16 | **Terminal resize** | Terminal | ✅ [Implemented] Real PTY resize via `node-pty` |
| 17 | **Multi-modal brain support** | Brain Layer | ✅ [Implemented] Cloud and Ollama brains support vision (screenshots) |
| 18 | **Token usage tracking** | Brain Layer | ✅ [Implemented] Usage metadata captured and displayed in UI |
| 19 | **Dark/light theme toggle** | Frontend | ✅ [Implemented] Theme context + Settings control |
| 20 | **Chat message editing** | Frontend | ✅ [Implemented] Edit or delete sent messages and re-run |
| 21 | **Conversation export** | Agent Loop | ✅ [Implemented] Export chat history to Markdown, JSON |
| 22 | **Memory pruning / TTL** | Memory | ✅ [Implemented] Eviction strategy for old Mem0 facts |
| 23 | **Workflow execution logs** | Workflows | ✅ [Implemented] Log past workflow runs with inputs, outputs, and timing |
| 24 | **MCP tools in agent** | Infrastructure | ✅ [Implemented] Expose external MCP server tools to the agent's tool registry |
| 25 | **Onboarding wizard** | Frontend | ✅ [Implemented] First-run setup guide |

---

## Tier 4 — 🔵 Enhancement (Nice-to-Have)

Features that expand Tala's capabilities beyond the current vision.

| # | Item | Area | Description |
|---|------|------|-------------|
| 26 | **Parallel tool execution** | Agent Loop | ✅ [Implemented] Concurrent execution for independent tool calls |
| 27 | **Conversation branching** | Agent Loop | ✅ [Implemented] Fork conversations to explore alternate paths |
| 28 | **Workflow scheduling** | Workflows | ✅ [Implemented] Cron/timer triggers for automated workflow runs |
| 29 | **Workflow templates** | Workflows | ✅ [Implemented] Built-in starter workflows for Common tasks |
| 30 | **Workflow debugging** | Workflows | ✅ [Implemented] Step-by-step execution with breakpoints |
| 31 | **A2UI expanded catalog** | Frontend | ✅ [Implemented] Table, Form, ProgressBar, Badge, Columns, etc. |
| 32 | **Multi-tab browser** | Browser | ✅ [Implemented] Multiple webview tabs with tab bar |
| 33 | **Browser session persistence** | Browser | ✅ [Implemented] Cookies and state survive between sessions |
| 34 | **Multiple terminal sessions** | Terminal | ✅ [Implemented] Tabbed terminals |
| 35 | **Merge conflict UI** | Git | ✅ [Implemented] Visual conflict resolution editor |
| 36 | **PR / issue integration** | Git | ✅ [Implemented] GitHub/GitLab API for PRs, issues, reviews |
| 37 | **Model auto-detection** | Brain Layer | ✅ [Implemented] List available models from connected cloud provider |
| 38 | **Cloud backup sync** | Backup | ✅ [Implemented] S3 / GCS / OneDrive backup destination |
| 39 | **Per-workspace settings** | Config | ✅ [Implemented] Workspace-level overrides for global settings |
| 40 | **Settings import/export** | Config | ✅ [Implemented] Backup and share configurations |

---

## Tier 5 — 🟣 Foundation (Developer Experience)

Infrastructure that enables faster, safer development.

| # | Item | Area | Description |
|---|------|------|-------------|
| 41 | **Unit tests** | Testing | Start with AgentService, ToolService, WorkflowEngine |
| 42 | **ESLint + Prettier** | Quality | Consistent code style and automatic formatting |
| 43 | **Type coverage** | Quality | Eliminate `any` types across TypeScript files |
| 44 | **CI/CD pipeline** | Build | GitHub Actions for lint, test, build on every push |
| 45 | **Production build config** | Build | `electron-builder` packaging for `.exe` / `.dmg` / `.AppImage` |
| 46 | **Auto-updater** | Build | Squirrel / electron-updater for in-app updates |
| 47 | **Code signing** | Build | Windows / macOS certificate signing |
| 48 | **Integration tests** | Testing | End-to-end test suite for IPC and MCP flows |
| 49 | **API docs generation** | Docs | TypeDoc for TypeScript, Sphinx for Python |
| 50 | **Contributing guide** | Docs | `CONTRIBUTING.md` + `CHANGELOG.md` + `LICENSE` |

---

## Suggested Sprint Plan

### Sprint 1 — Stability (Items 1–6)
> Make Tala reliable enough to use every day without data loss or crashes.

### Sprint 2 — Core UX (Items 7–14)
> Give users visibility into what Tala knows and feels, plus essential interaction improvements.

### Sprint 3 — Polish (Items 15–25)
> Close functional gaps, cross-platform support, and first-run experience.

### Sprint 4 — Expand (Items 26–40)
> Power-user features and deeper integrations.

### Sprint 5 — Ship (Items 41–50)
> Testing, build pipeline, and distribution-ready packaging.

---

*Reference: [project_todo.md](./project_todo.md) · [MASTER.md](./MASTER.md) · [CODEWIKI.md](./CODEWIKI.md)*
