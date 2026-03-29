/**
 * recoveryPackTypes.ts — Phase 4.3 Canonical Recovery Pack Contracts
 *
 * P4.3A: Recovery Pack Types & Contracts
 *
 * Canonical shared contracts for the Autonomous Recovery Pack layer.
 * Shared between Electron main process and renderer.
 *
 * Design principles:
 * - Local-first: no network, no cloud state
 * - Deterministic-first: all matching is rule-based, no model calls for matching
 * - Bounded: packs are file-scoped or subsystem-scoped with hard limits
 * - Auditable: every pack use is logged with full rationale
 * - Non-bypassing: all pack-backed actions still flow through planning, governance, execution
 * - No chaining: a recovery pack may not trigger another pack
 *
 * Relationship to prior phases:
 *   Phase 4   (autonomy)    — AutonomousGoal drives pack matching
 *   Phase 2   (planning)    — SafeChangePlanner receives pack-built PlanTriggerInput
 *   Phase 3.5 (governance)  — all pack-backed proposals require governance evaluation
 *   Phase 3   (execution)   — all pack-backed proposals require execution eligibility
 */

// ─── Identity ─────────────────────────────────────────────────────────────────

/** Stable identifier for a recovery pack. Ends in _v{N} for versioning. */
export type RecoveryPackId = string;

/** Semantic version string for a recovery pack definition, e.g. "1.0.0". */
export type RecoveryPackVersion = string;

// ─── Scope ────────────────────────────────────────────────────────────────────

/**
 * Bounds on what a recovery pack may propose.
 *
 * The RecoveryPackPlannerAdapter MUST NOT produce a PlanTriggerInput that
 * implies touching more files than maxFiles, or touching subsystems outside
 * allowedSubsystems.
 */
export interface RecoveryPackScope {
    /**
     * Maximum number of files the pack may include in any proposal.
     * 0 means the pack takes in-memory/structural action only (no file writes).
     */
    maxFiles: number;
    /**
     * Subsystem IDs this pack is permitted to address.
     * Must not overlap with the AutonomyPolicy.hardBlockedSubsystems list.
     */
    allowedSubsystems: string[];
    /**
     * Optional explicit file path glob patterns the pack may touch.
     * Empty array means any file within the allowed subsystems is permitted
     * (up to maxFiles).
     */
    allowedFilePaths: string[];
}

// ─── Applicability Rules ─────────────────────────────────────────────────────

/**
 * Kinds of deterministic matching rules available.
 *
 * All evaluation is done by direct field comparison or string containment.
 * No model inference is used.
 */
export type RecoveryPackApplicabilityRuleKind =
    | 'goal_source_match'       // goal.source === matchValue (exact)
    | 'min_source_count'        // numeric count in sourceContext >= parseInt(matchValue)
    | 'keyword_in_title'        // goal.title.toLowerCase().includes(matchValue.toLowerCase())
    | 'subsystem_id_match';     // goal.subsystemId === matchValue (exact)

/**
 * A single deterministic rule that contributes to a pack's match score.
 *
 * Required rules act as mandatory filters: if any required rule fails,
 * the pack's score is forced to 0 regardless of other rules.
 */
export interface RecoveryPackApplicabilityRule {
    ruleId: string;
    kind: RecoveryPackApplicabilityRuleKind;
    /**
     * The value to compare against.
     * - For goal_source_match: a GoalSource string (e.g. "repeated_execution_failure")
     * - For min_source_count: a numeric string (e.g. "3") representing a minimum count
     * - For keyword_in_title: a substring to search for (case-insensitive)
     * - For subsystem_id_match: an exact subsystem ID
     */
    matchValue: string;
    /** Weight contribution to total match score (0–100). */
    weight: number;
    /**
     * If true, this rule must match or the pack's score is zeroed.
     * Required rules are evaluated first; on any required-rule miss the pack is skipped.
     */
    required: boolean;
}

// ─── Action Template ─────────────────────────────────────────────────────────

/**
 * Describes a bounded repair action that a pack proposes.
 *
 * This is a TEMPLATE, not an executable instruction. The RecoveryPackPlannerAdapter
 * reads these templates and encodes them as bounded guidance in a PlanTriggerInput
 * description. SafeChangePlanner then runs its deterministic pipeline on that input.
 *
 * No file writes happen at this layer.
 */
