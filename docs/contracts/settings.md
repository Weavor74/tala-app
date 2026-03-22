# Contract: settings.ts

**Source**: [shared/settings.ts](../../shared/settings.ts)

## Interfaces

### `BaseConfig`
```typescript
interface BaseConfig {
    mode: 'usb' | 'local' | 'remote';
}
```

### `InferenceInstance`
```typescript
interface InferenceInstance {
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
    }
```

### `InferenceConfig`
```typescript
interface InferenceConfig {
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
        }
```

### `McpServerConfig`
```typescript
interface McpServerConfig {
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
```

### `StorageProvider`
```typescript
interface StorageProvider {
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
```

### `StorageConfig`
```typescript
interface StorageConfig {
    activeProviderId: string;
    providers: StorageProvider[];
    mode?: 'local' | 'cloud';
}
```

### `GuardrailConfig`
```typescript
interface GuardrailConfig {
    id: string;
    name: string;
    rules: string;
    enabled: boolean;
    scope: 'global' | 'agent' | 'session';
}
```

### `SearchProvider`
```typescript
interface SearchProvider {
    id: string;
    name: string;
    type: 'google' | 'brave' | 'serper' | 'tavily' | 'custom' | 'rest';
    endpoint?: string;
    apiKey?: string;
    enabled: boolean;
}
```

### `SearchConfig`
```typescript
interface SearchConfig {
    activeProviderId: string;
    providers: SearchProvider[];
}
```

### `AgentProfile`
```typescript
interface AgentProfile {
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
    }
```

### `AgentConfig`
```typescript
interface AgentConfig {
    activeProfileId: string;
    profiles: AgentProfile[];
    capabilities?: {
        memory: boolean;
        emotions: boolean;
    }
```

### `SourceControlProvider`
```typescript
interface SourceControlProvider {
    id: string;
    name: string;
    type: 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'custom' | 'git';
    active: boolean;
    username?: string;
    token?: string;
    endpoint?: string;
    label?: string;
}
```

### `SourceControlConfig`
```typescript
interface SourceControlConfig {
    providers: SourceControlProvider[];
}
```

### `SystemConfig`
```typescript
interface SystemConfig {
    env: Record<string, string>;
}
```

### `WorkflowConfig`
```typescript
interface WorkflowConfig {
    remoteImportUrl?: string;
    autoSync?: boolean;
}
```

### `Notebook`
```typescript
interface Notebook {
    id: string;
    name: string;
    description?: string;
    sourcePaths: string[];
    createdAt: number;
}
```

### `FirewallConfig`
```typescript
interface FirewallConfig {
    enabled: boolean;
    sensitivity: number;
    targetPatterns: string[];
    replacementText: string;
    logRedactions: boolean;
}
```

### `RPModeConfig`
```typescript
interface RPModeConfig {
    rpIntensity: number;
    loreDensity: number;
    allowMemoryRecall: boolean;
    allowAstro: boolean;
}
```

### `HybridModeConfig`
```typescript
interface HybridModeConfig {
    blendRatio: number;
    noTaskAcknowledgements: boolean;
    allowRag: boolean;
    allowMem0Search: boolean;
    allowAstro: boolean;
    allowFsRead: boolean;
    allowFsWrite: 'confirm' | 'off' | 'on';
    allowShellRun: boolean;
}
```

### `AssistantModeConfig`
```typescript
interface AssistantModeConfig {
    verbosity: 'concise' | 'normal' | 'detailed';
    autoUseTools: boolean;
    safeMode: boolean;
    memoryWrites: boolean;
    toolsOnlyCodingTurns: boolean;
    ollamaTimeoutMs: number;
}
```

### `AgentModesConfig`
```typescript
interface AgentModesConfig {
    activeMode: 'rp' | 'hybrid' | 'assistant';
    modes: {
        rp: RPModeConfig;
        hybrid: HybridModeConfig;
        assistant: AssistantModeConfig;
    }
```

### `AppSettings`
```typescript
interface AppSettings {
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
    database?: Partial<DatabaseConfig>;
    databaseBootstrap?: Partial<DatabaseBootstrapConfig>;
}
```

