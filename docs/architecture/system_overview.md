# Tala System Overview

## 1. System Purpose
Tala is a "government-grade" autonomous agent platform designed for secure, local-first artificial intelligence interactions. It provides a robust, multi-process environment where LLMs can interact with tools, memory systems, and external services via a structured protocol (MCP).

## 2. Key Operational Capabilities
- **Autonomous Reasoning**: Multi-turn loops for goal decomposition and execution.
- **Local-First Inference**: Support for local LLM execution via Ollama and llama-cpp-python, ensuring privacy and offline capability.
- **Hybrid Brain Architecture**: Flexible switching between local and cloud inference engines.
- **Extensible Tooling**: Built on the Model Context Protocol (MCP), allowing for modular integration of specialized services.
- **Long-Term Memory**: Multi-layered memory system including semantic retrieval (RAG), graph-based relationship mapping, and fact storage (Mem0).

## 3. Major Subsystems
- **The Shell (Electron Main)**: Orchestrates application lifecycle, native security, and service management.
- **The Interface (React Renderer)**: Provides a dynamic, high-fidelity chat and monitoring interface.
- **The Brain (Agent Service)**: Central reasoning engine that coordinates LLM calls, tool usage, and memory.
- **MCP Service Layer**: A collection of isolated processes providing specialized capabilities like astrological emotional state calculation and persistent memory.

## 4. User Interaction Model
Users interact with Tala through a conversational React-based UI. The system supports direct chat, complex workflow editing, and real-time monitoring of agent reasoning and terminal activity.

## 5. Functional Architecture Walkthrough
```mermaid
graph TD
    User([User]) <--> UI[React Renderer UI]
    UI <--> IPC[IPC Bridge / Preload]
    IPC <--> Main[Electron Main Process]
    Main <--> AS[Agent Service]
    AS <--> Brains{Inference Drivers}
    Brains <--> Ollama[Local Ollama]
    Brains <--> Cloud[Cloud LLM APIs]
    AS <--> TS[Tool Service]
    TS <--> MCP[MCP Service Layer]
    MCP <--> Astro[Astro Engine]
    MCP <--> Mem0[Mem0 Continuity]
    MCP <--> TC[Tala Core RAG]
    AS <--> GS[Guardrail Service]
    TC <--> Storage[(SQLite / Vector / File System)]
```

## 6. External Dependencies
- **Ollama**: Required for local inference execution.
- **Node.js**: Underlying runtime for the desktop shell.
- **Python 3.10+**: Runtime for MCP services and vector libraries.
- **SQLite**: Primary persistent storage for structured memory.
