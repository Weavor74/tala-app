# Tala System Capability Report
**Updated**: 2026-02-22

## Identity & Core
- **Identity**: Tala (Persistent Persona)
- **Engine**: Local Agentic System (Electron + Python MCP)
- **Brain**: Hybrid LLM (Local via Ollama, Cloud via OpenAI/Anthropic/Gemini/Groq)
- **Emotional State**: Dynamic modulation via `astro-engine` (Python MCP)

## Memory Systems
- **Short-Term (Conversation)**: `mem0` integration for immediate context retention.
- **Long-Term (Knowledge)**: `tala-core` RAG (ChromaDB Vector Store) for document storage and retrieval.
  - **Ingestion**: Supports markdown/text file ingestion.
  - **Retrieval**: Semantic search available during chat.
  - **Pruning**: TTL-based memory cleanup.

## AI & Inference
- **Hybrid Routing**: Priority-based selection between local (Ollama, llama.cpp, vLLM) and cloud (OpenAI, Anthropic, Gemini, Groq) endpoints.
- **Retry Logic**: Exponential backoff (3 attempts) for transient inference errors.
- **Token Tracking**: Daily token usage and session counts logged to `memory/token_ledger.json`.
- **Agent Loop**: Capped at configurable max iterations to prevent runaway loops.

## Reflection System (Self-Improvement)
- **Heartbeat Engine**: Configurable interval (default 60m) with jitter and quiet hours.
- **Reflection Engine**: Collects real evidence (console errors, failed tool calls, turn latency) from system activity.
  - **Turn Tracking**: Records per-turn latency, model, token usage, and error state.
  - **Latency Stats**: Computes avg, p95, and max latency from real turn data.
- **Proposal Engine**: Dual-mode proposal generation:
  - **LLM Mode**: Prompts the active inference endpoint with structured evidence → parses JSON proposals.
  - **Heuristic Fallback**: 5 pattern-matching rules (timeout, tool failures, inference errors, high error rate, latency).
- **Risk Engine**: Multi-gate assessment (Deterministic Filter, Change Budget, Blast Radius, Reversibility).
- **Tool Orchestration**: Multi-turn tool execution with parallel support and sequential dependency.
- **Enhanced File Reading**: `read_file` includes 1-indexed line numbers and automatic inline annotation extraction.
- **Inline Annotations**: Special comments (`// @tala:`, `# @tala:`) used to provide persistent instructions, warnings, or context directly in the source code.
  - Supports tags: `@tala:warn`, `@tala:todo`, `@tala:context`, `@tala:reflect`, `@tala:pin`, `@tala:ignore`.
  - Project-wide summary injected into system prompt.
- **Apply Engine**: Safe file patching with timestamped backups and metadata headers.
- **Rollback Engine**: Restores files from backups using embedded path metadata.
- **Artifact Store**: Persistent storage with purge/retention and index rebuild.
- **Governance**: Safe Leash mode (autoApplyRiskLevel = 0) for full user control.
- **UI Dashboard**: Reflection Panel with metrics, proposal cards, approve/reject actions.
- **Real-time Notifications**: `reflection:proposal-created` events pushed to UI.

## Session Management
- **Multi-Session**: Create, load, delete, and switch between conversation sessions.
- **Conversation Branching**: Fork sessions at any message index.
- **Session Export**: Export conversations as Markdown or JSON (with save dialog).
- **Keyboard Shortcuts**:
  - `Ctrl+Enter` — Send message
  - `Ctrl+L` — Clear chat
  - `Ctrl+Shift+E` — Export session
  - `Ctrl+S` — Save file

## Voice (Opt-in)
- **STT**: Whisper API transcription (file or buffer).
- **TTS**: ElevenLabs text-to-speech synthesis.
- **Status**: Runtime availability check via `voice:status`.

## Web Capabilities
### 1. Visual Browsing (The "Agent" Mode)
Tala can act as a user to navigate complex websites.
- **Navigate**: `browse(url)` - Loads full web pages in a secure sandbox.
- **Observe**: `browser_get_dom()` - Reads interactive elements from the live page.
- **Act**: `browser_type(selector, text)` / `browser_click(selector)`.
- **Stability Features**: Hard-Break Protocol, Background Keep-Alive, Auto-Correction.

### 2. Direct Search (The "API" Mode)
- **Tool**: `search_web(query)`
- **Backend**: DuckDuckGo Lite Scraper.
- **Behavior**: Returns structured top results instantly.

## System Tools
- **File Operations**: `read_file`, `write_file`, `patch_file`, `edit_file`, `delete_file` (Workspace Scoped).
- **Terminal**: Full shell access (PowerShell/Bash) with live output streaming.
- **Git**: Full workflow (status, stage, commit, push, pull, branches, stash, diff, log).
- **Workflows**: CRUD, import, execution, debugging, run history.
- **Custom Functions**: User-defined Python/JS functions.
- **A2UI Dynamic Rendering**: Agent-generated JSON → React components.
- **Guardrails**: Content safety rules.
- **Backup**: Scheduled workspace backups with optional AES-256 encryption.

## MCP Servers
| Server | Purpose |
|---|---|
| Filesystem | Read/write file access |
| Memory (mem0) | Persistent recall & storage |
| Astro Emotion | Astrological emotional vector |
| GitHub | Source control (optional) |
| Brave Search | Web search (optional) |
| Google Search | Web search (optional) |

## Current Operational State
- **Status**: Stable
- **TypeScript Compilation**: Zero errors (frontend + backend)
- **All Preload Channels**: Wired for reflection, voice, session export
- **Test Infrastructure**: Vitest w/ 29 tests across 4 suites (ArtifactStore, ReflectionEngine, ProposalEngine, RiskEngine)
- **Test Command**: `npm test` (single run) / `npm run test:watch` (watch mode)