export interface RecoveryPackActionTemplate {
    actionId: string;
    /** Human-readable description of what this action addresses. */
    description: string;
    /**
     * Target file path template. May use placeholders like {subsystemId}.
     * Used by the adapter to restrict the planning scope.
     */
    targetFileTemplate: string;
    /**
     * Structured descriptor for the kind of change.
     * Serializable JSON — used for audit and dashboard display.
     */
    patchDescriptor: Record<string, unknown>;
    /** When true, the pack can succeed even if this action is not applicable. */
    optional: boolean;
}

// ─── Verification Template ────────────────────────────────────────────────────

/**
 * Describes a verification check that should be performed after applying a pack.
 *
 * These are passed as guidance in the PlanTriggerInput description so that
 * VerificationRequirementsEngine can materialize them into VerificationRequirements.
 */
export interface RecoveryPackVerificationTemplate {
    verificationId: string;
    /** Human-readable description of what this check confirms. */
    description: string;
    /** Path or pattern to verify against. */
    targetPath: string;
    /** Whether failing this verification counts as a pack failure. */
    required: boolean;
}

// ─── Rollback Template ────────────────────────────────────────────────────────

export interface RecoveryPackRollbackTemplate {
    rollbackId: string;
    /** Human-readable description of rollback expectation. */
    description: string;
    /** How rollback is handled for this pack's changes. */
    strategy: 'revert_patched_files' | 'no_rollback_needed' | 'manual_review_required';
    /**
     * Additional file paths to snapshot before applying, beyond the pack's
     * action template targets. Allows safe rollback of dependent files.
     */
    extraSnapshotPaths: string[];
}

// ─── Confidence ───────────────────────────────────────────────────────────────

/**
 * Per-pack operational confidence score.
 *
 * Confidence is NOT model weight. It is an empirical operational metric derived
 * from recorded outcomes. It adjusts gradually on success/failure and is bounded.
 *
 * A pack with confidence below `floor` is automatically disqualified from use.
 */
export interface RecoveryPackConfidence {
    /** Current computed confidence. 0.0–1.0. */
    current: number;
    /** Starting confidence for a freshly deployed pack. Typically 0.65. */
    initial: number;
    /** Floor below which the pack is disqualified. Default: 0.3. */
    floor: number;
    /** Ceiling above which confidence cannot rise further. Default: 0.95. */
    ceiling: number;
    /** Cumulative count of successful executions. */
    successCount: number;
    /** Cumulative count of failed executions. */
    failureCount: number;
    /** Cumulative count of rollbacks triggered. */
    rollbackCount: number;
    /** ISO timestamp of last confidence adjustment. */
    lastAdjustedAt?: string;
}

// ─── The Recovery Pack ────────────────────────────────────────────────────────

/**
 * Canonical definition of a recovery pack.
 *
 * Recovery packs are source-controlled (committed in recoveryPacks.ts), versioned,
 * deterministic, and inspectable. The confidence.current value is the only mutable
 * field and is stored in a local confidence-override file, not in the pack definition.
 *
 * Safety invariants:
 * - packs may not write files directly
 * - packs may not chain into other packs
 * - packs with requiresHumanReview=true are never selected for autonomous use
 * - packs respect AutonomyPolicy.hardBlockedSubsystems
 * - packs are limited to scope.maxFiles files per proposal
 */
export interface RecoveryPack {
    packId: RecoveryPackId;
    version: RecoveryPackVersion;
    label: string;
    description: string;
    /** Which GoalSource categories this pack is designed to address. */
    applicableGoalSources: string[];
    applicabilityRules: RecoveryPackApplicabilityRule[];
    scope: RecoveryPackScope;
    actionTemplates: RecoveryPackActionTemplate[];
    verificationTemplates: RecoveryPackVerificationTemplate[];
    rollbackTemplate: RecoveryPackRollbackTemplate;
    confidence: RecoveryPackConfidence;
    /** When false the pack is excluded from all matching. */
    enabled: boolean;
    /**
     * Maximum times this pack may be attempted for the same goalId before
     * the disqualifier triggers. Default: 2.
     */
    maxAttemptsPerGoal: number;
    /**
     * When true the pack is never selected for autonomous execution.
     * May only be used via human-initiated planning.
     */
    requiresHumanReview: boolean;
    /** ISO timestamp when this pack definition was committed to source. */
    committedAt: string;
}

