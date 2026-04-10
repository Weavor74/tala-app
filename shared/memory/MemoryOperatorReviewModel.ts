/**
 * MemoryOperatorReviewModel.ts — Unified operator-facing review payload
 *
 * Single structured payload consumed by the Memory Operator Review surface
 * (MemoryOperatorReviewPanel in the Reflection Dashboard).
 *
 * Assembled on the backend by MemoryOperatorReviewService and exposed via
 * the `memory:getOperatorReviewModel` IPC channel.
 *
 * Lives in shared/ so the renderer can import the type without depending on
 * any Node.js-only service.
 *
 * Design invariants
 * ─────────────────
 * 1. Read-only surface — no auto-apply, no hidden mutations.
 * 2. Bounded — top-N lists, recent cycles only, no raw telemetry dumps.
 * 3. Deterministic — same backend state → same model (excluding generatedAt).
 * 4. Renderer-safe — plain serialisable objects, no class instances.
 * 5. Advisory — optimization suggestions are human-gated recommendations only.
 */

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

/**
 * Overall memory maintenance posture surfaced by the operator review model.
 * Mirrors MemoryMaintenancePosture from MemoryMaintenanceState.ts.
 */
export type OperatorReviewPosture = 'stable' | 'watch' | 'unstable' | 'critical';

// ---------------------------------------------------------------------------
// Sub-sections
// ---------------------------------------------------------------------------

export type OperatorReviewHealth = {
    /** Top-level memory subsystem state string. */
    state: string;
    /** Resolved memory mode. */
    mode: string;
    /** Ordered list of failure reason codes. */
    reasons: string[];
    /** True when all memory-dependent operations are hard-disabled. */
    hardDisabled: boolean;
    /** True when a repair loop should be triggered. */
    shouldTriggerRepair: boolean;
    /** True when the status warrants high-priority escalation. */
    shouldEscalate: boolean;
};

export type OperatorReviewSummary = {
    /** One-line headline describing current posture. */
    headline: string;
    /** Short bullet-point key findings derived from analytics. */
    keyFindings: string[];
    /** Top failure reasons by occurrence count (bounded to top 5). */
    topFailureReasons: Array<{ reason: string; count: number }>;
    /** Subsystems with recurring instability (bounded to top 5). */
    unstableSubsystems: Array<{ subsystem: string; count: number }>;
};

export type OperatorReviewAdaptivePlan = {
    /** Human-readable description of the highest-priority recommended action. */
    recommendedPrimaryAction: string;
    /** Escalation bias recommendation: 'accelerate' | 'normal' | 'defer'. */
    escalationBias: string;
    /** Suggested scheduler cadence in minutes (derived from suggestedMultiplier). */
    cadenceRecommendationMinutes: number;
    /** Top priority targets sorted by urgency score (bounded to top 5). */
    topPriorities: Array<{
        target: string;
        score: number;
        reason: string;
    }>;
};

export type OperatorReviewOptimizationSuggestions = {
    /** Total number of suggestions in the latest report. */
    totalSuggestions: number;
    /**
     * Top suggestions sorted by priority score (bounded to top 8).
     * All suggestions are advisory — no auto-apply.
     */
    topSuggestions: Array<{
        id: string;
        category: string;
        title: string;
        summary: string;
        severity: string;
        priorityScore: number;
        /** Derived from suggestion rationale — the recommended human action. */
        recommendedHumanAction: string;
        affectedSubsystems: string[];
    }>;
};

export type OperatorReviewQueues = {
    /** Pending deferred extraction work items. */
    extractionPending: number;
    /** Pending deferred embedding work items. */
    embeddingPending: number;
    /** Pending deferred graph projection work items. */
    graphPending: number;
    /**
     * Dead-letter queue counts by kind.
     * Populated from the latest analytics window's queueBehavior.
     */
    deadLetters: Array<{ kind: string; count: number }>;
};

export type OperatorReviewRecentCycle = {
    /** Overall posture outcome for this scheduled maintenance run. */
    outcome: string;
    /** ISO-8601 timestamp when the run started. */
    startedAt: string;
    /** ISO-8601 timestamp when the run completed. */
    completedAt: string;
    /** Bounded actions taken during this run. */
    attemptedActions: string[];
    /** True if the run was skipped (concurrent run or error). */
    skipped: boolean;
};

export type OperatorReviewActionEffectiveness = {
    /** Repair action kind identifier. */
    action: string;
    /** Success rate as a fraction [0, 1]. */
    successRate: number;
    /** Total executions in the analysis window. */
    totalExecutions: number;
};

export type OperatorReviewRecentRepair = {
    /** ISO-8601 timestamp of the last maintenance scheduler run. */
    lastRunAt?: string | null;
    /** Recent maintenance scheduler cycles (bounded to last 5). */
    recentCycles: OperatorReviewRecentCycle[];
    /** Action effectiveness summary from the latest analytics window (bounded to top 5). */
    actionEffectiveness: OperatorReviewActionEffectiveness[];
};

// ---------------------------------------------------------------------------
// MemoryOperatorReviewModel
// ---------------------------------------------------------------------------

/**
 * Complete operator-facing review payload assembled by MemoryOperatorReviewService.
 *
 * Consumed exclusively by the Memory Operator Review panel in the Reflection
 * Dashboard.  All data originates from existing backend services; no new
 * analytics logic is embedded in the renderer.
 *
 * This model is:
 *   - Read-only:   no mutations occur when fetching this model
 *   - Advisory:    optimization suggestions are human-gated only
 *   - Bounded:     all lists are capped to prevent overwhelming the operator
 *   - Deterministic: same backend state → same rendered output (stable sort)
 */
export type MemoryOperatorReviewModel = {
    /** ISO-8601 UTC timestamp when this model was assembled. */
    generatedAt: string;

    /** Overall memory maintenance posture. */
    posture: OperatorReviewPosture;

    /** Current memory health status snapshot. */
    health: OperatorReviewHealth;

    /** Key findings and failure summary derived from the latest analytics run. */
    summary: OperatorReviewSummary;

    /**
     * Latest adaptive maintenance plan.
     * Null when no scheduled run has completed yet.
     */
    adaptivePlan: OperatorReviewAdaptivePlan | null;

    /** Latest human-gated optimization suggestions. */
    optimizationSuggestions: OperatorReviewOptimizationSuggestions;

    /** Current deferred work queue depths. */
    queues: OperatorReviewQueues;

    /** Recent maintenance scheduler run history. */
    recentRepair: OperatorReviewRecentRepair;

    /**
     * Advisory notes displayed at the bottom of the review surface.
     * Reminds operators that all recommendations are advisory only.
     */
    notes: string[];
};
