/**
 * CampaignReassessmentEngine.ts — Phase 5.5 P5.5E
 *
 * Reassessment & Continue/Stop Logic for repair campaigns.
 *
 * Responsibilities:
 * - Consume current campaign state + checkpoint result.
 * - Apply deterministic rules to decide the campaign's next action.
 * - Produce an explicit, auditable CampaignReassessmentRecord.
 *
 * Decision rules (evaluated in priority order):
 *
 *   1. BOUNDS_EXCEEDED_REASSESSMENTS — abort if campaign.reassessmentCount >= bounds.maxReassessments
 *   2. BOUNDS_EXCEEDED_AGE          — defer if campaign is past expiresAt
 *   3. INVARIANT_VIOLATION          — human_review if invariant violations present
 *   4. SCOPE_DRIFT                  — human_review if scope drift detected
 *   5. EXECUTION_FAILED_ROLLBACK    — rollback if step failed and rollback was triggered
 *   6. EXECUTION_FAILED_REQUIRED    — abort if required step failed (no rollback)
 *   7. EXECUTION_FAILED_OPTIONAL    — skip_step for failed optional step
 *   8. CHECKPOINT_DEGRADED_CRITICAL — abort if checkpoint degraded and remaining steps depend on it
 *   9. CHECKPOINT_DEGRADED_SAFE     — continue with degraded flag (no dependents)
 *  10. CHECKPOINT_PASSED_MORE_STEPS — continue
 *  11. CHECKPOINT_PASSED_LAST_STEP  — continue (coordinator detects campaign completion)
 *
 * Design principles:
 * - DETERMINISTIC: same inputs → same decision.
 * - NO MODEL CALLS: no inference, no LLM.
 * - EXPLICIT RATIONALE: every record contains a non-vague rationale string.
 * - BOUNDED: reassessment count is always incremented and checked.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    RepairCampaign,
    CampaignCheckpoint,
    CampaignReassessmentDecision,
    CampaignReassessmentRecord,
    CampaignStep,
} from '../../../../shared/repairCampaignTypes';
import { telemetry } from '../../TelemetryService';

// ─── Rule names (for audit trail) ─────────────────────────────────────────────

type ReassessmentRule =
    | 'BOUNDS_EXCEEDED_REASSESSMENTS'
    | 'BOUNDS_EXCEEDED_AGE'
    | 'INVARIANT_VIOLATION'
    | 'SCOPE_DRIFT'
    | 'EXECUTION_FAILED_ROLLBACK'
    | 'EXECUTION_FAILED_REQUIRED'
    | 'EXECUTION_FAILED_OPTIONAL'
    | 'CHECKPOINT_DEGRADED_CRITICAL'
    | 'CHECKPOINT_DEGRADED_SAFE'
    | 'CHECKPOINT_PASSED';

// ─── CampaignReassessmentEngine ───────────────────────────────────────────────

export class CampaignReassessmentEngine {
    /**
     * Evaluates the current campaign state after a checkpoint and returns an
     * immutable CampaignReassessmentRecord with the decision and rationale.
     *
     * The engine does NOT modify the campaign or step state; that is the
     * coordinator's responsibility.
     *
     * @param campaign   Current campaign snapshot (reassessmentCount already pre-incremented by the coordinator before calling here).
     * @param checkpoint Checkpoint produced by CampaignCheckpointEngine for the completed step.
     */
    decide(
        campaign: RepairCampaign,
        checkpoint: CampaignCheckpoint,
    ): CampaignReassessmentRecord {
        const completedStep = campaign.steps.find(s => s.stepId === checkpoint.stepId);
        const remainingSteps = campaign.steps.filter(
            s => s.status === 'pending',
        );
        const remainingCount = remainingSteps.length;

        const { decision, rule, rationale } = this._evaluate(
            campaign,
            checkpoint,
            completedStep,
            remainingSteps,
        );

        const record: CampaignReassessmentRecord = {
            reassessmentId: `reassess-${uuidv4()}`,
            campaignId: campaign.campaignId,
            stepId: checkpoint.stepId,
            checkpointId: checkpoint.checkpointId,
            evaluatedAt: new Date().toISOString(),
            decision,
            rationale,
            remainingStepsAtDecision: remainingCount,
            reassessmentIndex: campaign.reassessmentCount,
            triggerRule: rule,
        };

        telemetry.operational(
            'autonomy',
            'campaign_reassessment_decided',
            decision === 'continue' ? 'info' : 'warn',
            'CampaignReassessmentEngine',
            `Campaign ${campaign.campaignId}: reassessment #${campaign.reassessmentCount} → ${decision} ` +
            `(rule: ${rule}) — ${rationale}`,
        );

        return record;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _evaluate(
        campaign: RepairCampaign,
        checkpoint: CampaignCheckpoint,
        completedStep: CampaignStep | undefined,
        remainingSteps: CampaignStep[],
    ): { decision: CampaignReassessmentDecision; rule: ReassessmentRule; rationale: string } {

        // ── Rule 1: Reassessment count exceeded ────────────────────────────────
        if (campaign.reassessmentCount >= campaign.bounds.maxReassessments) {
            return {
                decision: 'abort',
                rule: 'BOUNDS_EXCEEDED_REASSESSMENTS',
                rationale: `Campaign ${campaign.campaignId} has exceeded the maximum reassessment count ` +
                    `(${campaign.reassessmentCount} >= bounds.maxReassessments=${campaign.bounds.maxReassessments}). ` +
                    `Aborting to prevent unbounded execution.`,
            };
        }

        // ── Rule 2: Campaign age exceeded ──────────────────────────────────────
        if (Date.now() > new Date(campaign.expiresAt).getTime()) {
            return {
                decision: 'defer',
                rule: 'BOUNDS_EXCEEDED_AGE',
                rationale: `Campaign ${campaign.campaignId} has exceeded its maximum age ` +
                    `(expiresAt=${campaign.expiresAt}). Deferring for potential restart.`,
            };
        }

        // ── Rule 3: Invariant violations → human review ────────────────────────
        if (checkpoint.invariantViolations.length > 0) {
            return {
                decision: 'human_review',
                rule: 'INVARIANT_VIOLATION',
                rationale: `Invariant violations detected in checkpoint ${checkpoint.checkpointId}: ` +
                    `${checkpoint.invariantViolations.join(', ')}. ` +
                    `Routing to human review — autonomous continuation is unsafe.`,
            };
        }

        // ── Rule 4: Scope drift → human review ────────────────────────────────
        if (checkpoint.scopeDriftDetected) {
            return {
                decision: 'human_review',
                rule: 'SCOPE_DRIFT',
                rationale: `Scope drift detected in checkpoint ${checkpoint.checkpointId}: ` +
                    `${checkpoint.scopeDriftDetails ?? 'mutations outside declared scope'}. ` +
                    `Routing to human review — scope was violated.`,
            };
        }

        // ── Rule 5: Execution failed + rollback triggered ─────────────────────
        if (!checkpoint.executionSucceeded && checkpoint.outcome === 'failed') {
            const rollbackTriggered = checkpoint.checks.some(
                c => c.checkName === 'no_rollback_triggered' && !c.passed,
            );
            if (rollbackTriggered) {
                return {
                    decision: 'rollback',
                    rule: 'EXECUTION_FAILED_ROLLBACK',
                    rationale: `Step ${checkpoint.stepId} execution failed and a Phase 3 rollback was triggered. ` +
                        `Campaign is terminating via rollback.`,
                };
            }
        }

        // ── Rule 6: Execution failed, required step ───────────────────────────
        if (checkpoint.outcome === 'failed' && completedStep && !completedStep.isOptional) {
            return {
                decision: 'abort',
                rule: 'EXECUTION_FAILED_REQUIRED',
                rationale: `Required step ${checkpoint.stepId} ("${completedStep.label}") failed with ` +
                    `checkpoint outcome '${checkpoint.outcome}'. ` +
                    `No rollback was triggered. Aborting campaign — cannot continue without this step.`,
            };
        }

        // ── Rule 7: Execution failed, optional step ───────────────────────────
        if (checkpoint.outcome === 'failed' && completedStep?.isOptional) {
            if (remainingSteps.length > 0) {
                return {
                    decision: 'skip_step',
                    rule: 'EXECUTION_FAILED_OPTIONAL',
                    rationale: `Optional step ${checkpoint.stepId} ("${completedStep.label}") failed. ` +
                        `Skipping next pending optional-dependency step and continuing campaign.`,
                };
            }
            return {
                decision: 'continue',
                rule: 'CHECKPOINT_PASSED',
                rationale: `Optional step ${checkpoint.stepId} failed but it was the last step. ` +
                    `Campaign can complete with this optional step skipped.`,
            };
        }

        // ── Rule 8: Degraded checkpoint, remaining steps depend on this one ────
        if (checkpoint.outcome === 'degraded') {
            const hasDependentSteps = remainingSteps.some(
                s => s.prerequisites.includes(checkpoint.stepId),
            );
            if (hasDependentSteps) {
                return {
                    decision: 'abort',
                    rule: 'CHECKPOINT_DEGRADED_CRITICAL',
                    rationale: `Checkpoint ${checkpoint.checkpointId} outcome is 'degraded' and ` +
                        `${remainingSteps.filter(s => s.prerequisites.includes(checkpoint.stepId)).length} ` +
                        `remaining step(s) depend on step ${checkpoint.stepId}. ` +
                        `Aborting — dependent steps cannot safely proceed on a degraded predecessor.`,
                };
            }

            // Rule 9: Degraded but no dependents
            return {
                decision: 'continue',
                rule: 'CHECKPOINT_DEGRADED_SAFE',
                rationale: `Checkpoint ${checkpoint.checkpointId} outcome is 'degraded' but ` +
                    `no remaining steps depend on step ${checkpoint.stepId}. ` +
                    `Continuing with degraded step recorded.`,
            };
        }

        // ── Rule 10/11: Checkpoint passed ─────────────────────────────────────
        return {
            decision: 'continue',
            rule: 'CHECKPOINT_PASSED',
            rationale: `Checkpoint ${checkpoint.checkpointId} outcome is 'passed'. ` +
                (remainingSteps.length > 0
                    ? `${remainingSteps.length} step(s) remaining; advancing campaign.`
                    : 'No steps remaining; campaign is complete.'),
        };
    }
}
