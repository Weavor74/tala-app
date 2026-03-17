/**
 * Canonical World Model Types — Phase 4A: World Model Foundation
 *
 * Defines the single authoritative type model for Tala's structured understanding
 * of the environment she operates in. The world model unifies:
 *   - workspace state (files, directories, open artifacts)
 *   - repo state (branch, dirty/clean, key directories, project classification)
 *   - runtime/service state (inference providers, MCP services, degraded subsystems)
 *   - tool/provider state (enabled, blocked, degraded, suppressed)
 *   - user-goal state (immediate task, project focus, persistent direction)
 *
 * Design rules:
 * - All sections support partial/degraded state safely.
 * - Every field that can be stale carries a timestamp or freshness marker.
 * - Normalized status values are preferred over raw booleans.
 * - No raw file contents, raw prompts, or untyped metadata blobs.
 * - Safe to serialize over IPC (no circular refs, no functions).
 * - Compact and cognition-friendly — not a full CMDB or asset graph.
 */

// ─── Freshness / degraded metadata ───────────────────────────────────────────

/**
 * Source freshness classification for a world-model section.
 * fresh   — assembled within the current session and within the freshness window.
 * stale   — assembled but older than the freshness window; may be outdated.
 * unknown — freshness cannot be determined (source unavailable or never queried).
 */
export type WorldModelFreshness = 'fresh' | 'stale' | 'unknown';

/**
 * Availability classification for a world-model section.
 * available   — section is fully populated.
 * partial     — section is partially populated (some fields unavailable).
 * degraded    — section is populated but with known errors or missing critical data.
 * unavailable — section could not be populated at all.
 */
export type WorldModelAvailability = 'available' | 'partial' | 'degraded' | 'unavailable';

/**
 * Common metadata attached to each world-model section.
 */
export interface WorldModelSectionMeta {
    /** ISO 8601 timestamp when this section was last assembled. */
    assembledAt: string;
    /** Source freshness classification. */
    freshness: WorldModelFreshness;
    /** Availability classification for this section. */
    availability: WorldModelAvailability;
    /** Human-readable reason for degraded or unavailable state. */
    degradedReason?: string;
}

// ─── Workspace state ──────────────────────────────────────────────────────────

/**
 * High-level workspace classification.
 * repo        — workspace is a source-code repository.
 * docs_project — workspace is primarily documentation.
 * mixed       — workspace contains both code and docs.
 * unknown     — classification could not be determined.
 */
export type WorkspaceClassification = 'repo' | 'docs_project' | 'mixed' | 'unknown';

/**
 * Workspace state — Tala's understanding of the workspace environment.
 */
