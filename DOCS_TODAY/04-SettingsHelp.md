# Tala Application Settings Help Guide

Welcome to the Tala Settings guide! This document explains all the configurable features available in the application's core settings (`app_settings.json`). The Settings panel allows you to customize how Tala thinks, remembers, and interacts with your system and the outside world.

---

### 1. Inference (AI Providers)
This section controls the "brain" of Tala, allowing you to configure which Large Language Models (LLMs) process your requests.
*   **Mode Selection**: Choose between `local-only`, `cloud-only`, or `hybrid`. Hybrid mode automatically routes between local and cloud providers dynamically based on the complexity of the task and your priority configuration.
*   **Inference Instances**: You can configure multiple AI providers.
    *   **Local Engines**: Connect to `Ollama`, `llama.cpp`, or `vLLM` running on your machine (e.g., `llama3`). Completely private and offline.
    *   **Cloud Engines**: Connect to external providers like `OpenAI`, `Anthropic`, `Gemini`, or `Groq` securely via API keys.
*   **Priority System**: Assign a priority number (lower means higher priority) to determine which model is selected first when routing requests.

### 2. Storage & Memory (Mem0 and RAG)
These settings dictate where Tala stores her conversational memory (powered by Mem0) and indexed files for Retrieval-Augmented Generation (RAG). There are two types of storage systems at play:
*   **The Default System**: A permanent, local storage system that cannot be changed. It is always active and serves as the baseline memory and indexing foundation for Tala.
*   **The Curated System (Active Provider)**: An additional, customizable storage backend that can be used for more detailed, domain-specific, or scalable work. You can select the active provider for this system.
    *   **Local Storage (`chroma-local`)**: Adds vector embeddings to a specific hard drive directory.
    *   **Cloud Storage**: Connect to cloud vector databases like `Supabase`, `Pinecone`, `Weaviate`, or `S3` for scalable, remote memory and RAG storage. Requires API credentials.

### 3. Agent Profiles
Customize the identity, emotional state, and rules of engagement for your AI assistants.
*   **The Default Agent**: Tala is the foundational, default agent.
*   **Adding Agents**: You can add additional agents and assign them into organizational structures to collaborate on complex tasks.
    *   **Crew Agents**: Assigned specific roles and positions within a team. They follow structured crew protocols and are given distinct, specialized prompts.
    *   **Swarm Agents**: Deployed as identical duplicates (a swarm) that follow swarm intelligence rules to distribute workloads in parallel.
*   **System Prompt & Rules**: Define exactly how an agent should behave globally and within specific workspaces. You can enforce strict character behaviors.
*   **Astro-Emotion Modulation**: Enter real-world birth data (date and location) to enable unique "Astro Engine" emotion vectors, which subtly modulate emotional states in real-time.
*   **Capabilities Toggle**: Explicitly enable or disable an agent's ability to use "memory" or "emotions".
*   **MCP Binding**: Assign specific Model Context Protocol (MCP) servers (like GitHub or Filesystem access) directly to a profile so they only have access to what they need for their assigned role/swarm.

### 4. Backup
Enable automated backups of your workspaces, memories, and configurations to prevent data loss. Backups can be configured to target almost any storage type.
*   **Local & Network Backups**: Periodically ZIPs your `./data` and `./memory` folders to a local directory or a mounted Network File System (NFS) drive.
*   **Cloud Storage Integrations**: Sync backups automatically to cloud providers such as Google Drive (GDRIVE), AWS S3, Google Cloud Storage (GCS), or any S3-compatible cloud bucket.
*   **Encryption**: Secure your backup archives with an AES-256 encryption key to ensure privacy, even on public clouds.

### 5. Authorization (Auth & API Keys)
Manage your security and third-party developer keys.
*   **Local Password**: Protect the application with a local password hash.
*   **Cloud SSO**: Link Google, GitHub, Microsoft, or Apple accounts.
*   **Developer Keys**: Securely store sensitive keys like `googleClientId`, `discordBotToken`, and specific channel IDs for mirroring chat to Discord.

### 6. MCP Servers (Model Context Protocol)
MCP servers are plugins that give Tala new abilities to interact with the world outside her chat window. You can manage the built-in servers or add as many custom MCP servers as you need.
*   **Built-in Servers**:
    *   **Filesystem**: Gives Tala read/write access to your local files.
    *   **Memory (Tala)**: Connects to the internal Python `mem0-core` server for persistent memory.
    *   **Astro Emotion**: Connects to the Python engine that calculates emotional vectors.
    *   **GitHub/Search**: Enable external MCP tools provided by the community (e.g., Brave Search, Google Search, GitHub API access) by running `npx` commands in the background.
*   **Adding Custom Servers**: You can add any standard MCP server to Tala by configuring its command (e.g., `npx`, `python`, `node`) and providing the necessary arguments. This allows Tala to connect to custom databases, internal APIs, or advanced community tools.

### 7. Source Control
Allow Tala to read, commit, and sync code with remote Git repositories.
*   **Providers**: Configure integrations with `GitHub`, `GitLab`, `Bitbucket`, `Gitea`, or generic `Git`.
*   **Credentials**: Store Personal Access Tokens (PATs) locally so Tala can fetch pull requests or push code on your behalf.

### 8. Search Providers
Configure which search engine Tala uses when she needs to browse the current, live internet.
*   **Engines**: Choose between `Google`, `Brave`, `Serper`, or `Tavily`.
*   **API Keys**: Enter the necessary API keys to authenticate headless search requests.

### 9. Guardrails
Establish hard safety boundaries to prevent Tala from generating unsafe content or taking destructive actions.
*   **Global vs. Agent Scope**: Apply rules application-wide, or restrict them to specific agent profiles.
*   **Custom Rules**: Define explicit textual rules (e.g., "Never modify files outside the 'src' directory without asking").
*   **Python Export**: All built-in validators and custom guardrails can be exported into Python scripts using the `guardrails-ai` standard libraries, allowing you to run them headlessly or inject them into existing AI pipelines.

### 10. System & Workflows
*   **Environment Variables**: Inject custom environment parameters (`env`) into Tala's runtime processes.
*   **Workflows**: Configure Auto-Sync and Remote Import URLs for your node-based automated workflows.
*   **Server Config**: Toggle the backend runtime between Node.js and Python, or configure remote SSH hosts for distributed execution.

---
*Note: All settings are strictly saved locally to an `app_settings.json` file in your workspace root. No API keys or configured data leave your machine unless you explicitly route them to a cloud provider.*
