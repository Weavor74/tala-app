# src/ — Renderer Process (Frontend)

All code here runs in Electron's **renderer process** (Chromium). It is a React application bundled by Vite.

---

## Folders

| Folder | Description |
|---|---|
| `renderer/` | Main UI layer — views, panels, settings, and sub-components. |
| `assets/` | Static assets bundled by Vite (SVGs, images). |
| `brains/` | _Empty._ Reserved for future frontend-side brain logic. |
| `services/` | _Empty._ Reserved for future frontend service abstractions. |

---

## Files

| File | Size | Description |
|---|---|---|
| `App.tsx` | 25 KB | **Main Application Shell.** Defines the IDE-style layout: sidebar, panels, chat, editor, browser, terminal. Manages global state (`activeView`, `openFiles`, `messages`). Key functions: `sendMessage()`, `handleAgentEvent()`, `handleToolAction()`. |
| `App.css` | 6 KB | **Global Styles.** CSS for the main application layout — dark theme, sidebar, panels, chat bubbles, animations. |
| `index.css` | 1 KB | **Base Styles.** CSS reset and root-level typography defaults. |
| `main.tsx` | 230 B | **React Entry Point.** Mounts `<App />` to the DOM root defined in `index.html`. |
