/**
 * Application Settings Schema & Defaults
 *
 * This file is the **single source of truth** for the shape of `app_settings.json`.
 * Every configuration panel in the Settings UI reads/writes fields defined here.
 *
 * Sections:
 * - **Inference** — LLM provider instances (local & cloud).
 * - **Storage** — Vector database / RAG storage providers.
 * - **Backup** — Scheduled workspace backup config.
 * - **Auth** — Local password + cloud SSO + developer API keys.
 * - **Server** — Runtime and remote deployment config.
 * - **Agent** — Agent personality profiles, system prompts, rules.
 * - **Source Control** — Git hosting provider credentials.
 * - **System** — Custom environment variables.
 * - **MCP Servers** — Model Context Protocol server definitions.
 * - **Guardrails** — Content safety rules.
 * - **Workflows** — Workflow import/sync settings.
 *
 * Also exports `migrateSettings()` for forward-compatible schema upgrades.
 */

/** Base config mixin providing a deployment mode discriminator. */
export interface BaseConfig {
    mode: 'usb' | 'local' | 'remote';
}

export interface InferenceInstance {
    id: string;
    alias: string; // e.g. "Primary Local"
    source: 'local' | 'cloud';
    engine: 'ollama' | 'llamacpp' | 'vllm' | 'openai' | 'anthropic' | 'gemini' | 'groq' | 'custom';
    endpoint: string;
    apiKey?: string;
    model: string;
    priority: number; // Lower number = Higher priority (0 = Top)
    params?: {
        temperature?: number;
        ctxLen?: number;
        knownModels?: string[];
    };
}

export interface InferenceConfig {
    mode: 'hybrid' | 'local-only' | 'cloud-only';
    activeLocalId?: string; // Explicit pointer to the active local provider
    activeCloudId?: string; // Explicit pointer to the active cloud provider
    instances: InferenceInstance[];
    localEngine?: {
        enabled: boolean;
        modelPath: string;
        options: {
            port: number;
            contextSize: number;
            gpus: number;
        };
    };
}

export interface McpServerConfig {
    id: string;
    name: string;
    type: 'stdio' | 'websocket';
    command?: string;
    args?: string[];
    url?: string;
    enabled: boolean;
}

export interface StorageProvider {
    id: string;
    name: string;
    type: 'chroma-local' | 'chroma-remote' | 's3' | 'supabase' | 'pinecone' | 'weaviate' | 'custom';
    path?: string; // For local
    collection?: string;
    bucket?: string; // For cloud
    region?: string;
    accessKey?: string;
    secretKey?: string;
    endpoint?: string;
    apiKey?: string;

    // Pinecone Specific
    indexName?: string;
    environment?: string;
    namespace?: string;

    // Weaviate Specific
    scheme?: 'http' | 'https';
    host?: string;
}

export interface StorageConfig {
    activeProviderId: string;
    providers: StorageProvider[];
    // Legacy support (optional, can be removed if specific migration handles it)
    mode?: 'local' | 'cloud';
}

export interface GuardrailConfig {
    id: string;
    name: string;
    rules: string;
    enabled: boolean;
    scope: 'global' | 'agent' | 'session';
    // Note: When scope === 'agent', assignment is done in AgentProfile.guardrailIds
}

export interface SearchProvider {
    id: string;
    name: string;
    type: 'google' | 'brave' | 'serper' | 'tavily' | 'custom' | 'rest';
    endpoint?: string;
    apiKey?: string;
    enabled: boolean;
}

export interface SearchConfig {
    activeProviderId: string;
    providers: SearchProvider[];
}

export interface BackupConfig extends BaseConfig {
    enabled: boolean;
    intervalHours: number;
    provider: 'local' | 's3' | 'compat' | 'gcs';

    // Local
    localPath: string;

    // Cloud (S3 Compatible)
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    encryptionKey?: string;
}

export interface AuthConfig extends BaseConfig {
    // Local
    localMethod: 'none' | 'password';
    passwordHash?: string;

    // Cloud (SSO)
    cloudProvider?: 'google' | 'github' | 'microsoft' | 'apple';
    cloudToken?: string;
    cloudRefreshToken?: string;
    cloudEmail?: string;
    cloudName?: string;
    cloudAvatar?: string;

    // Developer Keys (Strict Provider Config)
    keys?: {
        googleClientId?: string;
        googleClientSecret?: string;
        githubClientId?: string;
        githubClientSecret?: string;
        microsoftClientId?: string;
        microsoftClientSecret?: string;
        discordBotToken?: string;
        discordMirrorChannelId?: string;
    };
}

export interface ServerConfig extends BaseConfig {
    // Local
    localRuntime: 'node' | 'python';

    // Cloud
    host?: string;
    sshKey?: string;
    username?: string;
}

export interface AgentProfile {
    id: string;
    name: string;
    description?: string;

    // Core Identity
    systemPrompt: string;
    temperature: number;

    // Identity Dates
    birthDate?: string; // In-universe/fictional birth date (e.g., "2923-05-15" for Star Citizen)
    birthPlace?: string; // In-universe birth place (e.g., "Levski, Delamar")

    // Astro Profile (for emotional modulation - uses REAL dates)
    astroBirthDate?: string; // Real-world date for Astro Engine (ISO 8601: "1990-01-01T12:00:00")
    astroBirthPlace?: string; // Real-world city for Astro Engine (e.g., "London")

    // Rules
    rules: {
        global: string;
        workspace: string; // Current workspace override
    };

    // Workflows (Paths or Definitions)
    workflows: {
        globalPath: string;
        workspacePath: string;
    };

    // MCP Servers (Enabled List)
    mcp: {
        global: string[];
        workspace: string[];
    };

    // Guardrails assigned to this agent
    guardrailIds?: string[];
}

export interface AgentConfig {
    activeProfileId: string;
    profiles: AgentProfile[];
    capabilities?: {
        memory: boolean;
        emotions: boolean;
    };
}

export interface SourceControlProvider {
    id: string;
    name: string;
    type: 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'custom' | 'git';
    active: boolean;
    username?: string;
    token?: string;
    endpoint?: string;
    label?: string;
}

export interface SourceControlConfig {
    providers: SourceControlProvider[];
}

export interface SystemConfig {
    env: Record<string, string>;
}

export interface WorkflowConfig {
    remoteImportUrl?: string;
    autoSync?: boolean;
}

export interface Notebook {
    id: string;
    name: string;
    description?: string;
    sourcePaths: string[]; // Paths to files in memory/ or elsewhere
    createdAt: number;
}

export interface AppSettings {
    deploymentMode: 'usb' | 'local' | 'remote';
    inference: InferenceConfig;
    storage: StorageConfig;
    backup: BackupConfig;
    auth: AuthConfig;
    server: ServerConfig;
    agent: AgentConfig;
    sourceControl: SourceControlConfig;
    system: SystemConfig;
    mcpServers: McpServerConfig[];
    guardrails: GuardrailConfig[];
    search: SearchConfig;
    workflows: WorkflowConfig;
    notebooks: Notebook[];
}

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
    notebooks: []
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

    return base;
};
