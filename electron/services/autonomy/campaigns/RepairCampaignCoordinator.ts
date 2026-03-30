/**
 * RepairCampaignCoordinator.ts — Phase 5.5 P5.5F
 *
 * Campaign Execution Coordinator.
 *
 * Responsibilities:
 * - Execute exactly one campaign step at a time through the existing
 *   planning → governance → execution pipeline.
 * - Persist campaign state after every state transition.
 * - Call CampaignCheckpointEngine after each step completes.
 * - Call CampaignReassessmentEngine after each checkpoint.
 * - Advance only when the reassessment decision is 'continue' or 'skip_step'.
 * - Stop immediately on any other decision.
 * - Enforce all safety bounds via CampaignSafetyGuard.
 * - Support resume after process restart.
 *
 * Architecture:
 *   advanceCampaign()
 *     → safetyGuard.checkBounds()
 *     → stepRegistry.getNextPendingStep()
 *     → [no next step] → _completeCampaign()
 *     → stepRegistry.markRunning()
 *     → _executeStep() (calls the execution callback)
 *     → stepRegistry.markAwaitingVerification()
 *     → checkpointEngine.evaluate()
 *     → stepRegistry.markPassed() or markFailed() or markRolledBack()
 *     → campaign.reassessmentCount++
 *     → reassessmentEngine.decide()
 *     → _applyDecision()
 *     → registry.save() (after every transition)
 *     → dashboardBridge.maybeEmit()
 *
 * Campaign execution callbacks (injectable):
 *   executeStep — calls the caller-supplied execution pipeline for a step.
 *                 The coordinator does NOT call SafeChangePlanner directly;
 *                 the callback is supplied by AutonomousRunOrchestrator.
 *
 * This preserves the invariant that all step executions go through the
 * same planning → governance → execution gates as a normal autonomous run.
 */

import type {
    RepairCampaign,
    RepairCampaignId,
    RepairCampaignStatus,
    CampaignStep,
} from '../../../../shared/repairCampaignTypes';
import { RepairCampaignRegistry } from './RepairCampaignRegistry';
import { CampaignStepRegistry } from './CampaignStepRegistry';
import { CampaignCheckpointEngine } from './CampaignCheckpointEngine';
import type { CampaignStepExecutionResult } from './CampaignCheckpointEngine';
import { CampaignReassessmentEngine } from './CampaignReassessmentEngine';
import { CampaignOutcomeTracker } from './CampaignOutcomeTracker';
import { CampaignSafetyGuard } from './CampaignSafetyGuard';
import { CampaignDashboardBridge } from './CampaignDashboardBridge';
import { telemetry } from '../../TelemetryService';

// ─── Step execution callback ──────────────────────────────────────────────────

/**
 * Callback supplied by AutonomousRunOrchestrator to execute one campaign step
 * through the existing planning → governance → execution pipeline.
 *
 * The coordinator never calls SafeChangePlanner / GovernanceAppService /
 * ExecutionOrchestrator directly. It delegates entirely to this callback,
 * preserving all safety gates.
 *
 * Returns a CampaignStepExecutionResult (or throws on unrecoverable error).
 */
export type CampaignStepExecutor = (
    step: CampaignStep,
    campaign: RepairCampaign,
) => Promise<CampaignStepExecutionResult>;

// ─── RepairCampaignCoordinator ────────────────────────────────────────────────

export class RepairCampaignCoordinator {
    private readonly checkpointEngine = new CampaignCheckpointEngine();
    private readonly reassessmentEngine = new CampaignReassessmentEngine();
    /** Guards against re-entrant advanceCampaign calls for the same campaign. */
    private readonly inProgressCampaigns = new Set<RepairCampaignId>();

    constructor(
        private readonly registry: RepairCampaignRegistry,
        private readonly outcomeTracker: CampaignOutcomeTracker,
        private readonly safetyGuard: CampaignSafetyGuard,
        private readonly dashboardBridge: CampaignDashboardBridge,
        private readonly stepExecutor: CampaignStepExecutor,
    ) {}

    // ── Campaign lifecycle ──────────────────────────────────────────────────────

