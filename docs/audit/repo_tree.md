# Repository Tree - Tala

This document provides a high-level visualization of the Tala repository structure, excluding deep scans of vendor and generated directories.

## Top-Level Structure

```
tala-app/
├── bin/                # Compiled binaries and utilities
├── data/               # Persistent data storage
├── docs/               # Documentation (including this audit)
│   ├── audit/          # Repository audit artifacts [ACTIVE]
│   └── runtime/        # Runtime documentation
├── electron/           # Electron main process source (TypeScript)
├── local-inference/    # Local LLM inference service
├── mcp-servers/        # Model Context Protocol servers
├── memory/             # Memory storage and management
├── scripts/            # Build, launch, and utility scripts
├── src/                # Frontend (React/Vite) source
├── tests/              # Test suites
├── tools/              # Development and diagnostic tools
├── package.json        # Node.js manifest and scripts
├── tsconfig.json       # TypeScript configuration
└── vite.config.ts      # Vite configuration
```

## Meaningful Subtrees

### `electron/`
Contains the entrypoint for the Electron application and main process logic.
- `main.ts`: Entry file.
- `preload.ts`: Preload script for IPC.

### `src/`
Core frontend application built with React and Vite.
- `components/`: UI components.
- `hooks/`: Custom React hooks.
- `services/`: API and backend service integrations.

### `mcp-servers/`
Collection of MCP servers for extended capabilities (e.g., filesystem, memory).

### `local-inference/`
Handles local model execution, likely using Python-based wrappers.

## Excluded Areas
The following directories are excluded from deep indexing but are confirmed to exist:
- `node_modules/`: Node.js dependencies.
- `.git/`: Version control metadata.
- `dist/` & `dist-electron/`: Build outputs.
- `.pytest_cache/`: Python test cache.

## Summary Counts
- **Total Folders Documented**: ~30
- **Total Files Documented**: ~150 (Meaningful files only)
- **Subsystems Identified**: Electron Main, React Frontend, Local Inference, MCP Servers, Memory Engine.