// ─── Match Result ─────────────────────────────────────────────────────────────

export type RecoveryPackMatchStrength = 'no_match' | 'weak_match' | 'strong_match';

/**
 * Result of evaluating one pack candidate against a goal.
 */
export interface RecoveryPackMatch {
    packId: RecoveryPackId;
    packVersion: RecoveryPackVersion;
    matchStrength: RecoveryPackMatchStrength;
    /** Total score from applicable rules. 0–100+. */
    matchScore: number;
    /** Rule IDs that contributed to the match score. */
    matchedRuleIds: string[];
    /** Human-readable explanation of why this pack was or was not selected. */
    rationale: string;
    /** Whether a disqualifying condition blocked this pack. */
    disqualified: boolean;
    /** The reason this pack was disqualified, if applicable. */
    disqualifyingReason?: string;
}

/**
 * Full result of running the RecoveryPackMatcher against a goal.
 *
 * Candidates are ordered by matchScore descending.
 * selectedPackId is null when no pack is suitable (fallbackToStandardPlanning is true).
 */
export interface RecoveryPackMatchResult {
    goalId: string;
    evaluatedAt: string;
    /** All packs evaluated, ordered by matchScore descending. */
    candidates: RecoveryPackMatch[];
    /** The packId selected for use, or null if no pack is suitable. */
    selectedPackId: RecoveryPackId | null;
    selectedMatchStrength: RecoveryPackMatchStrength;
    /**
     * True when no suitable pack was found and standard planning should proceed.
     * Always true when selectedPackId is null.
     */
    fallbackToStandardPlanning: boolean;
    /** Top-level rationale for the selection decision. */
    rationale: string;
}

// ─── Execution Record ─────────────────────────────────────────────────────────

export type RecoveryPackExecutionOutcome =
    | 'succeeded'
    | 'failed'
    | 'rolled_back'
    | 'governance_blocked'
    | 'aborted';

/**
 * Persisted record of one recovery pack execution attempt.
 *
 * Written to disk by RecoveryPackOutcomeTracker after each run completes.
 * Never mutated after creation. Provides full audit trail for pack usage.
 */
export interface RecoveryPackExecutionRecord {
    recordId: string;
    packId: RecoveryPackId;
    packVersion: RecoveryPackVersion;
    goalId: string;
    runId: string;
    startedAt: string;
    completedAt?: string;
    outcome: RecoveryPackExecutionOutcome;
    /** The proposal ID produced from this pack's templates, if any. */
    proposalId?: string;
    /** The execution run ID, if any. */
    executionRunId?: string;
    /** Whether a rollback was triggered. */
    rollbackTriggered: boolean;
    failureReason?: string;
    /** The pack's confidence.current at the moment the pack was used. */
    confidenceAtUse: number;
    /** The pack's confidence.current after outcome-based adjustment. */
    confidenceAfterAdjustment: number;
}

// ─── Outcome Summary ─────────────────────────────────────────────────────────

/**
 * Per-pack aggregate summary derived from all execution records.
 * Used for dashboard display and confidence tracking.
 */
export interface RecoveryPackOutcomeSummary {
    packId: RecoveryPackId;
    packVersion: RecoveryPackVersion;
    label: string;
    currentConfidence: number;
    totalAttempts: number;
    successCount: number;
    failureCount: number;
    rollbackCount: number;
    lastAttemptAt?: string;
    lastOutcome?: RecoveryPackExecutionOutcome;
    enabled: boolean;
}

// ─── Dashboard State ─────────────────────────────────────────────────────────

/**
 * Full recovery pack dashboard state for the Reflection Dashboard integration.
 */
export interface RecoveryPackDashboardState {
    /** All registered packs with their current outcome summaries. */
    registeredPacks: Array<{
        pack: RecoveryPack;
        summary: RecoveryPackOutcomeSummary;
    }>;
    /** Recent execution records, newest first. */
    recentExecutionRecords: RecoveryPackExecutionRecord[];
    /** Whether recovery pack matching is currently active. */
    recoveryPackMatchingEnabled: boolean;
    lastUpdatedAt: string;
}
