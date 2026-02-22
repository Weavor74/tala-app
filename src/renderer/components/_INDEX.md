# src/renderer/components/ — Reusable UI Components

Interactive panel components that plug into the main `App.tsx` layout. Each renders in its designated panel slot.

---

## Files

| File | Size | Description |
|---|---|---|
| `WorkflowEditor.tsx` | 51 KB | **Visual Workflow Builder.** React Flow-based graph editor for creating automation workflows. Supports adding/editing/deleting nodes and edges, node configuration dialogs, and workflow execution. Largest component. |
| `Browser.tsx` | 18 KB | **Embedded Browser.** Wraps an Electron `<webview>` tag with navigation controls (URL bar, back/forward/refresh). Renders the agent's "cursor" overlay for browser automation. Captures screenshots and DOM for the AI. |
| `FileExplorer.tsx` | 13 KB | **File Tree.** Recursive directory tree with expand/collapse, context menus (Create File/Folder, Rename, Delete, Copy Path), and drag-to-open. Key functions: `toggleDirectory()`, `handleContextMenu()`, `handleDrop()`. |
| `SourceControl.tsx` | 14 KB | **Source Control Panel.** Advanced Git UI — staging area, commit form, branch management, remote sync, and diff viewer. More feature-rich than `GitView`. |
| `Search.tsx` | 11 KB | **Global Search.** Full-text search across workspace files with result highlighting and file-open on click. Also supports bulk-adding URLs to the knowledge base. Key functions: `handleSearch()`, `handleBulkAdd()`. |
| `GitView.tsx` | 10 KB | **Git History View.** Displays commit log, branch list, and file diffs. Key functions: `handleCheckout()`, `handleCommit()`. |
| `Library.tsx` | 9 KB | **Knowledge Base Manager.** Displays local files vs. indexed files in the RAG system. Allows ingestion, import, and deletion of documents. Key functions: `handleIngestAll()`, `handleImport()`, `handleDelete()`. |
| `Terminal.tsx` | 2 KB | **Terminal Emulator.** Wraps `xterm.js` and connects to `TerminalService` via IPC for a full shell experience inside the app. |
