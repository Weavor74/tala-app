/**
 * reflectionTypes.ts — Phase 2 Canonical Type Vocabulary
 *
 * P2A: Change Proposal Types & Contracts
 *
 * This file defines the canonical, semantic type names for the Phase 2
 * Safe Change Planning system.  These types form the public API surface
 * that all consumer services, UI components, and IPC handlers should
 * import from when working with the reflection planning pipeline.
 *
 * Relationship to reflectionPlanTypes.ts
 * --------------------------------------
 * reflectionPlanTypes.ts is the detailed implementation contract used
 * internally by the planning engine.  This file provides canonical,
 * human-facing names that are more broadly usable and stable across
 * refactors of the internal engine.
 *
 * Design principle: DETERMINISTIC FIRST. MODEL LAST.
 */

// ─── Re-exports from implementation contract ──────────────────────────────────

export type {
    PlanningMode,
    PlanRunStatus,
    PlanRunBudget,
    BudgetUsage,
    BudgetCheckResult,
    PlanTriggerInput,
    TriggerFingerprint,
    DedupCheckResult,
    SubsystemCooldownState,
    PlanRun,
    PlanPipelineStage,
    PlanRunMilestone,
    ProposalChange,
    PlanningTriggerResponse,
} from './reflectionPlanTypes';

// ─── ProposalStatus ───────────────────────────────────────────────────────────

/**
 * The lifecycle status of a single change proposal.
 *
 * draft          — generated but not yet evaluated by the classifier.
 * classified     — blast radius + safety tier assigned, awaiting decision.
 * approved       — human or auto-approved; eligible for promotion.
 * rejected       — explicitly rejected; not promoted.
 * promoted       — applied to the live codebase.
 * rolled_back    — promotion was reversed.
 * deferred       — postponed; may be revisited in a future run.
 */
export type ProposalStatus =
    | 'draft'
    | 'classified'
    | 'approved'
    | 'rejected'
    | 'promoted'
    | 'rolled_back'
    | 'deferred';

// ─── ProposalRiskLevel ────────────────────────────────────────────────────────

/**
 * A consolidated risk level for a proposal, combining blast-radius
 * invariant risk with the rollback safety class.
 *
 * safe      — safe_auto safety class, no threatened invariants.
 * low       — safe_with_review; minor blast radius.
 * medium    — safe_with_review; moderate blast radius or threatened invariants.
 * high      — high_risk safety class or blocking invariants present.
 * critical  — blocked; involves safety/identity invariants or deletes.
 */
export type ProposalRiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

// ─── ProposalOrigin ───────────────────────────────────────────────────────────

/**
 * How a change proposal was triggered.
 *
 * auto       — triggered automatically by the reflection engine.
 * scheduled  — triggered by the scheduler (periodic scan / audit).
 * manual     — explicitly requested by a user or operator.
 * goal       — derived from a SelfImprovementGoal in the queue.
 * autonomous — triggered by the Phase 4 AutonomousRunOrchestrator.
 */
export type ProposalOrigin = 'auto' | 'scheduled' | 'manual' | 'goal' | 'autonomous';

// ─── ChangeProposal ───────────────────────────────────────────────────────────

/**
 * A structured change proposal produced by the safe-change planning pipeline.
 *
 * This is the canonical consumer-facing form.  It includes everything needed
 * for display, promotion, verification, and rollback without re-analysis.
 */
export interface ChangeProposal {
    /** Unique identifier for this proposal. */
    proposalId: string;
    /** The planning run that produced this proposal. */
    runId: string;
    /** ISO timestamp when the proposal was created. */
    createdAt: string;
    /** Short human-readable title. */
    title: string;
    /** Full description of what is proposed and why. */
    description: string;
    /** How the planning run was initiated. */
    origin: ProposalOrigin;
    /** Which planning mode produced this proposal. */
    planningMode: import('./reflectionPlanTypes').PlanningMode;
    /** The primary subsystem this proposal targets. */
    targetSubsystem: string;
    /** Files this proposal intends to modify. */
    targetFiles: string[];
    /** The concrete file-level changes. */
    changes: import('./reflectionPlanTypes').ProposalChange[];
    /** Normalised 0–100 risk score. */
    riskScore: number;
    /** Consolidated risk level derived from blast radius + safety class. */
    riskLevel: ProposalRiskLevel;
    /** Current lifecycle status. */
    status: ProposalStatus;
    /** Whether the proposal may be auto-promoted without human review. */
    promotionEligible: boolean;
    /** Human-readable reasoning for the proposal. */
    reasoning: string;
    /** Whether a model call contributed to the reasoning. */
    modelAssisted: boolean;
    /** Full blast radius assessment (from the planning engine). */
    blastRadius: import('./reflectionPlanTypes').BlastRadiusResult;
    /** Verification steps required before promotion. */
    verificationRequirements: import('./reflectionPlanTypes').VerificationRequirements;
    /** Rollback strategy and safety classification. */
    rollbackPlan: RollbackPlan;
}

