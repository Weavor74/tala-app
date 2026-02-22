# Tala System Architecture & Tech Stack

## 1. Core Architecture (Electron Monolith)
The application is built as a desktop agent using **Electron**, serving as the host for the UI, the Agent Logic ("Brain"), and the Python micro-services ("Soul").

### **Client / Renderer**
- **Framework**: React 19
- **Language**: TypeScript
- **Build Tool**: Vite 7
- **Terminal UI**: `xterm.js`
- **Component Style**: Functional Components + Hooks
- **Styling**: Vanilla CSS (Dark/Industrial Theme)

### **Main Process (Node.js)**
- **Orchestrator**: `AgentService` (Singleton)
  - Manages the "Cognitive Loop" (Observe -> Think -> Act).
  - Routes prompts between User, Memory, and LLM.
- **Communication**: IPC (Inter-Process Communication) bridging React and Node.
- **Tools**: `ToolService` (Registry for File I/O, Browsing, Search).

---

## 2. Intelligence Layer (The Brain)
- **Model Provider**: **Ollama** (Local Inference).
- **Fallback**: OpenAI API (Configurable).
- **Routing**: `IBrain` interface allowing hot-swapping of varied backends.

---

## 3. Micro-Services (The Soul)
Tala uses the **Model Context Protocol (MCP)** to connect to specialized Python kernels.

### **A) tala-core (Long-Term Memory / RAG)**
- **Role**: Persistent Knowledge Store.
- **Language**: Python.
- **Database**: **ChromaDB** (Local Vector Store).
- **Embeddings**: `sentence-transformers` (`all-MiniLM-L6-v2` model).
- **Protocol**: FastMCP.

### **B) astro-engine (Emotional Engine)**
- **Role**: Dynamic Mood Modulation.
- **Language**: Python.
- **Core Library**: **Swiss Ephemeris** (`pyswisseph`).
- **Function**: Calculates real-time planetary transits based on "Birth Data" to inject subtle emotional bias into the System Prompt.

### **C) mem0-core (Short-Term Memory)**
- **Role**: Conversation Continuity.
- **Language**: Python.
- **Core Library**: `mem0ai`.
- **Function**: Tracking user preferences and recent turns.

---

## 4. Web & Automation Capabilities
### **Visual Agent (The Browsing Mode)**
- **Engine**: Electron `Webview` Tag (Chromium).
- **Protocol**: Custom Injection Bridge.
  - `browser_get_dom`: Injects JS to scrape interactive nodes (`<button>`, `<input>`, `<a>`).
  - `browser_click` / `browser_type`: Injects JS to simulate user events.
- **Safety**: "Fire & Forget" non-blocking action loop with DOM-based verification.

### **Headless Search (The API Mode)**
- **Engine**: Node.js `https`.
- **Target**: DuckDuckGo Lite (HTML Scraper).
- **Parser**: Regex-based extraction of Search Results (Title, URL, Snippet).
- **Purpose**: Low-latency information retrieval without visual overhead.

---

## 5. Development Infrastructure
- **PM**: NPM
- **Scripts**:
  - `npm run dev`: Concurrent launch of Vite + Electron + Python MCP Servers.
  - `npm run build`: TypeScript compilation + Vite bundling.
- **Linting**: ESLint + TypeScript-ESLint.

## Summary of Evolution
1.  Started as a simple React Chat UI.
2.  Integrated **Ollama** for local intelligence.
3.  Added **Python MCP Servers** to separate Memory (RAG) and Emotion (Astro).
4.  Built a **Visual Browser Agent** capable of navigating the real web.
5.  Refined into a **Hybrid Agent** with both Visual (DOM) and Headless (API) search capabilities for maximum reliability.
