/**
 * Application Settings Schema Definitions
 * 
 * Shared schemas for app_settings.json.
 */

export interface BaseConfig {
    mode: 'usb' | 'local' | 'remote';
}

export interface InferenceInstance {
    id: string;
    alias: string;
    source: 'local' | 'cloud';
    engine: 'ollama' | 'llamacpp' | 'vllm' | 'openai' | 'anthropic' | 'gemini' | 'groq' | 'custom';
    endpoint: string;
    apiKey?: string;
    model: string;
    priority: number;
    params?: {
        temperature?: number;
        ctxLen?: number;
        knownModels?: string[];
    };
}

export interface InferenceConfig {
    mode: 'hybrid' | 'local-only' | 'cloud-only';
    activeLocalId?: string;
    activeCloudId?: string;
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
    cwd?: string;
    useMcpVenv?: boolean;
    url?: string;
    enabled: boolean;
}

export interface StorageProvider {
    id: string;
    name: string;
    type: 'chroma-local' | 'chroma-remote' | 's3' | 'supabase' | 'pinecone' | 'weaviate' | 'custom';
    path?: string;
    collection?: string;
    bucket?: string;
    region?: string;
    accessKey?: string;
    secretKey?: string;
    endpoint?: string;
    apiKey?: string;
    indexName?: string;
    environment?: string;
    namespace?: string;
    scheme?: 'http' | 'https';
    host?: string;
}

export interface StorageConfig {
    activeProviderId: string;
    providers: StorageProvider[];
    mode?: 'local' | 'cloud';
}

export interface GuardrailConfig {
    id: string;
    name: string;
    rules: string;
    enabled: boolean;
    scope: 'global' | 'agent' | 'session';
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
    localPath: string;
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    encryptionKey?: string;
}

export interface AuthConfig extends BaseConfig {
    localMethod: 'none' | 'password';
    passwordHash?: string;
    cloudProvider?: 'google' | 'github' | 'microsoft' | 'apple';
    cloudToken?: string;
    cloudRefreshToken?: string;
    cloudEmail?: string;
    cloudName?: string;
    cloudAvatar?: string;
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
    localRuntime: 'node' | 'python';
    host?: string;
    sshKey?: string;
    username?: string;
}

export interface AgentProfile {
    id: string;
    name: string;
    description?: string;
    systemPrompt: string;
    temperature: number;
    birthDate?: string;
    birthPlace?: string;
    astroBirthDate?: string;
    astroBirthPlace?: string;
    rules: {
        global: string;
        workspace: string;
    };
    workflows: {
        globalPath: string;
        workspacePath: string;
    };
    mcp: {
        global: string[];
        workspace: string[];
    };
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
    sourcePaths: string[];
    createdAt: number;
}

export interface FirewallConfig {
    enabled: boolean;
    sensitivity: number;
    targetPatterns: string[];
    replacementText: string;
    logRedactions: boolean;
}

export interface RPModeConfig {
    rpIntensity: number;
    loreDensity: number;
    allowMemoryRecall: boolean;
    allowAstro: boolean;
}

export interface HybridModeConfig {
    blendRatio: number;
    noTaskAcknowledgements: boolean;
    allowRag: boolean;
    allowMem0Search: boolean;
    allowAstro: boolean;
    allowFsRead: boolean;
    allowFsWrite: 'confirm' | 'off' | 'on';
    allowShellRun: boolean;
}

export interface AssistantModeConfig {
    verbosity: 'concise' | 'normal' | 'detailed';
    autoUseTools: boolean;
    safeMode: boolean;
    memoryWrites: boolean;
    toolsOnlyCodingTurns: boolean;
    ollamaTimeoutMs: number;
}

export interface AgentModesConfig {
    activeMode: 'rp' | 'hybrid' | 'assistant';
    modes: {
        rp: RPModeConfig;
        hybrid: HybridModeConfig;
        assistant: AssistantModeConfig;
    };
}

export interface AppSettings {
    deploymentMode: 'usb' | 'local' | 'remote';
    inference: InferenceConfig;
    storage: StorageConfig;
    backup: BackupConfig;
    auth: AuthConfig;
    server: ServerConfig;
    agent: AgentConfig;
    agentModes: AgentModesConfig;
    sourceControl: SourceControlConfig;
    system: SystemConfig;
    mcpServers: McpServerConfig[];
    guardrails: GuardrailConfig[];
    search: SearchConfig;
    workflows: WorkflowConfig;
    notebooks: Notebook[];
    firewall: FirewallConfig;
}
