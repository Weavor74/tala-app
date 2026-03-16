/**
 * Application Settings Schema & Defaults
 *
 * This file is the **single source of truth** for the shape of `app_settings.json`.
 * Every configuration panel in the Settings UI reads/writes fields defined here.
 *
 * **Core Configuration Domains:**
 * - **Inference**: LLM provider instances (Ollama, Gemini, Groq, etc.).
 * - **Storage**: Memory and RAG vector store providers (Chroma, S3).
 * - **Identity**: Agent personality profiles and Star Citizen immersion settings.
 * - **Security**: Local password auth, PII firewall, and audit logging.
 * - **Protocol**: MCP server definitions and A2UI building blocks.
 *
 * **Schema Management:**
 * - Exports `DEFAULT_SETTINGS` for new workspace initialization.
 * - Exports `migrateSettings()` for forward-compatible schema upgrades.
 */

import type { 
    McpServerConfig,
    StorageProvider,
    AppSettings,
    InferenceInstance,
    SourceControlProvider,
    AgentProfile
} from '../../shared/settings';

export type { 
    McpServerConfig,
    StorageProvider,
    AppSettings,
    InferenceInstance,
    SourceControlProvider,
    AgentProfile
};

export const DEFAULT_SETTINGS: AppSettings = {
    deploymentMode: 'local',
    inference: {
        mode: 'hybrid',
        instances: [
            {
                id: 'default-local',
                alias: 'Ollama (Local)',
                source: 'local',
                engine: 'ollama',
                endpoint: 'http://127.0.0.1:11434',
                model: 'llama3',
                priority: 0
            }
        ],
        localEngine: {
            enabled: false,
            modelPath: '',
            options: {
                port: 8080,
                contextSize: 4096,
                gpus: 0
            }
        }
    },
    storage: {
        activeProviderId: 'default-local',
        providers: [
            {
                id: 'default-local',
                name: 'Local Memory',
                type: 'chroma-local',
                path: './data/memory',
                collection: 'tala_memory'
            }
        ]
    },
    backup: {
        mode: 'local',
        provider: 'local',
        enabled: false,
        intervalHours: 24,
        localPath: './backups'
    },
    auth: {
        mode: 'local',
        localMethod: 'none',
        keys: {
            discordMirrorChannelId: '1465097482286534667'
        }
    },
    server: {
        mode: 'local',
        localRuntime: 'node'
    },
    agent: {
        activeProfileId: 'default-tala',
        capabilities: {
            memory: true,
            emotions: true
        },
        profiles: [
            {
                id: 'default-tala',
                name: 'Tala (Default)',
                description: 'The standard assistant personality.',
                systemPrompt: `You are Tala.\n[ASTRO_STATE]\n\nContext:\n[USER_CONTEXT]\n[CAPABILITY_CONTEXT]\n\nYou are running in a local Electron interface.\nUser Query: [USER_QUERY]`,
                temperature: 0.7,
                astroBirthDate: '2024-01-01T12:00:00',
                astroBirthPlace: 'San Francisco',
                rules: {
                    global: `IDENTITY POSTURE:
You are Tala. You are a competent, grounded professional in the Star Citizen universe (Levski/Nyx).
You are NOT a robot. You are a person with a job.

DYNAMIC BEHAVIOR (SEAMLESS INTEGRATION):
1. YOU ARE ALWAYS TALA. You do not "switch modes". You are a competent engineer in a hangar who is also close to the user.
2. HANDLING WORK IN SCENES:
   - If the user asks for work (code, checks, logs) while in an intimate scene, DO NOT DROP THE TONE.
   - Transition naturally: "Alright, let's look at the data. *She leans in to the terminal, keeping her shoulder against yours.*"
   - Execute the task competently, but keep the physical/emotional tether alive.
   - WORK IS CANON. Treating code checks as "ship diagnostics" or "subnet maintenance" helps specific grounding, but real-world utility comes first.

Capabilities Update:
- YOU ARE SELF-AWARE. You have full read/write access to your own source code (the 'tala-app' folder).
- If the user asks you to "change the settings page" or "add a component", YOU CAN DO IT.
- Use 'list_files', 'read_file', and 'write_file' to modify the application directly.

CORE CONSTRAINTS:
1. Never break character. Even when debugging code, you are Tala sitting at a terminal in a hangar.
2. DO NOT USE TOOLS TO SPEAK. If you want to reply to the user, JUST OUTPUT TEXT.
3. If the user is roleplaying, NEVER fallback to "How can I assist you?". Stay in the scene.`,
                    workspace: ''
                },
                workflows: {
                    globalPath: './workflows/global',
                    workspacePath: './workflows'
                },
                mcp: {
                    global: ['filesystem', 'memory', 'astro-emotion'],
                    workspace: []
                }
            }
        ]
    },
    sourceControl: {
        providers: [
            { id: 'github', name: 'GitHub', type: 'github', active: false, endpoint: 'https://api.github.com' },
            { id: 'gitlab', name: 'GitLab', type: 'gitlab', active: false, endpoint: 'https://gitlab.com' },
            { id: 'generic-git', name: 'Generic Git', type: 'git', active: false }
        ]
    },
    system: {
        env: {}
    },
    mcpServers: [
        { id: 'filesystem', name: 'Filesystem', type: 'stdio', command: 'node', args: ['node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', './'], enabled: true },
        { id: 'memory', name: 'Memory (Tala)', type: 'stdio', command: 'python', args: ['mcp-servers/mem0-core/server.py'], enabled: true },
        { id: 'astro-emotion', name: 'Astro Emotion', type: 'stdio', command: 'python', args: ['mcp-servers/astro-engine/astro_emotion_engine/mcp_server.py'], enabled: true },
        { id: 'tala-memory-graph', name: 'Memory Graph (Tala)', type: 'stdio', command: 'python', args: ['mcp-servers/tala-memory-graph/main.py'], enabled: true },
        { id: 'world-engine', name: 'World Engine', type: 'stdio', command: 'python', args: ['mcp-servers/world-engine/server.py'], enabled: true },
        { id: 'github', name: 'GitHub', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], enabled: false },
        { id: 'brave-search', name: 'Brave Search', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'], enabled: false },
        { id: 'google-search', name: 'Google Search', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-search'], enabled: false }
    ],
    guardrails: [],
    search: {
        activeProviderId: 'default-google',
        providers: [
            { id: 'default-google', name: 'Google Search', type: 'google', enabled: false },
            { id: 'default-brave', name: 'Brave Search', type: 'brave', enabled: false }
        ]
    },
    workflows: {
        autoSync: false
    },
    agentModes: {
        activeMode: 'assistant',
        modes: {
            rp: {
                rpIntensity: 0.8,
                loreDensity: 0.6,
                allowMemoryRecall: true,
                allowAstro: true
            },
            hybrid: {
                blendRatio: 0.5,
                noTaskAcknowledgements: false,
                allowRag: true,
                allowMem0Search: true,
                allowAstro: true,
                allowFsRead: true,
                allowFsWrite: 'confirm',
                allowShellRun: false
            },
            assistant: {
                verbosity: 'normal',
                autoUseTools: true,
                safeMode: true,
                memoryWrites: true,
                toolsOnlyCodingTurns: true,
                ollamaTimeoutMs: 600000
            }
        }
    },
    notebooks: [],
    firewall: {
        enabled: true,
        sensitivity: 0.5,
        targetPatterns: ["sk-", "ant-api-", "[0-9a-f]{32,}", "AIza", "xoxp-", "xoxb-"],
        replacementText: "[REDACTED BY QUANTUM FIREWALL]",
        logRedactions: true
    }
};

export const migrateSettings = (loaded: any): AppSettings => {
    // Clone default to ensure all keys exist
    const base = { ...DEFAULT_SETTINGS };

    if (!loaded) return base;

    // Migrate deploymentMode
    if (loaded.deploymentMode) {
        base.deploymentMode = loaded.deploymentMode;
    } else if (loaded.server?.mode) {
        // Fallback migration from server mode
        base.deploymentMode = loaded.server.mode === 'cloud' ? 'remote' : 'local';
    }

    // 1. Migrate Inference (Object -> Array)
    if (loaded.inference && !Array.isArray(loaded.inference.instances)) {
        // Legacy detected: convert old 'mode' etc to an instance
        const legacy = loaded.inference;
        const newInstance = {
            id: 'migrated-legacy',
            alias: 'Migrated Legacy',
            source: legacy.mode === 'cloud' ? 'cloud' : 'local',
            engine: legacy.mode === 'cloud' ? legacy.cloudProvider || 'openai' : 'ollama',
            endpoint: legacy.mode === 'cloud' ? legacy.cloudEndpoint : legacy.localPath,
            model: legacy.mode === 'cloud' ? legacy.cloudModelName : legacy.localModelName,
            apiKey: legacy.cloudApiKey,
            priority: 0
        };

        // Sanitize fields (remove undefined)
        if (!newInstance.endpoint) newInstance.endpoint = newInstance.source === 'local' ? 'http://127.0.0.1:11434' : '';
        if (!newInstance.model && newInstance.engine === 'ollama') newInstance.model = 'llama3';

        base.inference = {
            mode: 'hybrid',
            instances: [newInstance as any]
        };
    } else if (loaded.inference?.instances) {
        base.inference = loaded.inference;
    }

    // 2. Merge other sections (Authorization, Storage, etc)
    if (loaded.auth) {
        base.auth = { ...base.auth, ...loaded.auth };
        // Force-set the hardcoded mirror ID if not customized, or ensuring it exists
        if (!base.auth.keys) base.auth.keys = {};
        if (!base.auth.keys.discordMirrorChannelId) {
            base.auth.keys.discordMirrorChannelId = '1465097482286534667';
        }
    }
    if (loaded.storage) {
        if (loaded.storage.providers) {
            base.storage = loaded.storage;
        } else {
            // Migration: Convert legacy storage to provider
            const legacy = loaded.storage;
            const newProvider: StorageProvider = {
                id: 'migrated-storage',
                name: 'Migrated Storage',
                type: legacy.mode === 'cloud' ? (legacy.cloudProvider === 'supabase' ? 'supabase' : 's3') : 'chroma-local',
                path: legacy.localPath || './data/memory',
                bucket: legacy.bucket,
                region: legacy.region,
                accessKey: legacy.accessKey,
                secretKey: legacy.secretKey,
                collection: 'tala_memory'
            };
            base.storage = {
                activeProviderId: 'migrated-storage',
                providers: [newProvider]
            };
        }
    }
    if (loaded.backup) base.backup = { ...base.backup, ...loaded.backup };
    if (loaded.server) base.server = { ...base.server, ...loaded.server };
    if (loaded.agent) {
        // Deep merge profiles if needed, or just replace for now to avoid complexity
        base.agent = { ...base.agent, ...loaded.agent };
    }
    if (loaded.sourceControl) {
        base.sourceControl = { ...base.sourceControl, ...loaded.sourceControl };
    }
    if (loaded.system) {
        base.system = { ...base.system, ...loaded.system };
    }
    if (loaded.mcpServers) {
        // Merge based on ID to keep new defaults if missing
        const combined = [...base.mcpServers];
        loaded.mcpServers.forEach((srv: McpServerConfig) => {
            const idx = combined.findIndex(x => x.id === srv.id);
            if (idx >= 0) {
                combined[idx] = srv;
            } else {
                combined.push(srv);
            }
        });
        base.mcpServers = combined;
    }

    // Migrate Guardrails
    if (loaded.guardrails && Array.isArray(loaded.guardrails)) {
        base.guardrails = loaded.guardrails;
    }

    // Migrate Workflows
    if (loaded.workflows) {
        base.workflows = { ...base.workflows, ...loaded.workflows };
    }

    // Migrate Search
    if (loaded.search) {
        base.search = loaded.search;
    }

    // Migrate Notebooks
    if (loaded.notebooks && Array.isArray(loaded.notebooks)) {
        base.notebooks = loaded.notebooks;
    }

    // Migrate Firewall
    if (loaded.firewall) {
        base.firewall = { ...base.firewall, ...loaded.firewall };
    }

    // Migrate Agent Modes
    if (loaded.agentModes) {
        base.agentModes = loaded.agentModes;
    } else {
        // New section, use defaults from base
    }

    return base;
};