// ─── ReflectionRun ────────────────────────────────────────────────────────────

/**
 * The canonical record of a single safe-change planning run.
 *
 * Extends PlanRun with the consumer-facing ChangeProposal type.
 */
export interface ReflectionRun {
    runId: string;
    createdAt: string;
    updatedAt: string;
    /** Subsystem that initiated this run. */
    subsystemId: string;
    /** Normalised trigger fingerprint. */
    trigger: import('./reflectionPlanTypes').TriggerFingerprint;
    /** Lifecycle status. */
    status: import('./reflectionPlanTypes').PlanRunStatus;
    /** Planning mode used. */
    planningMode: import('./reflectionPlanTypes').PlanningMode;
    /** Budget limits for this run. */
    budget: ReflectionBudget;
    /** Actual resource consumption. */
    usage: import('./reflectionPlanTypes').BudgetUsage;
    /** ID of the snapshot captured at run start. */
    snapshotId?: string;
    /** Proposals produced by this run. */
    proposals: ChangeProposal[];
    /** Reason this run was stopped, if status is 'failed' or 'budget_exhausted'. */
    failureReason?: string;
    /** Ordered list of milestones reached during this run. */
    milestones: import('./reflectionPlanTypes').PlanRunMilestone[];
}

// ─── ReflectionBudget ─────────────────────────────────────────────────────────

/**
 * Hard per-run resource limits.
 *
 * Canonical alias for PlanRunBudget with documentation.
 *
 * - maxModelCalls:       0 (light) | 1 (standard) | 2 (deep)
 * - maxSelfModelQueries: 4 / 6 / 8
 * - maxAnalysisPasses:   1 / 1 / 2
 * - maxRetriesPerStage:  0 / 1 / 1
 * - maxDashboardUpdates: 5 (all modes — one per milestone)
 */
