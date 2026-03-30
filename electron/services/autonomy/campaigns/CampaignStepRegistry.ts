/**
 * CampaignStepRegistry.ts — Phase 5.5 P5.5C
 *
 * Step state machine for a repair campaign.
 *
 * Responsibilities:
 * - Enforce valid step status transitions.
 * - Resolve the next pending step (respecting prerequisites).
 * - Record step completion, failure, and skip events.
 * - Provide a query view over the current step state.
 *
 * State machine:
 *   pending → running → awaiting_verification → passed
 *                     → failed
 *                     → rolled_back
 *   pending → skipped  (only via skipStep())
 *
 * Safety invariants:
 * - A step may only enter 'running' if all its prerequisites are in 'passed'.
 * - Only CampaignReassessmentEngine may skip a step (guarded by reason parameter).
 * - No transitions from terminal states (passed, failed, rolled_back, skipped).
 * - All transitions are logged for auditability.
 */

import type {
    CampaignStep,
    CampaignStepId,
    CampaignStepStatus,
} from '../../../../shared/repairCampaignTypes';
import { telemetry } from '../../TelemetryService';

// ─── Terminal states ──────────────────────────────────────────────────────────

const TERMINAL_STEP_STATUSES = new Set<CampaignStepStatus>([
    'passed', 'failed', 'rolled_back', 'skipped',
]);

// ─── CampaignStepRegistry ─────────────────────────────────────────────────────

export class CampaignStepRegistry {
    /**
     * @param steps Mutable reference to the campaign's step array.
     *              The registry modifies step.status and related fields in place.
     */
    constructor(private readonly steps: CampaignStep[]) {}

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns the next step in 'pending' status whose prerequisites are all 'passed'.
     * Returns null if no such step exists.
     */
    getNextPendingStep(): CampaignStep | null {
        for (const step of this.steps) {
            if (step.status !== 'pending') continue;
            if (this._prerequisitesMet(step)) return step;
        }
        return null;
    }

    /**
     * Returns the step with the given ID, or null if not found.
     */
    getById(stepId: CampaignStepId): CampaignStep | null {
        return this.steps.find(s => s.stepId === stepId) ?? null;
    }

    /**
     * Returns all steps with the given status.
     */
    getByStatus(status: CampaignStepStatus): CampaignStep[] {
        return this.steps.filter(s => s.status === status);
    }

    /**
     * Returns true if all steps are in a terminal state.
     */
    allTerminal(): boolean {
        return this.steps.every(s => TERMINAL_STEP_STATUSES.has(s.status));
    }

    /**
     * Returns true if all required (non-optional) steps are 'passed'.
     */
    allRequiredPassed(): boolean {
        return this.steps
            .filter(s => !s.isOptional)
            .every(s => s.status === 'passed');
    }

    // ── Transitions ─────────────────────────────────────────────────────────────

    /**
     * Transitions a step from 'pending' → 'running'.
     * Throws if prerequisites are not met or step is not in 'pending' status.
     */
    markRunning(stepId: CampaignStepId): CampaignStep {
        const step = this._getOrThrow(stepId);
        this._assertStatus(step, 'pending', 'markRunning');
        if (!this._prerequisitesMet(step)) {
            throw new Error(
                `[CampaignStepRegistry] Cannot mark step ${stepId} as running: prerequisites not met`,
            );
        }
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        this._log(step, 'running');
        return step;
    }

    /**
     * Transitions a step from 'running' → 'awaiting_verification'.
     * Sets the execution run ID for later checkpoint evaluation.
     */
    markAwaitingVerification(stepId: CampaignStepId, executionRunId?: string): CampaignStep {
        const step = this._getOrThrow(stepId);
        this._assertStatus(step, 'running', 'markAwaitingVerification');
        step.status = 'awaiting_verification';
        if (executionRunId) step.executionRunId = executionRunId;
        this._log(step, 'awaiting_verification');
        return step;
    }