    /**
     * Activates a campaign that is currently in 'draft' status.
     * Persists the transition and emits a dashboard update.
     */
    activateCampaign(campaignId: RepairCampaignId): RepairCampaign | null {
        const campaign = this.registry.getById(campaignId);
        if (!campaign) {
            telemetry.operational('autonomy', 'operational', 'warn', 'RepairCampaignCoordinator',
                `activateCampaign: campaign ${campaignId} not found`);
            return null;
        }
        if (campaign.status !== 'draft') {
            telemetry.operational('autonomy', 'operational', 'warn', 'RepairCampaignCoordinator',
                `activateCampaign: campaign ${campaignId} is not in draft (current: ${campaign.status})`);
            return null;
        }

        campaign.status = 'active';
        this.registry.save(campaign);
        this.dashboardBridge.emit(this._buildDashboardPayload());
        return campaign;
    }

    /**
     * Advances an active campaign by executing its next pending step.
     *
     * This is the core loop method. It executes exactly ONE step per call
     * and persists state after every transition. The caller is responsible
     * for calling advanceCampaign() again if the decision is 'continue'.
     *
     * Returns the campaign in its final state after this call.
     * Returns null when the campaign is not found.
     */
    async advanceCampaign(campaignId: RepairCampaignId): Promise<RepairCampaign | null> {
        // Re-entrant guard
        if (this.inProgressCampaigns.has(campaignId)) {
            telemetry.operational('autonomy', 'operational', 'warn', 'RepairCampaignCoordinator',
                `advanceCampaign: re-entrant call for campaign ${campaignId} suppressed`);
            return null;
        }

        const campaign = this.registry.getById(campaignId);
        if (!campaign) return null;

        this.inProgressCampaigns.add(campaignId);
        try {
            return await this._advance(campaign);
        } finally {
            this.inProgressCampaigns.delete(campaignId);
        }
    }

    /**
     * Defers a campaign (operator action or reassessment decision).
     * Allowed from any non-terminal status.
     */
    deferCampaign(campaignId: RepairCampaignId, reason?: string): boolean {
        const campaign = this.registry.getById(campaignId);
        if (!campaign) return false;
        if (['succeeded', 'failed', 'rolled_back', 'aborted', 'expired'].includes(campaign.status)) return false;
        campaign.status = 'deferred';
        campaign.haltReason = reason ?? 'Deferred by operator';
        this.registry.save(campaign);
        this.dashboardBridge.emit(this._buildDashboardPayload());
        telemetry.operational('autonomy', 'campaign_deferred', 'info', 'RepairCampaignCoordinator',
            `Campaign ${campaignId} deferred: ${campaign.haltReason}`);
        return true;
    }

    /**
     * Aborts a campaign (operator action).
     */
    abortCampaign(campaignId: RepairCampaignId, reason?: string): boolean {
        const campaign = this.registry.getById(campaignId);
        if (!campaign) return false;
        if (['succeeded', 'failed', 'rolled_back', 'aborted', 'expired'].includes(campaign.status)) return false;
        campaign.status = 'aborted';
        campaign.haltReason = reason ?? 'Aborted by operator';
        this.registry.save(campaign);
        this.safetyGuard.applyCooldown(campaign, 'failure');
        this.outcomeTracker.record(campaign);
        this.dashboardBridge.emit(this._buildDashboardPayload());
        telemetry.operational('autonomy', 'campaign_aborted', 'warn', 'RepairCampaignCoordinator',
            `Campaign ${campaignId} aborted: ${campaign.haltReason}`);
        return true;
    }

    /**
     * Resumes a deferred campaign.
     * Checks safety bounds before reactivation.
     */
    resumeCampaign(campaignId: RepairCampaignId): boolean {
        const campaign = this.registry.getById(campaignId);
        if (!campaign) return false;
        if (campaign.status !== 'deferred' && campaign.status !== 'paused') return false;

        const violation = this.safetyGuard.checkBounds(campaign);
        if (violation) {
            telemetry.operational('autonomy', 'campaign_safety_bound_triggered', 'warn', 'RepairCampaignCoordinator',
                `Cannot resume campaign ${campaignId}: ${violation.detail}`);
            return false;
        }

        campaign.status = 'active';
        campaign.haltReason = undefined;
        this.registry.save(campaign);
        this.dashboardBridge.emit(this._buildDashboardPayload());
        telemetry.operational('autonomy', 'campaign_resumed', 'info', 'RepairCampaignCoordinator',
            `Campaign ${campaignId} resumed`);
        return true;
    }

