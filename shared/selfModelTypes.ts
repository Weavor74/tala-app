/**
 * Self-Model Foundation Types — Phase 1
 *
 * Canonical shared contracts for the self-model system. These types describe
 * Tala's understanding of its own structure: subsystems, files, invariants,
 * capabilities, dependencies, and test coverage.
 *
 * These types are intentionally strict and machine-readable — they are the
 * schema for the generated JSON artifacts and the query service results.
 */

// ─── Primitives ───────────────────────────────────────────────────────────────

/** Risk level for a subsystem, file, or invariant violation. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Confidence level for an ownership or query answer. */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unknown';

/** Kind of artifact found in the repository. */
export type ArtifactKind =
    | 'service'            // electron/services/**/*.ts
    | 'brain'              // electron/brains/**/*.ts
    | 'ipc_router'         // the IpcRouter.ts canonical routing hub
    | 'ipc_handler'        // other files that call ipcMain.handle
    | 'renderer_component' // src/renderer/components/**
    | 'renderer_util'      // src/renderer/utils/**
    | 'renderer_type'      // src/renderer/**types*.ts, src/renderer/**Types*.ts
    | 'shared_contract'    // shared/**/*.ts
    | 'mcp_server'         // mcp-servers/**
    | 'inference_server'   // local-inference/**
    | 'provider'           // *Provider.ts files inside retrieval
    | 'repository'         // *Repository.ts files
    | 'test'               // tests/**, electron/__tests__/**
    | 'doc'                // docs/**
    | 'script'             // scripts/**
    | 'config'             // *.json, *.yml, *.yaml, *.toml at root or config dirs
    | 'migration'          // electron/migrations/**
    | 'data_file'          // data/**
    | 'entrypoint'         // electron/main.ts, electron/preload.ts, etc.
    | 'unknown';

/** The nature of a dependency relationship between two nodes. */
export type DependencyKind =
    | 'ipc'              // communicates via Electron IPC
    | 'import'           // TypeScript module import
    | 'mcp_protocol'     // MCP tool invocation via McpService
    | 'http'             // HTTP request (e.g. local inference)
    | 'spawn'            // child_process.spawn
    | 'shared_contract'  // both sides depend on a shared type file
    | 'database'         // database read/write
    | 'filesystem';      // file read/write

/** Scope of a test file. */
export type TestScope = 'unit' | 'integration' | 'e2e' | 'smoke' | 'unknown';

// ─── Edges ────────────────────────────────────────────────────────────────────

/** A directed edge between two nodes (files or subsystem ids). */
export interface DependencyEdge {
    from: string;        // relative file path or subsystem id
    to: string;          // relative file path or subsystem id
    kind: DependencyKind;
    notes?: string;
}

