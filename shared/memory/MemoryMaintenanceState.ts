/**
 * MemoryMaintenanceState.ts — Shared contracts for the scheduled memory
 * maintenance loop.
 *
 * Lives in shared/ so that the renderer (e.g. Reflection Dashboard) can
 * import these types without depending on the Node.js-only service layer.
 *
 * All types are plain serialisable objects — no class instances, no functions.
 */

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

/**
 * The overall memory maintenance posture derived from the latest scheduled run.
 *
 * stable   — no recurring issues, queue healthy, no escalations
 * watch    — minor or single-occurrence signals; monitoring warranted
 * unstable — recurring failures or degraded queue; repair cycles recommended
 * critical — repeated cycle failures, prolonged degradation, or growing
 *            dead-letter queue; immediate escalation required
 */
export type MemoryMaintenancePosture = 'stable' | 'watch' | 'unstable' | 'critical';

// ---------------------------------------------------------------------------
// MemoryRepairScheduledRunResult
// ---------------------------------------------------------------------------

/**
 * Result of a single scheduled memory repair analytics run.
 *
 * Produced by MemoryRepairSchedulerService and persisted in-memory as the
 * "last run" record for diagnostic surfaces.
 */
export type MemoryRepairScheduledRunResult = {
    /** ISO-8601 UTC timestamp when the scheduled run started. */
    startedAt: string;
    /** ISO-8601 UTC timestamp when the scheduled run completed. */
    completedAt: string;
    /** Analysis window used for this run (in hours). */
    windowHours: number;
    /** Overall memory maintenance posture determined for this run. */
    posture: MemoryMaintenancePosture;
    /** Human-readable descriptions of actions taken during this run. */
    actionsTaken: string[];
    /** Number of escalation candidates found in the analytics summary. */
    escalationCount: number;
    /** Number of recommendations in the generated reflection report. */
    recommendationCount: number;
    /**
     * True when the run was skipped (e.g. another run was already in-flight
     * or the outcome repository was not yet available).
     */
    skipped?: boolean;
    /** Human-readable reason for skipping, if applicable. */
    reason?: string;
};

// ---------------------------------------------------------------------------
// MemoryMaintenanceDecision
// ---------------------------------------------------------------------------

/**
 * Output of MemorySelfMaintenanceService.evaluate().
 *
 * A bounded, threshold-driven decision about what maintenance actions, if any,
 * should be taken based on the current analytics summary and reflection report.
 *
 * Invariants
 * ──────────
 * - No provider settings are changed.
 * - No integrity mode is changed.
 * - No user configuration is mutated.
 * - Actions are only triggered when patterns cross explicit thresholds.
 */
export type MemoryMaintenanceDecision = {
    /** Derived posture for this decision. */
    posture: MemoryMaintenancePosture;
    /** When true, the decision layer requests an additional repair cycle. */
    shouldTriggerRepairCycle: boolean;
    /** When true, deferred replay should be prioritised on the next drain pass. */
    shouldPrioritizeReplay: boolean;
    /** When true, an escalation event should be emitted to reflection/dashboard. */
    shouldEscalate: boolean;
    /** When true, affected subsystems should be flagged as unstable for planning. */
    shouldFlagUnstableSubsystems: boolean;
    /** Ordered list of concrete actions decided upon. */
    actions: MemoryMaintenanceAction[];
};

/**
 * A single action decided upon by MemorySelfMaintenanceService.
 */
export type MemoryMaintenanceAction = {
    /** Machine-readable action type. */
    type:
        | 'trigger_repair'
        | 'prioritize_replay'
        | 'emit_escalation'
        | 'publish_report'
        | 'none';
    /** Human-readable reason for this action. */
    reason: string;
    /**
     * Structured evidence that drove the decision.  Must contain concrete
     * counts, thresholds, and/or subsystem identifiers.
     */
    evidence: Record<string, unknown>;
};