    // ── Dashboard state ─────────────────────────────────────────────────────────

    getDashboardState() {
        return this.dashboardBridge.buildState(
            this.registry.getActiveCampaigns(),
            this.registry.getDeferredCampaigns(),
            this.outcomeTracker.listOutcomes(),
        );
    }

    // ── Private core ────────────────────────────────────────────────────────────

    private async _advance(campaign: RepairCampaign): Promise<RepairCampaign> {
        // ── Safety bounds check ────────────────────────────────────────────────
        const violation = this.safetyGuard.checkBounds(campaign);
        if (violation) {
            campaign.status = violation.kind === 'CAMPAIGN_EXPIRED' ? 'expired' : 'aborted';
            campaign.haltReason = violation.detail;
            this.registry.save(campaign);
            if (campaign.status !== 'expired') {
                this.safetyGuard.applyCooldown(campaign, 'failure');
            }
            this.outcomeTracker.record(campaign);
            this.dashboardBridge.emit(this._buildDashboardPayload());
            return campaign;
        }

        // ── Ensure campaign is active ──────────────────────────────────────────
        if (campaign.status === 'draft') campaign.status = 'active';
        if (!['active', 'awaiting_checkpoint', 'awaiting_reassessment'].includes(campaign.status)) {
            return campaign;
        }

        const stepRegistry = new CampaignStepRegistry(campaign.steps);
        const nextStep = stepRegistry.getNextPendingStep();

        // ── No more steps → campaign complete ─────────────────────────────────
        if (!nextStep) {
            return this._completeCampaign(campaign);
        }

        // ── Mark step running + persist ────────────────────────────────────────
        try {
            stepRegistry.markRunning(nextStep.stepId);
        } catch (err: any) {
            // Prerequisite not met — should not happen if coordinator is called correctly
            telemetry.operational('autonomy', 'operational', 'warn', 'RepairCampaignCoordinator',
                `Cannot advance step ${nextStep.stepId}: ${err.message}`);
            return campaign;
        }
        campaign.status = 'step_in_progress';
        this.registry.save(campaign);
        this.dashboardBridge.emit(this._buildDashboardPayload());

        // ── Execute step via injection callback ────────────────────────────────
        let execResult: CampaignStepExecutionResult;
        try {
            execResult = await this.stepExecutor(nextStep, campaign);
        } catch (err: any) {
            // Unrecoverable executor error — treat as failure
            execResult = {
                executionRunId: `failed-${Date.now()}`,
                executionSucceeded: false,
                rollbackTriggered: false,
                failureReason: err.message ?? 'Step executor threw unexpectedly',
            };
        }

        // ── Mark awaiting verification + persist ───────────────────────────────
        stepRegistry.markAwaitingVerification(nextStep.stepId, execResult.executionRunId);
        campaign.status = 'awaiting_checkpoint';
        this.registry.save(campaign);

        // ── Checkpoint evaluation ──────────────────────────────────────────────
        const checkpoint = this.checkpointEngine.evaluate(nextStep, execResult, campaign);
        campaign.checkpoints.push(checkpoint);
        campaign.status = 'awaiting_reassessment';
        this.registry.save(campaign);
        this.dashboardBridge.emit(this._buildDashboardPayload());

        // ── Update step status based on checkpoint ─────────────────────────────
        if (checkpoint.outcome === 'passed' || checkpoint.outcome === 'degraded') {
            if (!nextStep.verificationRequired || checkpoint.outcome === 'passed') {
                stepRegistry.markPassed(nextStep.stepId, checkpoint.checkpointId);
            } else {
                // degraded + verificationRequired → still pass for now; reassessment may abort
                stepRegistry.markPassed(nextStep.stepId, checkpoint.checkpointId);
            }
        } else {
            if (execResult.rollbackTriggered) {
                stepRegistry.markRolledBack(nextStep.stepId);
            } else {
                stepRegistry.markFailed(nextStep.stepId, execResult.failureReason);
            }
        }

        // ── Reassessment ───────────────────────────────────────────────────────
        campaign.reassessmentCount += 1;
        const reassessment = this.reassessmentEngine.decide(campaign, checkpoint);
        campaign.reassessmentRecords.push(reassessment);
        this.registry.save(campaign);

        // ── Apply reassessment decision ────────────────────────────────────────
        return this._applyDecision(campaign, stepRegistry, reassessment.decision, reassessment.rationale);
    }

