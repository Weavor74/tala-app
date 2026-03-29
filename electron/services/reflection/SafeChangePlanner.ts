/**
 * SafeChangePlanner.ts — Phase 2 Main Orchestrator
 *
 * Safe Change Planning Pipeline with strict rate-limit control.
 *
 * Design principle: DETERMINISTIC FIRST. MODEL LAST.
 *
 * Pipeline (strictly linear — no loops, no recursion):
 *
 *   intake → dedup_check → budget_init → snapshot →
 *   blast_radius → verification → rollback_classify →
 *   proposal_generate → proposal_classify → done
 *
 * Each stage runs exactly once.  If a stage fails, the run is marked
 * `failed` and partial results are persisted.
 *
 * Rate-control guarantees:
 *   - One active run per subsystem (active-run lock).
 *   - Identical triggers within 30 min are deduplicated.
 *   - Completed subsystems enter a cooldown window (10–30 min).
 *   - Self-model is queried exactly once per run (snapshot memoisation).
 *   - Model calls are limited by the run budget (default: 1 max).
 *   - Dashboard updates only at defined milestones (max 5 per run).
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    PlanRun,
    PlanRunStatus,
    PlanRunBudget,
    BudgetUsage,
    PlanTriggerInput,
    PlanningRunSnapshot,
    SafeChangeProposal,
    ProposalChange,
    PlanRunMilestone,
    PlanningTriggerResponse,
    PlanPipelineStage,
    PlanningMode,
    BlastRadiusResult,
    VerificationRequirements,
    RollbackClassification,
} from '../../../shared/reflectionPlanTypes';
import { ReflectionBudgetManager } from './ReflectionBudgetManager';
import { PlanRunRegistry } from './PlanRunRegistry';
import { PlanningSnapshotCapture } from './PlanningSnapshot';
import { InvariantImpactEvaluator } from './InvariantImpactEvaluator';
import { VerificationRequirementsEngine } from './VerificationRequirementsEngine';
import { RollbackClassifier } from './RollbackClassifier';
import { PlanningDashboardBridge } from './PlanningDashboardBridge';
import { PlanningTelemetryStore } from './PlanningTelemetryStore';
import type { SelfModelQueryService } from '../selfModel/SelfModelQueryService';
import { telemetry } from '../TelemetryService';

// ─── SafeChangePlanner ────────────────────────────────────────────────────────

export class SafeChangePlanner {
    private readonly budgetManager: ReflectionBudgetManager;
    private readonly registry: PlanRunRegistry;
    private readonly snapshotCapture: PlanningSnapshotCapture;
    private readonly impactEvaluator: InvariantImpactEvaluator;
    private readonly verificationEngine: VerificationRequirementsEngine;
    private readonly rollbackClassifier: RollbackClassifier;
    private readonly dashboardBridge: PlanningDashboardBridge;
    private readonly telemetryStore: PlanningTelemetryStore;

    /** Optional model call hook — injected for standard/deep modes. */
    private modelSynthesisHook?: ModelSynthesisHook;

    constructor(
        private readonly selfModelQuery: SelfModelQueryService,
        dataDir: string,
        modelSynthesisHook?: ModelSynthesisHook,
    ) {
        this.budgetManager = new ReflectionBudgetManager();
        this.registry = new PlanRunRegistry();
        this.snapshotCapture = new PlanningSnapshotCapture();
        this.impactEvaluator = new InvariantImpactEvaluator();
        this.verificationEngine = new VerificationRequirementsEngine();
        this.rollbackClassifier = new RollbackClassifier();
        this.dashboardBridge = new PlanningDashboardBridge();
        this.telemetryStore = new PlanningTelemetryStore(dataDir);
        this.modelSynthesisHook = modelSynthesisHook;

        this.telemetryStore.startAutoFlush();
    }

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Initiates a safe change planning run for the given trigger.
     *
     * Returns immediately with a `PlanningTriggerResponse`.  The actual
     * pipeline runs synchronously within this call — the return value
     * reflects the final outcome.
     *
     * If the trigger is deduplicated or blocked by cooldown, the method
     * returns the relevant status without executing the pipeline.
     */
    async plan(input: PlanTriggerInput): Promise<PlanningTriggerResponse> {
        const mode: PlanningMode = input.planningMode ?? 'standard';

        // ── Stage: intake ──────────────────────────────────────────────────────
        const fingerprint = this.registry.computeFingerprint(input);

        // ── Stage: dedup_check ─────────────────────────────────────────────────
        if (!input.isManual && input.severity !== 'critical') {
            const dedup = this.registry.checkDuplicate(fingerprint);
            if (dedup.isDuplicate) {
                return {
                    runId: dedup.existingRunId!,
                    status: 'deduped',
                    message: `Attached to existing run ${dedup.existingRunId} (${dedup.existingRunStatus})`,
                    attachedToRunId: dedup.existingRunId,
                };
            }

            if (this.registry.isSubsystemLocked(input.subsystemId)) {
                const active = this.registry.getActiveRun(input.subsystemId);
                return {
                    runId: active?.runId ?? 'unknown',
                    status: 'deduped',
                    message: `Subsystem '${input.subsystemId}' already has an active run`,
                    attachedToRunId: active?.runId,
                };
            }

            if (this.registry.isInCooldown(input.subsystemId)) {
                const cooldown = this.registry.getCooldown(input.subsystemId);
                const remainingMs = cooldown ? cooldown.expiresAt - Date.now() : 0;
                const remainingMin = Math.ceil(remainingMs / 60_000);
                return {
                    runId: '',
                    status: 'cooldown_blocked',
                    message: `Subsystem '${input.subsystemId}' is in cooldown for ${remainingMin} more minute(s)`,
                };
            }
        }

        // ── Create run record ──────────────────────────────────────────────────
        const runId = uuidv4();
        const budget = this.budgetManager.createBudget(mode);
        this.budgetManager.initRun(runId);

        const run: PlanRun = {
            runId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            subsystemId: input.subsystemId,
            trigger: fingerprint,
            status: 'running',
            planningMode: mode,
            budget,
            usage: this.budgetManager.getUsage(runId),
            proposals: [],
            milestones: [],
        };

        this.registry.registerRun(run);
        this.registry.lockSubsystem(input.subsystemId, runId);
        this.telemetryStore.record(runId, 'intake', 'snapshot', `Run started for subsystem '${input.subsystemId}'`);

        // ── Stage: budget_init ─────────────────────────────────────────────────
        this._addMilestone(run, 'run_started');
        this.telemetryStore.persistRun(run);
        this._emitDashboard('run_started', run);

        try {
            await this._executePipeline(run, input, budget, mode);
        } catch (err: any) {
            this._failRun(run, err.message ?? String(err));
        } finally {
            this.registry.unlockSubsystem(input.subsystemId);
            this.registry.setCooldown(input.subsystemId, input.severity, `After run ${runId}`);
            this.budgetManager.clearRun(runId);
            this.snapshotCapture.clearRun(runId);
            this.telemetryStore.flush();
        }

        return {
            runId,
            status: run.status,
            message: this._buildResponseMessage(run),
        };
    }

    /** Returns the current state of a run by ID. */
    getRunStatus(runId: string): PlanRun | null {
        return this.registry.getRun(runId) ?? this.telemetryStore.loadRun(runId);
    }

    /** Lists recent runs within the given time window. */
    listRecentRuns(windowMs?: number): PlanRun[] {
        return this.registry.listRecent(windowMs);
    }

    /** Returns all proposals across all recent runs. */
    listProposals(windowMs?: number): SafeChangeProposal[] {
        return this.registry
            .listRecent(windowMs)
            .flatMap(r => r.proposals);
    }

    /** Returns telemetry events for a specific run. */
    getRunTelemetry(runId: string, limit?: number): import('../../../shared/reflectionPlanTypes').PlanningTelemetryEvent[] {
        return this.telemetryStore.getRunEvents(runId, limit);
    }

    /**
     * Promotes a classified proposal to 'promoted' status.
     *
     * Validates that the proposal exists and is currently in 'classified' status.
     * Returns the updated proposal on success, or null if the proposal was not found
     * or was not in a promotable state.
     *
     * This is the authoritative transition point for proposal promotion — it is safe
     * to call governance evaluation immediately after this returns a non-null result.
     */
    promoteProposal(proposalId: string): SafeChangeProposal | null {
        // Search over a 4-hour window — consistent with pruneOldRuns retention
        const runs = this.registry.listRecent(4 * 60 * 60 * 1000);
        for (const run of runs) {
            const idx = run.proposals.findIndex(p => p.proposalId === proposalId);
            if (idx === -1) continue;

            const proposal = run.proposals[idx]!;
            if (proposal.status !== 'classified') return null;

            const promoted: SafeChangeProposal = { ...proposal, status: 'promoted' };
            const updatedProposals = [...run.proposals];
            updatedProposals[idx] = promoted;
            this.registry.updateRun(run.runId, { proposals: updatedProposals });

            this.telemetryStore.record(
                run.runId,
                'done',
                'proposal',
                `Proposal ${proposalId} transitioned to 'promoted'`,
            );

            return promoted;
        }
        return null;
    }

    /** Cleans up old run records from the in-memory registry. */
    pruneOldRuns(): void {
        this.registry.pruneOldRuns();
    }

    /** Tears down the telemetry store flush timer. */
    shutdown(): void {
        this.telemetryStore.stopAutoFlush();
    }

    // ── Pipeline stages (strictly linear) ──────────────────────────────────────

    private async _executePipeline(
        run: PlanRun,
        input: PlanTriggerInput,
        budget: PlanRunBudget,
        mode: PlanningMode,
    ): Promise<void> {

        // ── Stage: snapshot ────────────────────────────────────────────────────
        this._assertBudget(run, budget);
        const selfModelConsumed = this.budgetManager.consume(run.runId, 'selfModelQueriesUsed', budget);
        if (!selfModelConsumed.allowed) {
            throw new Error(`Budget: self-model query blocked — ${selfModelConsumed.blockedBy}`);
        }

        const targetFiles = input.normalizedTarget ? [input.normalizedTarget] : [];
        const snapshot: PlanningRunSnapshot = this.snapshotCapture.captureOnce(
            run.runId,
            input.subsystemId,
            targetFiles,
            this.selfModelQuery,
        );
        run.snapshotId = snapshot.snapshotId;
        this.registry.updateRun(run.runId, { snapshotId: snapshot.snapshotId });
        this._addMilestone(run, 'snapshot_ready');
        this.telemetryStore.persistRun(run);
        this._emitDashboard('snapshot_ready', run);
        this.telemetryStore.record(run.runId, 'snapshot', 'snapshot',
            `Snapshot captured — ${snapshot.invariants.length} invariants, ${snapshot.components.length} components`);

        // ── Stage: blast_radius ────────────────────────────────────────────────
        this._assertBudget(run, budget);
        const analysisConsumed = this.budgetManager.consume(run.runId, 'analysisPassesUsed', budget);
        if (!analysisConsumed.allowed) {
            throw new Error('Budget: analysis pass blocked');
        }

        const blastRadius: BlastRadiusResult = this.snapshotCapture.computeBlastRadius(
            run.runId,
            input.subsystemId,
            targetFiles,
        );
        this.telemetryStore.record(run.runId, 'blast_radius', 'blast_radius',
            `Blast radius: ${blastRadius.affectedSubsystems.length} subsystems, risk=${blastRadius.invariantRisk}`);

        // ── Stage: invariant impact ────────────────────────────────────────────
        const impact = this.impactEvaluator.evaluate(run.runId, snapshot, blastRadius, targetFiles);
        this.telemetryStore.record(run.runId, 'blast_radius', 'blast_radius',
            impact.summary);

        // ── Stage: verification ────────────────────────────────────────────────
        const verification: VerificationRequirements = this.verificationEngine.compute(
            run.runId,
            snapshot,
            blastRadius,
            impact,
            targetFiles,
        );
        this.telemetryStore.record(run.runId, 'verification', 'verification',
            `Verification: build=${verification.requiresBuild}, tests=${verification.requiredTests.length}, manual=${verification.manualReviewRequired}`);

        // ── Stage: rollback_classify ───────────────────────────────────────────
        const draftChanges = this._buildDraftChanges(input, blastRadius);
        const rollback: RollbackClassification = this.rollbackClassifier.classify(
            run.runId,
            draftChanges,
            blastRadius,
            impact,
            verification,
        );
        this.telemetryStore.record(run.runId, 'rollback_classify', 'rollback',
            `Rollback: strategy=${rollback.strategy}, safety=${rollback.safetyClass}`);

        // ── Stage: proposal_generate ───────────────────────────────────────────
        const proposal = await this._generateProposal(
            run,
            input,
            snapshot,
            blastRadius,
            verification,
            rollback,
            draftChanges,
            budget,
            mode,
        );

        run.proposals.push(proposal);
        this.registry.updateRun(run.runId, { proposals: run.proposals });
        this._addMilestone(run, 'proposal_created');
        this.telemetryStore.persistRun(run);
        this._emitDashboard('proposal_created', run);
        this.telemetryStore.record(run.runId, 'proposal_generate', 'proposal',
            `Proposal created: ${proposal.proposalId} (modelAssisted=${proposal.modelAssisted})`);

        // ── Stage: proposal_classify ───────────────────────────────────────────
        proposal.status = 'classified';
        proposal.promotionEligible = rollback.safetyClass === 'safe_auto';
        this.registry.updateRun(run.runId, { proposals: run.proposals });
        this._addMilestone(run, 'proposal_classified');
        this.telemetryStore.persistRun(run);
        this._emitDashboard('proposal_classified', run);

        // ── Stage: done ────────────────────────────────────────────────────────
        run.status = 'completed';
        this.registry.updateRun(run.runId, { status: 'completed' });
        this._addMilestone(run, 'run_complete');
        this.telemetryStore.persistRun(run);
        this._emitDashboard('run_complete', run);
        this.telemetryStore.record(run.runId, 'done', 'proposal',
            `Run completed — ${run.proposals.length} proposal(s) generated`);
    }

    // ── Proposal generation ─────────────────────────────────────────────────────

    private async _generateProposal(
        run: PlanRun,
        input: PlanTriggerInput,
        snapshot: PlanningRunSnapshot,
        blastRadius: BlastRadiusResult,
        verification: VerificationRequirements,
        rollback: RollbackClassification,
        draftChanges: ProposalChange[],
        budget: PlanRunBudget,
        mode: PlanningMode,
    ): Promise<SafeChangeProposal> {
        let reasoning = this._buildDeterministicReasoning(input, blastRadius, rollback);
        let modelAssisted = false;

        // Optional model synthesis call — only in standard/deep modes and if budget allows
        if (mode !== 'light' && this.modelSynthesisHook) {
            const modelBudget = this.budgetManager.consume(run.runId, 'modelCallsUsed', budget);
            if (modelBudget.allowed) {
                try {
                    const synthesised = await this.modelSynthesisHook({
                        subsystemId: input.subsystemId,
                        issueType: input.issueType,
                        description: input.description ?? '',
                        blastRadius,
                        reasoning,
                    });
                    if (synthesised) {
                        reasoning = synthesised;
                        modelAssisted = true;
                    }
                } catch (err: any) {
                    telemetry.operational(
                        'planning',
                        'planning.model_synthesis.failed',
                        'warn',
                        'SafeChangePlanner',
                        `Model synthesis failed for run ${run.runId}: ${err.message}`,
                    );
                }
            }
        }

        const riskScore = this._computeRiskScore(blastRadius, rollback);

        return {
            proposalId: uuidv4(),
            runId: run.runId,
            createdAt: new Date().toISOString(),
            title: this._buildTitle(input),
            description: input.description ?? `Address ${input.issueType} in ${input.subsystemId}`,
            planningMode: run.planningMode,
            targetSubsystem: input.subsystemId,
            targetFiles: draftChanges.map(c => c.path),
            changes: draftChanges,
            blastRadius,
            verificationRequirements: verification,
            rollbackClassification: rollback,
            status: 'draft',
            riskScore,
            promotionEligible: false, // set during classify stage
            reasoning,
            modelAssisted,
        };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Builds a minimal set of draft changes from the trigger input.
     * In a full implementation, these would be derived from the issue analysis.
     * The draft is a placeholder that downstream stages can refine.
     */
    private _buildDraftChanges(
        input: PlanTriggerInput,
        blastRadius: BlastRadiusResult,
    ): ProposalChange[] {
        if (!input.normalizedTarget) return [];
        return [{
            type: 'patch',
            path: input.normalizedTarget,
            reasoning: `Address ${input.issueType} in ${input.subsystemId}`,
        }];
    }

    private _buildDeterministicReasoning(
        input: PlanTriggerInput,
        blast: BlastRadiusResult,
        rollback: RollbackClassification,
    ): string {
        return [
            `Issue type: ${input.issueType}.`,
            `Subsystem: ${input.subsystemId}.`,
            `Blast radius: ${blast.affectedSubsystems.length} subsystem(s), risk=${blast.invariantRisk}.`,
            `Safety class: ${rollback.safetyClass}.`,
            rollback.classificationReasoning,
        ].join(' ');
    }

    private _buildTitle(input: PlanTriggerInput): string {
        return `[${input.severity.toUpperCase()}] ${input.issueType} in ${input.subsystemId}`;
    }

    private _computeRiskScore(
        blast: BlastRadiusResult,
        rollback: RollbackClassification,
    ): number {
        const riskTierScore: Record<BlastRadiusResult['invariantRisk'], number> = {
            none: 0, low: 20, medium: 40, high: 70, critical: 90,
        };
        const safetyScore: Record<typeof rollback.safetyClass, number> = {
            safe_auto: 0, safe_with_review: 15, high_risk: 25, blocked: 40,
        };
        return Math.min(
            100,
            riskTierScore[blast.invariantRisk] +
            safetyScore[rollback.safetyClass] +
            Math.min(blast.estimatedImpactScore / 10, 10),
        );
    }

    private _assertBudget(run: PlanRun, budget: PlanRunBudget): void {
        if (this.budgetManager.isExhausted(run.runId, budget)) {
            const usage = this.budgetManager.getUsage(run.runId);
            run.usage = usage;
            run.status = 'budget_exhausted';
            run.failureReason = 'Budget exhausted before pipeline completion';
            this.registry.updateRun(run.runId, { status: 'budget_exhausted', failureReason: run.failureReason, usage });
            this._addMilestone(run, 'run_failed', 'budget_exhausted');
            this.telemetryStore.persistRun(run);
            this._emitDashboard('run_failed', run);
            throw new Error(run.failureReason);
        }
    }

    private _failRun(run: PlanRun, reason: string): void {
        if (run.status === 'budget_exhausted') return; // already handled
        run.status = 'failed';
        run.failureReason = reason;
        this.registry.updateRun(run.runId, { status: 'failed', failureReason: reason });
        this._addMilestone(run, 'run_failed', reason);
        this.telemetryStore.persistRun(run);
        this._emitDashboard('run_failed', run);
    }

    private _addMilestone(run: PlanRun, name: PlanRunMilestone['name'], notes?: string): void {
        const milestone: PlanRunMilestone = {
            name,
            timestamp: new Date().toISOString(),
            notes,
        };
        run.milestones.push(milestone);
        this.registry.updateRun(run.runId, { milestones: run.milestones });
    }

    private _emitDashboard(milestone: PlanRunMilestone['name'], run: PlanRun): void {
        const usage = this.budgetManager.getUsage(run.runId);
        this.dashboardBridge.maybeEmit(
            milestone,
            run,
            this.registry.listRecent(),
            run.proposals,
            usage.dashboardUpdatesUsed,
            run.budget.maxDashboardUpdates,
        );
        // Manually increment dashboard usage counter after emit
        this.budgetManager.consume(run.runId, 'dashboardUpdatesUsed', run.budget);
    }

    private _buildResponseMessage(run: PlanRun): string {
        switch (run.status) {
            case 'completed':
                return `Planning complete — ${run.proposals.length} proposal(s) generated`;
            case 'budget_exhausted':
                return `Budget exhausted — partial results persisted (runId: ${run.runId})`;
            case 'failed':
                return `Planning failed: ${run.failureReason ?? 'unknown error'}`;
            default:
                return `Run ${run.runId}: ${run.status}`;
        }
    }
}

// ─── Model synthesis hook type ────────────────────────────────────────────────

/**
 * Optional async hook that performs a single LLM synthesis call.
 * Injected at construction time so the planner is testable without a model.
 */
export type ModelSynthesisHook = (context: {
    subsystemId: string;
    issueType: string;
    description: string;
    blastRadius: BlastRadiusResult;
    reasoning: string;
}) => Promise<string | null>;
