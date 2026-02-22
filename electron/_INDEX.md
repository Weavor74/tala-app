# electron/ — Main Process (Electron Backend)

All code in this directory runs in Node.js inside Electron's **main process**. It has full OS access (filesystem, child processes, networking) and communicates with the renderer via IPC.

---

## Folders

| Folder | Description |
|---|---|
| `services/` | Core backend services — the "brain" of the application. 16 TypeScript service modules handling AI, files, git, memory, terminals, workflows, and more. |
| `brains/` | LLM provider adapters — abstraction layer that lets the agent swap between Ollama (local), OpenAI, Anthropic, and Gemini. |
| `scripts/` | Helper scripts used by services (e.g., PowerShell input helper). |

---

## Files

| File | Size | Description |
|---|---|---|
| `main.ts` | 31 KB | **Electron entry point.** Creates the BrowserWindow, registers all IPC handlers, initializes services, and wires up the preload scripts. This is the largest file in the backend — it defines every `ipcMain.handle()` route. |
| `preload.ts` | 6 KB | **Main preload script.** Exposes safe IPC bridges to the renderer via `contextBridge.exposeInMainWorld()`. Defines the `window.api` object that React components call. |
| `browser-preload.ts` | 14 KB | **Browser webview preload.** Injected into the embedded browser `<webview>`. Provides DOM inspection, screenshot capture, element clicking, and page navigation tools for the AI agent's browser automation. |
| `tsconfig.json` | 373 B | TypeScript config specific to the Electron main process files. |
