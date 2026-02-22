# mcp-servers/ — Python Microservices

Each subfolder is an independent Python server that communicates with the Electron app via the **Model Context Protocol (MCP)** over `stdio` or WebSocket.

---

## Folders

| Folder | Description |
|---|---|
| `astro-engine/` | **Astro Emotion Engine.** Calculates astrological emotional states from natal charts and planetary transits. Contains a full Python package (`astro_emotion_engine/`) with modules for each planet, aspects, ephemeris, and profile management. |
| `tala-core/` | **Tala Core (RAG).** Vector database server using ChromaDB + SentenceTransformers for long-term memory retrieval, file ingestion, and interaction logging. |
| `mem0-core/` | **Mem0 (Short-term Memory).** Fact-based user memory storage using the `mem0` library. Stores preferences, facts, and conversation context. |
| `browser-use-core/` | **Browser Automation.** Experimental browser-use server for advanced web interaction tasks. |
