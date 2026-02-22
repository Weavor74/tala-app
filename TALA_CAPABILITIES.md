# Tala System Capability Report

## Identity & Core
- **Identity**: Tala (Persistent Persona)
- **Engine**: Local Agentic System (Electron + Python MCP)
- **Brain**: Local LLM via Ollama (Configurable Model)
- **Emotional State**: Dynamic modulation via `astro-engine` (Python MCP).

## Memory Systems
- **Short-Term (Conversation)**: `mem0` integration for immediate context retention.
- **Long-Term (Knowledge)**: `tala-core` RAG (Vector Database) for document storage and retrieval.
  - **Ingestion**: Supports markdown/text file ingestion.
  - **Retrieval**: Semantic search available during chat.

## Web Capabilities
### 1. Visual Browsing (The "Agent" Mode)
Tala can act as a user to navigate complex websites.
- **Navigate**: `browse(url)` - Loads full web pages in a secure sandbox.
- **Observe**: `browser_get_dom()` - Reads interactive elements (Buttons, Inputs, Links) from the live page.
- **Act**:
  - `browser_type(selector, text)` - Types into forms (with verification).
  - `browser_click(selector)` - Clicks elements (with "Fire & Forget" stability).
- **Stability Features**:
  - **Hard-Break Protocol**: Prevents hallucinated actions by forcing observation after navigation.
  - **Background Keep-Alive**: Prevents process death when switching tabs.
  - **Auto-Correction**: Detects missing fields and re-observes.

### 2. Direct Search (The "API" Mode)
For quick information without visual navigation.
- **Tool**: `search_web(query)`
- **Backend**: DuckDuckGo Lite Scraper (simulated API).
- **Behavior**: Returns a structured list of top results (Title, URL, Snippet) instantly.

## System Tools
- **File Operations**:
  - `read_file` / `write_file` (Workspace Scoped)
  - `list_files` (Recursive)
- **Terminal**:
  - Full shell access (PowerShell/Bash)
  - Live output streaming

## Current Operational State
- **Status**: Stable
- **Recent Fixes**:
  - Resolved browser IPC timeouts.
  - Fixed DOM content extraction (Input Values).
  - Implemented non-blocking action loops.
  - Added direct search capability.
