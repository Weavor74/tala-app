# Contract: worldModelTypes.ts

**Source**: [shared\worldModelTypes.ts](../../shared/worldModelTypes.ts)

## Interfaces

### `WorldModelSectionMeta`
```typescript
interface WorldModelSectionMeta {
    /** ISO 8601 timestamp when this section was last assembled. */
    assembledAt: string;
    /** Source freshness classification. */
    freshness: WorldModelFreshness;
    /** Availability classification for this section. */
    availability: WorldModelAvailability;
    /** Human-readable reason for degraded or unavailable state. */
    degradedReason?: string;
}
```

### `WorkspaceState`
```typescript
interface WorkspaceState {
    /** Section metadata. */
    meta: WorldModelSectionMeta;
    /** Absolute path of the active workspace root. */
    workspaceRoot: string;
    /** High-level workspace classification. */
    classification: WorkspaceClassification;
    /** Whether a workspace root could be resolved. */
    rootResolved: boolean;
    /** Key directories present in the workspace (e.g. src, electron, docs, tests). */
    knownDirectories: string[];
    /** Recently active files (paths relative to workspace root), if available. */
    recentFiles: string[];
    /** Active/open files in the editor context, if available. */
    activeFiles: string[];
    /** Number of open notebook/artifact tabs, if available. */
    openArtifactCount: number;
}
```

### `RepoState`
```typescript
interface RepoState {
    /** Section metadata. */
    meta: WorldModelSectionMeta;
    /** Absolute path of the repository root. */
    repoRoot: string;
    /** Whether a valid Git repository was detected. */
    isRepo: boolean;
    /** Current branch name, if available. */
    branch?: string;
    /** Whether the working tree has uncommitted changes. */
    isDirty: boolean;
    /** Number of uncommitted changed files. */
    changedFileCount: number;
    /** Project type classification based on directory structure. */
    projectType: RepoProjectType;
    /** Key directories detected (e.g. src, electron, docs, tests, scripts). */
    detectedDirectories: string[];
    /** Whether architecture documentation was found (docs/ directory). */
    hasArchitectureDocs: boolean;
    /** Whether an indexed docs directory is present. */
    hasIndexedDocs: boolean;
    /** Summary of last known test/build status, if available. */
    lastBuildStatusSummary?: string;
}
```

### `RuntimeWorldState`
```typescript
interface RuntimeWorldState {
    /** Section metadata. */
    meta: WorldModelSectionMeta;
    /** Whether the inference subsystem is operational. */
    inferenceReady: boolean;
    /** ID of the currently selected inference provider. */
    selectedProviderId?: string;
    /** Display name of the currently selected provider. */
    selectedProviderName?: string;
    /** Total number of inference providers in the registry. */
    totalProviders: number;
    /** Number of providers currently ready. */
    readyProviders: number;
    /** Names of subsystems currently in degraded or failed state. */
    degradedSubsystems: string[];
    /** Whether any critical subsystem is degraded or unavailable. */
    hasActiveDegradation: boolean;
    /** Whether a stream is currently active. */
    streamActive: boolean;
}
```

### `ServiceWorldState`
```typescript
interface ServiceWorldState {
    /** Stable service ID. */
    serviceId: string;
    /** Human-readable display name. */
    displayName: string;
    /** Whether this service is currently ready. */
    ready: boolean;
    /** Whether this service is degraded. */
    degraded: boolean;
    /** Whether this service is enabled. */
    enabled: boolean;
    /** Current normalized lifecycle status. */
    status: string;
    /** Reason for degradation or unavailability, if any. */
    failureReason?: string;
}
```

### `ToolWorldState`
```typescript
interface ToolWorldState {
    /** Section metadata. */
    meta: WorldModelSectionMeta;
    /** Names/IDs of tools currently enabled and available. */
    enabledTools: string[];
    /** Names/IDs of tools currently blocked by policy. */
    blockedTools: string[];
    /** Names/IDs of tools currently degraded or failing. */
    degradedTools: string[];
    /** MCP service states (compact per-service view). */
    mcpServices: ServiceWorldState[];
    /** Total MCP services configured. */
    totalMcpServices: number;
    /** MCP services currently ready. */
    readyMcpServices: number;
}
```

### `ProviderWorldState`
```typescript
interface ProviderWorldState {
    /** Section metadata. */
    meta: WorldModelSectionMeta;
    /** ID of the currently preferred/selected provider. */
    preferredProviderId?: string;
    /** Display name of the currently preferred provider. */
    preferredProviderName?: string;
    /** IDs of providers currently available and ready. */
    availableProviders: string[];
    /** IDs of providers currently suppressed from auto-selection. */
    suppressedProviders: string[];
    /** IDs of providers currently degraded. */
    degradedProviders: string[];
    /** Total providers in the registry. */
    totalProviders: number;
    /** Whether a fallback was applied during the last inference turn. */
    lastFallbackApplied: boolean;
}
```