export interface WorkspaceState {
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

// ─── Repo state ───────────────────────────────────────────────────────────────

/**
 * Repo project type classification.
 * electron_app  — Electron + React desktop app (TALA pattern).
 * node_library  — Node.js library or package.
 * python_project — Python project.
 * docs_only     — Documentation-only repository.
 * mixed         — Multiple project types.
 * unknown       — Could not be classified.
 */
export type RepoProjectType =
    | 'electron_app'
    | 'node_library'
    | 'python_project'
    | 'docs_only'
    | 'mixed'
    | 'unknown';

/**
 * Repo state — Tala's understanding of the source-control repository.
 */
export interface RepoState {
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

// ─── Runtime world state ──────────────────────────────────────────────────────

/**
 * Runtime world state — Tala's understanding of the runtime and services environment.
 * Projected from RuntimeDiagnosticsSnapshot — not a duplicate, a cognition-friendly view.
 */
export interface RuntimeWorldState {
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

/**
 * Per-service world state entry.
 */
export interface ServiceWorldState {
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

// ─── Tool / provider world state ─────────────────────────────────────────────

/**
 * Tool world state — what tools Tala can use, should avoid, or that are unhealthy.
 */
export interface ToolWorldState {
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

/**
 * Provider world state — what inference providers are available to Tala.
 */
export interface ProviderWorldState {
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

// ─── User goal state ─────────────────────────────────────────────────────────

/**
 * Confidence level for inferred goal state.
 * high    — explicit user statement (current turn or very recent).
 * medium  — inferred from recent turns or active context.
 * low     — inferred from older or indirect signals.
 */
export type GoalStateConfidence = 'high' | 'medium' | 'low';

/**
 * User goal state — Tala's bounded model of the user's current goals and focus.
 * Not deep psychology — a compact, actionable summary for situational awareness.
 */
export interface UserGoalState {
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

// ─── World model summary / alerts ────────────────────────────────────────────

/**
 * Alert severity level in the world model summary.
 */
export type WorldModelAlertSeverity = 'info' | 'warn' | 'error';

/**
 * A single alert entry in the world model summary.
 */
export interface WorldModelAlert {
    /** Severity of this alert. */
    severity: WorldModelAlertSeverity;
    /** The section this alert pertains to. */
    section: 'workspace' | 'repo' | 'runtime' | 'tools' | 'providers' | 'goals';
    /** Human-readable alert message. */
    message: string;
}

/**
 * Top-level world model summary.
 * Cognition-friendly rollup of all section states and active alerts.
 */
export interface WorldModelSummary {
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

// ─── Top-level world model ────────────────────────────────────────────────────

/**
 * TalaWorldModel — the canonical structured world model for Tala.
 *
 * Assembled by WorldModelAssembler. Represents Tala's situational awareness
 * at a point in time. Supports partial state safely — unavailable sections
 * are marked as unavailable, never silently absent.
 *
 * Safe for IPC serialization. Does not contain raw user content or model prompts.
 */
export interface TalaWorldModel {
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

// ─── Diagnostics read model ───────────────────────────────────────────────────

/**
 * WorldModelDiagnosticsSummary — IPC-safe read model for the world model.
 *
 * A normalized, compact view of the world model for diagnostics surfaces.
 * Does not include raw file contents, full prompts, or excessive user data.
 */
export interface WorldModelDiagnosticsSummary {
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
    };
    /** Repo availability and key fields. */
    repo: {
        availability: WorldModelAvailability;
        isRepo: boolean;
        branch?: string;
        isDirty: boolean;
        projectType: RepoProjectType;
        freshness: WorldModelFreshness;
    };
    /** Runtime availability and degradation state. */
    runtime: {
        availability: WorldModelAvailability;
        inferenceReady: boolean;
        selectedProviderId?: string;
        selectedProviderName?: string;
        degradedSubsystems: string[];
        hasActiveDegradation: boolean;
        freshness: WorldModelFreshness;
    };
    /** Tool/provider availability summary. */
    tools: {
        availability: WorldModelAvailability;
        enabledToolCount: number;
        blockedToolCount: number;
        degradedToolCount: number;
        readyMcpServices: number;
        totalMcpServices: number;
        freshness: WorldModelFreshness;
    };
    /** Provider availability summary. */
    providers: {
        availability: WorldModelAvailability;
        preferredProviderId?: string;
        preferredProviderName?: string;
        availableCount: number;
        suppressedCount: number;
        degradedCount: number;
        freshness: WorldModelFreshness;
    };
    /** Goal state summary. */
    goals: {
        availability: WorldModelAvailability;
        hasExplicitGoal: boolean;
        immediateTask?: string;
        currentProjectFocus?: string;
        isStale: boolean;
        freshness: WorldModelFreshness;
    };
    /** World model summary alerts. */
    alerts: WorldModelAlert[];
    /** Overall summary counters. */
    summary: WorldModelSummary;
}

// ─── Assembler options ────────────────────────────────────────────────────────

/**
 * Options controlling WorldModelAssembler behavior.
 */
export interface WorldModelAssemblerOptions {
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

/**
 * Input context for assembling UserGoalState.
 */
export interface UserGoalAssemblyInput {
    /** The current user turn text (immediate task). */
    currentTurnText?: string;
    /** Recent turn summaries for project focus inference. */
    recentTurnSummaries?: string[];
    /** Profile-derived high-level direction (if available). */
    profileDirection?: string;
    /** Whether the current turn contains an explicit goal statement. */
    hasExplicitGoalStatement?: boolean;
}