/** Records which test file covers which paths or subsystem ids. */
export interface TestCoverageRecord {
    testFilePath: string;
    scope: TestScope;
    /** Paths or subsystem ids this test exercises. */
    covers: string[];
    notes?: string;
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

/**
 * A single file artifact in the repository inventory.
 * Produced by SelfModelScanner / SelfModelBuilder (P1B).
 */
export interface ArtifactRecord {
    /** Relative path from repo root. */
    path: string;
    kind: ArtifactKind;
    /** Subsystem id that owns this file. */
    subsystemId: string;
    /** Searchable tags derived from path, name, and classification. */
    tags: string[];
    /** True when this is a canonical entrypoint for its subsystem or the app. */
    isEntrypoint: boolean;
    /** True when this file is in a protected file registry. */
    isProtected: boolean;
    /** Top-level exports detected via lightweight regex scan. */
    exports?: string[];
    /** Test files associated by naming convention or path convention. */
    associatedTests?: string[];
    /** Documentation files associated by naming convention. */
    associatedDocs?: string[];
    /** Configuration files associated by naming convention. */
    associatedConfig?: string[];
    sizeBytes?: number;
    lastModifiedMs?: number;
}

/**
 * The full system inventory index produced by SelfModelBuilder (P1B).
 * Written to data/self_model/self_model_index.json.
 */
export interface SystemInventoryIndex {
    version: string;
    generatedAt: string;
    repoRoot: string;
    commitSha?: string;
    totalArtifacts: number;
    artifacts: ArtifactRecord[];
    kindSummary: Partial<Record<ArtifactKind, number>>;
}

// ─── Ownership ────────────────────────────────────────────────────────────────

/**
 * A single file-to-subsystem ownership record.
 */
export interface OwnershipRecord {
    /** Relative path from repo root. */
    path: string;
    /** Which subsystem claims authority over this file. */
    subsystemId: string;
    /** True when this is a canonical authority file (entrypoint, *Service.ts naming, etc.) */
    isAuthority: boolean;
    confidence: ConfidenceLevel;
    /** Why this ownership was determined (heuristic description). */
    reason?: string;
}

/**
 * A logical subsystem record describing a named area of the codebase.
 * Produced by OwnershipMapper (P1C).
 */
export interface SubsystemRecord {
    id: string;
    name: string;
    description: string;
    /** Root path prefixes that belong to this subsystem. */
    rootPaths: string[];
    /** Files that are the canonical authority for this subsystem's behavior. */
    authorityFiles: string[];
    /** Known entrypoint files. */
    entrypoints: string[];
    /** Subsystem ids this subsystem directly depends on. */
    dependencies: string[];
    /** Subsystem ids that depend on this one (blast radius). */
    dependents: string[];
    /** Invariant ids that apply to this subsystem. */
    invariantIds: string[];
    /** Test files that cover this subsystem. */
    testFiles: string[];
    /** Documentation files for this subsystem. */
    docFiles: string[];
    riskLevel: RiskLevel;
    confidence: ConfidenceLevel;
    notes?: string;
}

/**
 * The full ownership map, produced by OwnershipMapper (P1C).
 * Written to data/self_model/subsystem_ownership_map.json.
 */
export interface OwnershipMap {
    version: string;
    generatedAt: string;
    subsystems: SubsystemRecord[];
    /** Per-file ownership records (sparse — only files with non-trivial ownership). */
    ownership: OwnershipRecord[];
    dependencyEdges: DependencyEdge[];
}

// ─── Invariants ───────────────────────────────────────────────────────────────

/** How an invariant is currently enforced. */
export type InvariantEnforcementMode =
    | 'test_covered'     // a specific test file validates this
    | 'runtime_asserted' // asserted at runtime (guard/registry)
    | 'design_only'      // no automated check — relies on code review
    | 'ci_checked';      // checked by a script or linter in CI

/**
 * A single invariant record in the hand-authored invariant registry.
 */
export interface InvariantRecord {
    id: string;
    title: string;
    description: string;
    /** Risk level if this invariant is violated. */
    severity: RiskLevel;
    /** Subsystem ids to which this invariant applies. */
    appliesToSubsystems: string[];
    enforcementMode: InvariantEnforcementMode;
    /** Test file paths that verify this invariant. */
    testFileRefs?: string[];
    /** How to check whether this invariant holds. */
    verificationHints?: string[];
    /** Common failure modes or caveats. */
    notes?: string;
}

/**
 * The invariant registry container.
 * Loaded from data/self_model/invariant_registry.json.
 */
export interface InvariantRegistry {
    version: string;
    lastReviewedAt: string;
    invariants: InvariantRecord[];
}

// ─── Capabilities ─────────────────────────────────────────────────────────────

/**
 * A single capability record describing a concrete current capability.
 */
export interface CapabilityRecord {
    id: string;
    name: string;
    /** True if this capability is currently implemented and available. */
    available: boolean;
    /** The service or file that owns the capability implementation. */
    authoritySource: string;
    /** How the capability is executed (e.g. 'electron/services/...', 'IPC channel', etc.) */
    executionPath?: string;
    /** Constraints or preconditions on usage. */
    constraints?: string[];
    /** IPC channels that expose this capability. */
    ipcChannels?: string[];
    /** Operating modes that allow this capability. */
    allowedModes?: string[];
    /** Failure conditions or known limitations. */
    notes?: string;
}

/**
 * The capability registry container.
 * Loaded from data/self_model/capability_registry.json.
 */
export interface CapabilityRegistry {
    version: string;
    lastReviewedAt: string;
    capabilities: CapabilityRecord[];
}

// ─── Query results ────────────────────────────────────────────────────────────

/** Result of an ownership query. */
export interface OwnershipQueryResult {
    target: string;
    owningSubsystem?: SubsystemRecord;
    owningFiles: OwnershipRecord[];
    relatedTests: string[];
    relatedInvariants: InvariantRecord[];
    confidence: ConfidenceLevel;
    reasoning: string;
}

/** Result of a blast radius / affected-systems query. */
export interface BlastRadiusResult {
    subsystemId: string;
    subsystemName: string;
    directDependents: string[];
    transitivelyAffected: string[];
    riskLevel: RiskLevel;
    reasoning: string;
}

/** Generic wrapper for a self-model query result. */
export interface SelfModelQueryResult<T = unknown> {
    queryType: string;
    target: string;
    answeredAt: string;
    confidence: ConfidenceLevel;
    data: T;
}

// ─── Self-model metadata ──────────────────────────────────────────────────────

/** Health status of the self-model artifacts. */
export type SelfModelHealthStatus = 'fresh' | 'stale' | 'drifted' | 'missing' | 'error';

/**
 * Metadata about the last self-model generation run.
 * Written to data/self_model/self_model_meta.json.
 */
export interface SelfModelMeta {
    version: string;
    generatedAt: string;
    commitSha?: string;
    /** SHA-256 of self_model_index.json at generation time. */
    indexHash: string;
    /** SHA-256 of subsystem_ownership_map.json at generation time. */
    ownershipHash: string;
    status: SelfModelHealthStatus;
    /** Why the artifacts are considered stale, if applicable. */
    staleReasons: string[];
    /** Subsystem ids whose file lists have changed since last generation. */
    driftedSubsystems: string[];
    /** How long the last refresh took in milliseconds. */
    refreshDurationMs: number;
}