    private _applyDecision(
        campaign: RepairCampaign,
        stepRegistry: CampaignStepRegistry,
        decision: string,
        rationale: string,
    ): RepairCampaign {
        switch (decision) {
            case 'continue': {
                campaign.status = 'active';
                this.registry.save(campaign);
                this.dashboardBridge.emit(this._buildDashboardPayload());
                // Check if all steps are now terminal → complete
                if (stepRegistry.allTerminal()) {
                    return this._completeCampaign(campaign);
                }
                return campaign;
            }

            case 'skip_step': {
                const nextPending = stepRegistry.getNextPendingStep();
                if (nextPending && nextPending.isOptional) {
                    stepRegistry.skipStep(nextPending.stepId, `Skipped via reassessment: ${rationale}`);
                }
                campaign.status = 'active';
                this.registry.save(campaign);
                this.dashboardBridge.emit(this._buildDashboardPayload());
                if (stepRegistry.allTerminal()) {
                    return this._completeCampaign(campaign);
                }
                return campaign;
            }

            case 'defer': {
                campaign.status = 'deferred';
                campaign.haltReason = rationale;
                this.registry.save(campaign);
                this.dashboardBridge.emit(this._buildDashboardPayload());
                telemetry.operational('autonomy', 'campaign_deferred', 'info', 'RepairCampaignCoordinator',
                    `Campaign ${campaign.campaignId} deferred: ${rationale}`);
                return campaign;
            }

            case 'human_review': {
                campaign.status = 'paused';
                campaign.haltReason = rationale;
                this.registry.save(campaign);
                this.dashboardBridge.emit(this._buildDashboardPayload());
                telemetry.operational('autonomy', 'campaign_halted', 'warn', 'RepairCampaignCoordinator',
                    `Campaign ${campaign.campaignId} halted for human review: ${rationale}`);
                return campaign;
            }

            case 'rollback': {
                campaign.status = 'rolled_back';
                campaign.haltReason = rationale;
                this.registry.save(campaign);
                this.safetyGuard.applyCooldown(campaign, 'rollback');
                this.outcomeTracker.record(campaign);
                this.dashboardBridge.emit(this._buildDashboardPayload());
                telemetry.operational('autonomy', 'campaign_rolled_back', 'warn', 'RepairCampaignCoordinator',
                    `Campaign ${campaign.campaignId} rolled back: ${rationale}`);
                return campaign;
            }

            case 'abort':
            default: {
                campaign.status = 'failed';
                campaign.haltReason = rationale;
                this.registry.save(campaign);
                this.safetyGuard.applyCooldown(campaign, 'failure');
                this.outcomeTracker.record(campaign);
                this.dashboardBridge.emit(this._buildDashboardPayload());
                telemetry.operational('autonomy', 'campaign_aborted', 'warn', 'RepairCampaignCoordinator',
                    `Campaign ${campaign.campaignId} aborted: ${rationale}`);
                return campaign;
            }
        }
    }

    private _completeCampaign(campaign: RepairCampaign): RepairCampaign {
        campaign.status = 'succeeded';
        campaign.haltReason = undefined;
        this.registry.save(campaign);
        this.outcomeTracker.record(campaign);
        this.dashboardBridge.emit(this._buildDashboardPayload());
        telemetry.operational('autonomy', 'campaign_completed', 'info', 'RepairCampaignCoordinator',
            `Campaign ${campaign.campaignId} completed successfully (${campaign.steps.length} steps)`);
        return campaign;
    }

    private _buildDashboardPayload() {
        return {
            activeCampaigns: this.registry.getActiveCampaigns(),
            deferredCampaigns: this.registry.getDeferredCampaigns(),
            recentOutcomes: this.outcomeTracker.listOutcomes(),
        };
    }
}