### `UserGoalState`
```typescript
interface UserGoalState {
    /** Section metadata. */
    meta: WorldModelSectionMeta;
    /** The immediate task or request from the current/most-recent turn. */
    immediateTask?: string;
    /** Confidence level for the immediate task. */
    immediateTaskConfidence: GoalStateConfidence;
    /** Current project or domain the user is actively working in. */
    currentProjectFocus?: string;
    /** Confidence level for the current project focus. */
    projectFocusConfidence: GoalStateConfidence;
    /** Stable high-level direction or preference inferred from profile/memory. */
    stableDirection?: string;
    /** Whether an explicit user goal statement is in effect (outranks inferred state). */
    hasExplicitGoal: boolean;
    /** Whether goal state is considered stale (no recent turns to infer from). */
    isStale: boolean;
    /** ISO timestamp of the last goal inference or update. */
    lastInferredAt?: string;
}
```

### `WorldModelAlert`
```typescript
interface WorldModelAlert {
    /** Severity of this alert. */
    severity: WorldModelAlertSeverity;
    /** The section this alert pertains to. */
    section: 'workspace' | 'repo' | 'runtime' | 'tools' | 'providers' | 'goals';
    /** Human-readable alert message. */
    message: string;
}
```

### `WorldModelSummary`
```typescript
interface WorldModelSummary {
    /** Number of sections available (not unavailable). */
    sectionsAvailable: number;
    /** Number of sections that are degraded or partial. */
    sectionsDegraded: number;
    /** Number of sections unavailable. */
    sectionsUnavailable: number;
    /** Whether any runtime degradation is active. */
    hasActiveDegradation: boolean;
    /** Whether the repo has uncommitted changes. */
    repoDirty: boolean;
    /** Active task focus label (compact, for cognitive injection). */
    activeTaskFocus?: string;
    /** Active alerts for this world model snapshot. */
    alerts: WorldModelAlert[];
}
```

### `TalaWorldModel`
```typescript
interface TalaWorldModel {
    /** ISO 8601 timestamp when this world model snapshot was assembled. */
    timestamp: string;
    /** Session ID for telemetry correlation. */
    sessionId?: string;
    /** Workspace state. */
    workspace: WorkspaceState;
    /** Repo state. */
    repo: RepoState;
    /** Runtime world state. */
    runtime: RuntimeWorldState;
    /** Tool world state. */
    tools: ToolWorldState;
    /** Provider world state. */
    providers: ProviderWorldState;
    /** User goal state. */
    goals: UserGoalState;
    /** World model summary and active alerts. */
    summary: WorldModelSummary;
    /** Whether this model was built from a full or partial assembly. */
    assemblyMode: 'full' | 'partial' | 'degraded';
}
```

### `WorldModelDiagnosticsSummary`
```typescript
interface WorldModelDiagnosticsSummary {
    /** ISO timestamp of the world model snapshot. */
    timestamp: string;
    /** Assembly mode of the snapshot. */
    assemblyMode: 'full' | 'partial' | 'degraded';
    /** Workspace availability and classification. */
    workspace: {
        availability: WorldModelAvailability;
        classification: WorkspaceClassification;
        workspaceRoot: string;
        freshness: WorldModelFreshness;
    }
```

### `WorldModelAssemblerOptions`
```typescript
interface WorldModelAssemblerOptions {
    /**
     * Maximum age in milliseconds before a cached world model is considered stale.
     * Default: 30 000 ms (30 seconds).
     */
    maxAgeMs: number;
    /**
     * Whether to include repo state (requires git queries — slightly slower).
     * Default: true.
     */
    includeRepoState: boolean;
    /**
     * Session ID for telemetry correlation.
     */
    sessionId?: string;
}
```

### `UserGoalAssemblyInput`
```typescript
interface UserGoalAssemblyInput {
    /** The current user turn text (immediate task). */
    currentTurnText?: string;
    /** Recent turn summaries for project focus inference. */
    recentTurnSummaries?: string[];
    /** Profile-derived high-level direction (if available). */
    profileDirection?: string;
    /** Whether the current turn contains an explicit goal statement. */
    hasExplicitGoalStatement?: boolean;
}
```

### `WorldModelFreshness`
```typescript
type WorldModelFreshness =  'fresh' | 'stale' | 'unknown';
```

### `WorldModelAvailability`
```typescript
type WorldModelAvailability =  'available' | 'partial' | 'degraded' | 'unavailable';
```

### `WorkspaceClassification`
```typescript
type WorkspaceClassification =  'repo' | 'docs_project' | 'mixed' | 'unknown';
```

### `RepoProjectType`
```typescript
type RepoProjectType = 
    | 'electron_app'
    | 'node_library'
    | 'python_project'
    | 'docs_only'
    | 'mixed'
    | 'unknown';
```

### `GoalStateConfidence`
```typescript
type GoalStateConfidence =  'high' | 'medium' | 'low';
```

### `WorldModelAlertSeverity`
```typescript
type WorldModelAlertSeverity =  'info' | 'warn' | 'error';
```