export interface ReflectionBudget {
    maxModelCalls: number;
    maxSelfModelQueries: number;
    maxAnalysisPasses: number;
    maxRetriesPerStage: number;
    maxDashboardUpdates: number;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * Immutable snapshot of self-model data captured once at run start.
 *
 * All pipeline stages MUST read from this snapshot; no service may
 * re-query the self-model independently during a run.
 */
export interface Snapshot {
    snapshotId: string;
    runId: string;
    capturedAt: string;
    /** Subsystem ownership records from the self-model. */
    subsystemOwnership: import('./reflectionPlanTypes').SubsystemOwnershipRecord[];
    /** Active invariants at the time of capture. */
    invariants: import('./selfModelTypes').SelfModelInvariant[];
    /** Capability list at the time of capture. */
    capabilities: import('./selfModelTypes').SelfModelCapability[];
    /** Component inventory at the time of capture. */
    components: import('./selfModelTypes').SelfModelComponent[];
    /** Initial blast radius computed from snapshot data. */
    blastRadiusInitial: import('./reflectionPlanTypes').BlastRadiusResult;
    /** Test inventory derived from the component list. */
    tests: import('./reflectionPlanTypes').TestInventory;
}

// ─── VerificationRequirement ──────────────────────────────────────────────────

/**
 * A single mandatory verification step that must pass before a proposal
 * can be promoted.
 *
 * This is the itemised form of VerificationRequirements; the engine
 * produces a VerificationRequirements aggregate and the runner
 * expands it into individual VerificationRequirement items.
 */
export interface VerificationRequirement {
    /** Unique key for this requirement within the run. */
    requirementId: string;
    /** Category of the check. */
    kind: 'build' | 'typecheck' | 'lint' | 'test' | 'smoke';
    /** Human-readable description of what must pass. */
    description: string;
    /**
     * Command or test path to execute.
     * May be a glob pattern for test requirements.
     */
    target: string;
    /** Whether this requirement blocks promotion if it fails. */
    isBlocking: boolean;
    /** Estimated duration in milliseconds. */
    estimatedMs: number;
}

// ─── RollbackPlan ─────────────────────────────────────────────────────────────

/**
 * Rollback strategy and ordered steps for a change proposal.
 *
 * Canonical consumer-facing form of RollbackClassification.
 */
export interface RollbackPlan {
    /**
     * The mechanism used to undo this change.
     *
     * file_restore       — restore individual files from pre-change backup.
     * git_revert         — git revert the promotion commit.
     * config_rollback    — restore configuration keys.
     * no_rollback_needed — additive-only change; no undo required.
     * manual_only        — human must perform rollback; no automated path.
     */
    strategy: import('./reflectionPlanTypes').RollbackStrategy;
    /**
     * Promotion safety tier.
     *
     * safe_auto        — auto-promotable.
     * safe_with_review — allowed after human review.
     * high_risk        — requires explicit approval.
     * blocked          — must not be auto-promoted.
     */
    safetyClass: import('./reflectionPlanTypes').SafetyClass;
    /** Ordered human-readable rollback steps. */
    steps: string[];
    /** Whether human approval is required before promotion. */
    requiresApproval: boolean;
    /** Estimated rollback duration in milliseconds. */
    estimatedRollbackMs: number;
    /** Reasoning that determined the safety class. */
    reasoning: string;
}

// ─── PromotionDecision ────────────────────────────────────────────────────────

/**
 * The outcome of a promotion attempt for a proposal.
 */
export interface PromotionDecision {
    proposalId: string;
    runId: string;
    decidedAt: string;
    /** The decision taken. */
    decision: 'promoted' | 'rejected' | 'deferred' | 'failed';
    /** Human-readable reason. */
    reason: string;
    /** Whether all required verifications passed. */
    verificationPassed: boolean;
    /**
     * Pointer to the pre-change backup used for rollback.
     * Only set when decision === 'promoted'.
     */
    rollbackPointer?: string;
    /** Whether this promotion was performed automatically. */
    wasAutomatic: boolean;
}

// ─── PipelineStateSnapshot ────────────────────────────────────────────────────

/**
 * A point-in-time snapshot of the planning pipeline state for dashboard display.
 *
 * Emitted only at milestone boundaries — never on internal pipeline steps.
 */
export interface PipelineStateSnapshot {
    /** Whether a planning run is currently executing. */
    isActive: boolean;
    /** The currently-executing run, if any. */
    currentRunId?: string;
    /** The pipeline stage currently executing. */
    currentStage?: import('./reflectionPlanTypes').PlanPipelineStage;
    /** The subsystem being planned for. */
    currentSubsystem?: string;
    /** ISO timestamp of when the current run started. */
    startedAt?: string;
    /** Elapsed time since run start (ms). */
    elapsedMs?: number;
    /** The most recent milestone reached. */
    lastMilestone?: string;
    /** ISO timestamp of the most recent milestone. */
    lastMilestoneAt?: string;
    /** Number of proposals in 'draft' or 'classified' status. */
    pendingProposals: number;
    /**
     * Summary of recent runs for dashboard list display.
     * Includes at most 10 most recent runs.
     */
    recentRuns: Array<{
        runId: string;
        status: import('./reflectionPlanTypes').PlanRunStatus;
        subsystemId: string;
        completedAt?: string;
    }>;
    /** KPI counters for the dashboard tiles. */
    kpis: {
        totalRuns: number;
        totalProposals: number;
        promotedProposals: number;
        successRate: number;
        activeRuns: number;
        proposalsReady: number;
        budgetExhaustedRuns: number;
        dedupedRuns: number;
        cooldownBlockedRuns: number;
    };
}

// ─── TelemetryEvent ───────────────────────────────────────────────────────────

/**
 * A single structured telemetry event emitted by the planning pipeline.
 *
 * Events are batched and flushed periodically; they are not sent to the
 * renderer individually.
 */
export interface TelemetryEvent {
    /** Unique identifier for this event. */
    eventId: string;
    /** The planning run this event belongs to. */
    runId: string;
    /** ISO timestamp. */
    timestamp: string;
    /** Pipeline stage that produced this event. */
    stage: import('./reflectionPlanTypes').PlanPipelineStage | 'system';
    /**
     * Event category for structured filtering.
     *
     * budget      — resource consumption and exhaustion.
     * dedup       — deduplication and cooldown decisions.
     * snapshot    — self-model capture events.
     * blast_radius — blast radius computation results.
     * verification — verification requirement decisions.
     * rollback    — rollback strategy decisions.
     * proposal    — proposal creation and classification.
     * promotion   — promotion decisions.
     * dashboard   — dashboard update events.
     * error       — unexpected errors.
     */
    category:
        | 'budget'
        | 'dedup'
        | 'snapshot'
        | 'blast_radius'
        | 'verification'
        | 'rollback'
        | 'proposal'
        | 'promotion'
        | 'dashboard'
        | 'error';
    /** Human-readable description of the event. */
    message: string;
    /** Optional structured data. */
    data?: Record<string, unknown>;
}

// ─── TriggerIntakeResult ──────────────────────────────────────────────────────

/**
 * The result returned by ReflectionTriggerService.intake().
 *
 * Carries the full gate-check outcome and, when a run is created,
 * the run ID to track.
 */
export interface TriggerIntakeResult {
    /** Whether a new run was created (true) or the trigger was suppressed. */
    accepted: boolean;
    /** The planning run ID — new if accepted, existing if deduped. */
    runId: string;
    /** Final disposition of this trigger. */
    status: import('./reflectionPlanTypes').PlanRunStatus | 'accepted';
    /** Human-readable explanation of the decision. */
    message: string;
    /**
     * If deduped, the ID of the run this trigger was attached to.
     * If cooldown_blocked, undefined.
     */
    attachedToRunId?: string;
}

// ─── Convenience helpers ──────────────────────────────────────────────────────

/**
 * Maps a SafetyClass to a ProposalRiskLevel.
 *
 * Used by consumer code to display a single risk indicator without
 * having to reason about both blast radius risk and safety class separately.
 */
export function toProposalRiskLevel(
    invariantRisk: import('./reflectionPlanTypes').BlastRadiusResult['invariantRisk'],
    safetyClass: import('./reflectionPlanTypes').SafetyClass,
): ProposalRiskLevel {
    if (safetyClass === 'blocked') return 'critical';
    if (safetyClass === 'high_risk') return 'high';
    if (invariantRisk === 'high' || invariantRisk === 'critical') return 'high';
    if (safetyClass === 'safe_with_review' || invariantRisk === 'medium') return 'medium';
    if (invariantRisk === 'low') return 'low';
    return 'safe';
}

/**
 * Converts a SafeChangeProposal (internal engine type) to a ChangeProposal
 * (canonical consumer type).
 */
export function toChangeProposal(
    internal: import('./reflectionPlanTypes').SafeChangeProposal,
    origin: ProposalOrigin = 'auto',
): ChangeProposal {
    const { rollbackClassification, ...rest } = internal;
    return {
        proposalId: internal.proposalId,
        runId: internal.runId,
        createdAt: internal.createdAt,
        title: internal.title,
        description: internal.description,
        origin,
        planningMode: internal.planningMode,
        targetSubsystem: internal.targetSubsystem,
        targetFiles: internal.targetFiles,
        changes: internal.changes,
        riskScore: internal.riskScore,
        riskLevel: toProposalRiskLevel(
            internal.blastRadius.invariantRisk,
            rollbackClassification.safetyClass,
        ),
        status: internal.status as ProposalStatus,
        promotionEligible: internal.promotionEligible,
        reasoning: internal.reasoning,
        modelAssisted: internal.modelAssisted,
        blastRadius: internal.blastRadius,
        verificationRequirements: internal.verificationRequirements,
        rollbackPlan: {
            strategy: rollbackClassification.strategy,
            safetyClass: rollbackClassification.safetyClass,
            steps: rollbackClassification.rollbackSteps,
            requiresApproval: rollbackClassification.requiresApproval,
            estimatedRollbackMs: rollbackClassification.estimatedRollbackMs,
            reasoning: rollbackClassification.classificationReasoning,
        },
    };
}

/**
 * Expands a VerificationRequirements aggregate into individual
 * VerificationRequirement items for step-by-step runner display.
 */
export function expandVerificationRequirements(
    req: import('./reflectionPlanTypes').VerificationRequirements,
    runId: string,
): VerificationRequirement[] {
    const items: VerificationRequirement[] = [];
    let idx = 0;

    const id = () => `${runId}-vr-${idx++}`;

    if (req.requiresBuild) {
        items.push({ requirementId: id(), kind: 'build', description: 'Project must build successfully', target: 'npm run build', isBlocking: true, estimatedMs: 60_000 });
    }
    if (req.requiresTypecheck) {
        items.push({ requirementId: id(), kind: 'typecheck', description: 'TypeScript must type-check cleanly', target: 'npm run typecheck', isBlocking: true, estimatedMs: 30_000 });
    }
    if (req.requiresLint) {
        items.push({ requirementId: id(), kind: 'lint', description: 'Lint must pass', target: 'npm run lint', isBlocking: false, estimatedMs: 10_000 });
    }
    for (const t of req.requiredTests) {
        items.push({ requirementId: id(), kind: 'test', description: `Test must pass: ${t}`, target: t, isBlocking: true, estimatedMs: 10_000 });
    }
    for (const s of req.smokeChecks) {
        items.push({ requirementId: id(), kind: 'smoke', description: `Smoke check: ${s}`, target: s, isBlocking: true, estimatedMs: 15_000 });
    }

    return items;
}