    /**
     * Transitions a step from 'awaiting_verification' → 'passed'.
     * Optionally skips the awaiting_verification state when verificationRequired=false.
     */
    markPassed(stepId: CampaignStepId, checkpointId?: string): CampaignStep {
        const step = this._getOrThrow(stepId);
        const allowedFrom: CampaignStepStatus[] = step.verificationRequired
            ? ['awaiting_verification']
            : ['awaiting_verification', 'running'];
        if (!allowedFrom.includes(step.status)) {
            throw new Error(
                `[CampaignStepRegistry] Cannot mark step ${stepId} as passed from status '${step.status}'`,
            );
        }
        step.status = 'passed';
        step.completedAt = new Date().toISOString();
        if (checkpointId) step.checkpointId = checkpointId;
        this._log(step, 'passed');
        return step;
    }

    /**
     * Transitions a step to 'failed'.
     * Allowed from: running, awaiting_verification.
     */
    markFailed(stepId: CampaignStepId, failureReason?: string): CampaignStep {
        const step = this._getOrThrow(stepId);
        if (!['running', 'awaiting_verification'].includes(step.status)) {
            throw new Error(
                `[CampaignStepRegistry] Cannot mark step ${stepId} as failed from status '${step.status}'`,
            );
        }
        step.status = 'failed';
        step.completedAt = new Date().toISOString();
        if (failureReason) step.failureReason = failureReason;
        this._log(step, 'failed');
        return step;
    }

    /**
     * Transitions a step from 'failed' or 'awaiting_verification' → 'rolled_back'.
     */
    markRolledBack(stepId: CampaignStepId): CampaignStep {
        const step = this._getOrThrow(stepId);
        if (!['failed', 'awaiting_verification', 'running'].includes(step.status)) {
            throw new Error(
                `[CampaignStepRegistry] Cannot mark step ${stepId} as rolled_back from status '${step.status}'`,
            );
        }
        step.status = 'rolled_back';
        step.completedAt = new Date().toISOString();
        this._log(step, 'rolled_back');
        return step;
    }

    /**
     * Marks a step as 'skipped'.
     * Only allowed from 'pending' status, and only via reassessment engine.
     *
     * @param reason Human-readable reason for the skip.
     */
    skipStep(stepId: CampaignStepId, reason: string): CampaignStep {
        const step = this._getOrThrow(stepId);
        this._assertStatus(step, 'pending', 'skipStep');
        step.status = 'skipped';
        step.skipReason = reason;
        step.completedAt = new Date().toISOString();
        this._log(step, 'skipped');
        return step;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _prerequisitesMet(step: CampaignStep): boolean {
        for (const prereqId of step.prerequisites) {
            const prereq = this.steps.find(s => s.stepId === prereqId);
            if (!prereq || prereq.status !== 'passed') return false;
        }
        return true;
    }

    private _getOrThrow(stepId: CampaignStepId): CampaignStep {
        const step = this.steps.find(s => s.stepId === stepId);
        if (!step) {
            throw new Error(`[CampaignStepRegistry] Step not found: ${stepId}`);
        }
        if (TERMINAL_STEP_STATUSES.has(step.status)) {
            throw new Error(
                `[CampaignStepRegistry] Step ${stepId} is already in terminal state '${step.status}'`,
            );
        }
        return step;
    }

    private _assertStatus(
        step: CampaignStep,
        expectedStatus: CampaignStepStatus,
        operation: string,
    ): void {
        if (step.status !== expectedStatus) {
            throw new Error(
                `[CampaignStepRegistry] ${operation}: expected step ${step.stepId} to be '${expectedStatus}', ` +
                `but found '${step.status}'`,
            );
        }
    }

    private _log(step: CampaignStep, newStatus: CampaignStepStatus): void {
        telemetry.operational(
            'autonomy',
            `campaign_step_${newStatus}` as any,
            'debug',
            'CampaignStepRegistry',
            `Step ${step.stepId} (order=${step.order}) → ${newStatus}: "${step.label}"`,
        );
    }
}
