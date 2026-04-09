/**
 * MemoryAdaptivePlan.ts — Shared contracts for the adaptive planning layer
 *
 * Produced by MemoryAdaptivePlanningService and consumed by
 * MemoryRepairSchedulerService and MemorySelfMaintenanceService.
 *
 * Lives in shared/ so the renderer (e.g. reflection dashboard) can import
 * plan types without depending on the Node.js-only service layer.
 *
 * All types are plain serialisable objects — no class instances, no functions.
 *
 * Design invariants
 * ─────────────────
 * 1. Deterministic — same MemoryRepairInsightSummary input → same plan output
 *    (excluding the generatedAt timestamp).
 * 2. Read-only — plans describe recommendations only; they do not mutate config,
 *    provider settings, integrity mode, or user configuration.
 * 3. Bounded — scores are integers in [0, 100]; multipliers are in [0.25, 4.0].
 * 4. Explainable — every recommendation includes structured evidence tied to
 *    concrete counts, timestamps, and/or identifiers from the repair history.
 * 5. Non-authoritative — plans adjust prioritisation and cadence recommendations;
 *    MemoryIntegrityPolicy remains the authoritative capability gate.
 */

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/**
 * The subsystem or work-queue target that a priority recommendation addresses.
 *
 * Non-replay targets map to live memory subsystems.
 * Replay targets map to the deferred-work queue by operation kind.
 */
export type MemoryAdaptiveTarget =
    | 'canonical'
    | 'mem0'
    | 'graph'
    | 'rag'
    | 'replay_extraction'
    | 'replay_embedding'
    | 'replay_graph';

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/**
 * A scored priority recommendation for a specific repair target.
 *
 * Higher score → more urgent prioritisation in the next repair cycle.
 * Score range: 0–100 (integer, clamped).
 *
 * Components:
 *   - Failure frequency:  min(50, occurrenceCount × 10)
 *   - Escalation bonus:   +20 if target subsystem appears in escalation candidates
 *   - Effectiveness gap:  +15 if best related action successRate < 0.4 (≥2 runs)
 *                         +10 additional if successRate === 0
 *   - Recency bonus:      +10 if lastSeenAt is within the past hour
 *   - Dead-letter queue:  replay targets scored from queue depth + growth flag
 */
export type MemoryAdaptivePriority = {
    /** Target subsystem or work-queue. */
    target: MemoryAdaptiveTarget;
    /**
     * Urgency score from 0 (lowest) to 100 (highest).
     * Derived deterministically from repair history; no speculation.
     */
    score: number;
    /** Human-readable explanation tied to concrete evidence. */
    reason: string;
    /** Structured evidence that drove this score. */
    evidence: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/**
 * Recommended adjustment to the scheduler polling cadence.
 *
 * tighten — run maintenance sooner than the default interval
 * relax   — run maintenance less frequently when the system is quiet
 * normal  — no change to the default interval
 */
export type MemoryAdaptiveCadenceRecommendation = 'tighten' | 'relax' | 'normal';

/**
 * Recommendation for adjusting how frequently the scheduler fires.
 *
 * suggestedMultiplier is applied to the scheduler's configured intervalMs:
 *   0.5  = run at half the normal interval (twice as often)
 *   1.0  = no change
 *   2.0  = run at double the normal interval (half as often)
 *
 * The scheduler may honour or ignore this recommendation within its own
 * cooldown constraints.  The multiplier does not override the scheduler's
 * minimum or maximum interval bounds.
 */
export type MemoryAdaptiveCadence = {
    recommendation: MemoryAdaptiveCadenceRecommendation;
    /**
     * Suggested multiplier applied to the scheduler's intervalMs.
     * Clamped to [0.25, 4.0] by convention.
     */
    suggestedMultiplier: number;
    /** Human-readable explanation. */
    reason: string;
    /** Structured evidence. */
    evidence: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Escalation bias
// ---------------------------------------------------------------------------

/**
 * Bias applied to escalation sensitivity for the current planning window.
 *
 * accelerate — escalate sooner than normal thresholds (pattern is worsening)
 * normal     — standard escalation threshold behaviour
 * defer      — lower escalation urgency (pattern is self-resolving)
 */
export type MemoryAdaptiveEscalationBias = 'accelerate' | 'normal' | 'defer';

/**
 * Recommendation for adjusting escalation sensitivity in the current cycle.
 */
export type MemoryAdaptiveEscalation = {
    bias: MemoryAdaptiveEscalationBias;
    /** Human-readable explanation. */
    reason: string;
    /** Structured evidence. */
    evidence: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// MemoryAdaptivePlan
// ---------------------------------------------------------------------------

/**
 * The complete adaptive maintenance plan produced by MemoryAdaptivePlanningService.
 *
 * This plan is:
 *   - Deterministic:   same summary → same plan (except generatedAt)
 *   - Read-only:       does not mutate config, providers, or integrity mode
 *   - Bounded:         scores in [0,100]; multipliers in [0.25,4.0]
 *   - Explainable:     every recommendation includes structured evidence
 *   - Non-authoritative: MemoryIntegrityPolicy remains the authoritative gate
 *
 * Consumed by:
 *   - MemoryRepairSchedulerService  — priority-ordered repair cycle targeting
 *   - MemorySelfMaintenanceService  — escalation and subsystem-flagging decisions
 *   - Reflection / dashboard surfaces (future)
 */
export type MemoryAdaptivePlan = {
    /** ISO-8601 UTC timestamp when this plan was generated. */
    generatedAt: string;
    /** Analysis window (in hours) the plan was derived from. */
    windowHours: number;
    /**
     * Priority-ordered list of repair targets, highest score first.
     * Empty when the system is healthy and no specific prioritisation is needed.
     */
    priorities: MemoryAdaptivePriority[];
    /** Recommended adjustment to the scheduler cadence. */
    cadence: MemoryAdaptiveCadence;
    /** Recommended adjustment to escalation sensitivity. */
    escalation: MemoryAdaptiveEscalation;
    /**
     * Subsystem identifiers currently flagged as unstable.
     * A subsystem is unstable when recurring failures, low action effectiveness,
     * and/or escalation candidates indicate persistent or worsening behaviour.
     * Empty when the system is healthy.
     */
    unstableSubsystems: string[];
    /**
     * When true, the planner recommends prioritising deferred replay drains
     * over restart-based repair actions for the current cycle.
     *
     * Set to true when the dead-letter queue is growing and drain action
     * effectiveness equals or exceeds reconnect/reinit action effectiveness,
     * or when no reconnect data is available and the queue is growing.
     */
    preferReplayOverRestart: boolean;
    /**
     * Human-readable single-line summary of the key adaptive adjustments
     * in this plan.  Suitable for telemetry payloads and diagnostic logs.
     */
    summary: string;
};
