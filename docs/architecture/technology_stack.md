# Technology Stack

This document lists the core technologies, frameworks, and libraries used across the Tala ecosystem.

## 1. Desktop Application (Host)
- **Framework**: Electron (v31+)
- **Runtime**: Node.js (v20+)
- **Language**: TypeScript
- **State Management**: React Context, TanStack Query (inferred)
- **Styling**: Tailwind CSS (UI), Lucide React (Icons)
- **Build System**: Vite

## 2. Agent Orchestration Layer
- **Logic Engine**: TypeScript
- **Protocol**: Model Context Protocol (MCP)
- **IPC Implementation**: Electron Preload Context Isolation
- **Concurrency**: Node.js Worker Threads (for intensive non-IO tasks)

## 3. Artificial Intelligence & Inference
- **Local Runtime**: Ollama (primary), llama-cpp-python (fallback/sidecar)
- **Models**: llama3, phi3, mistral, code-llama (configurable)
- **Inference Adapter**: Custom `IBrain` TypeScript drivers.

## 4. Python Service Layer (MCP)
- **Runtime**: Python 3.10+
- **Environment Management**: Virtualenv / pip
- **Core Libraries**:
    - `mcp`: Official Model Context Protocol SDK.
    - `sentence-transformers`: For semantic embedding generation.
    - `chromadb` / `faiss`: Vector storage and retrieval.
    - `networkx`: Knowledge graph manipulation.

## 5. Data Persistence
- **Relational Data**: SQLite 3
- **Graph Data**: SQLite (underlying graph representation)
- **Metadata**: JSON (agent profiles, user settings)
- **Large Objects**: Local filesystem (`data/bin/`)

## 6. Testing & CI/CD
- **Frontend Testing**: Vitest
- **Backend Testing**: Vitest / Node Test Runner
- **Audit Tooling**: Custom Python/PS1 scripts for dependency and filesystem inventory.
- **Security Scanners**: (Planned) Snyk / GitHub Advanced Security.
