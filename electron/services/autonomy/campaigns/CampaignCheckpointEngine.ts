/**
 * CampaignCheckpointEngine.ts — Phase 5.5 P5.5D
 *
 * Checkpoint & Verification Engine for repair campaigns.
 *
 * Responsibilities:
 * - Evaluate the outcome of a completed campaign step.
 * - Inspect execution run result (success/failure).
 * - Run lightweight invariant checks (pattern-based, no model calls).
 * - Detect scope drift (mutations outside declared scopeHint).
 * - Produce an explicit CampaignCheckpoint record for reassessment.
 *
 * Design principles:
 * - DETERMINISTIC: all checks are rule-based, never model-driven.
 * - NO SIDE EFFECTS: the engine only reads state; it does not transition
 *   campaign or step state.
 * - ALWAYS PRODUCES A CHECKPOINT: even for failed steps, a checkpoint is
 *   emitted so the reassessment engine has complete information.
 *
 * Inputs:
 *   step            — the CampaignStep that just completed
 *   executionResult — lightweight result from the execution pipeline
 *   campaign        — current campaign snapshot (for scope and bounds context)
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    CampaignStep,
    RepairCampaign,
    CampaignCheckpoint,
    CampaignCheckpointOutcome,
    CampaignCheckpointCheckResult,
} from '../../../../shared/repairCampaignTypes';
import { telemetry } from '../../TelemetryService';

// ─── Execution result shape ───────────────────────────────────────────────────

/**
 * Minimal result summary from the execution pipeline, passed into the checkpoint engine.
 * The coordinator extracts these fields from the ExecutionRun record.
 */
export interface CampaignStepExecutionResult {
    /** Phase 3 execution run ID. */
    executionRunId: string;
    /** Whether the Phase 3 execution pipeline reported success. */
    executionSucceeded: boolean;
    /** Whether a Phase 3 rollback was triggered. */
    rollbackTriggered: boolean;
    /** Human-readable failure reason if executionSucceeded=false. */
    failureReason?: string;
    /** Files that were actually mutated during execution (for scope drift detection). */
    mutatedFiles?: string[];
    /** Verification step results from Phase 3 VerificationRunner. */
    verificationResults?: Array<{
        stepName: string;
        passed: boolean;
        detail?: string;
    }>;
    /** Any invariant IDs that were reported as violated. */
    invariantViolations?: string[];
}

// ─── CampaignCheckpointEngine ─────────────────────────────────────────────────

export class CampaignCheckpointEngine {
    /**
     * Evaluates a completed campaign step and produces an immutable CampaignCheckpoint.
     *
     * Always produces a checkpoint, even when the step failed.
     * The checkpoint outcome reflects the combined verification and safety state.
     */
    evaluate(
        step: CampaignStep,
        result: CampaignStepExecutionResult,
        campaign: RepairCampaign,
    ): CampaignCheckpoint {
        const checkpointId = `chk-${uuidv4()}`;
        const evaluatedAt = new Date().toISOString();

        const checks: CampaignCheckpointCheckResult[] = [];
        let invariantViolations: string[] = [];

        // ── Check 1: Execution success ─────────────────────────────────────────
        checks.push({
            checkName: 'execution_succeeded',
            passed: result.executionSucceeded,
            detail: result.executionSucceeded
                ? 'Execution pipeline reported success'
                : (result.failureReason ?? 'Execution pipeline reported failure'),
        });

        // ── Check 2: Rollback guard ────────────────────────────────────────────
        if (result.rollbackTriggered) {
            checks.push({
                checkName: 'no_rollback_triggered',
                passed: false,
                detail: 'Phase 3 rollback was triggered during this step',
            });
        }

        // ── Check 3: Verification step results ────────────────────────────────
        if (result.verificationResults && result.verificationResults.length > 0) {
            const allVerifPassed = result.verificationResults.every(v => v.passed);
            for (const vr of result.verificationResults) {
                checks.push({
                    checkName: `verification:${vr.stepName}`,
                    passed: vr.passed,
                    detail: vr.detail,
                });
            }
            if (!allVerifPassed && step.verificationRequired) {
                checks.push({
                    checkName: 'required_verification_passed',
                    passed: false,
                    detail: 'One or more required verification checks failed',
                });
            }
        } else if (step.verificationRequired) {
            // No verification results provided but step requires them
            checks.push({
                checkName: 'verification_results_available',
                passed: false,
                detail: 'verificationRequired=true but no verification results were provided',
            });
        }

        // ── Check 4: Invariant violations ─────────────────────────────────────
        if (result.invariantViolations && result.invariantViolations.length > 0) {
            invariantViolations = [...result.invariantViolations];
            checks.push({
                checkName: 'no_invariant_violations',
                passed: false,
                detail: `Invariant violations detected: ${invariantViolations.join(', ')}`,
            });
        }

        // ── Check 5: Scope drift detection ────────────────────────────────────
        const { scopeDriftDetected, scopeDriftDetails } = this._checkScopeDrift(
            step,
            result.mutatedFiles ?? [],
        );
        if (result.mutatedFiles && result.mutatedFiles.length > 0) {
            checks.push({
                checkName: 'scope_within_bounds',
                passed: !scopeDriftDetected,
                detail: scopeDriftDetected ? scopeDriftDetails : 'All mutations within declared scope',
            });
        }

        // ── Compute overall outcome ────────────────────────────────────────────
        const outcome = this._computeOutcome(
            result,
            checks,
            invariantViolations,
            scopeDriftDetected,
        );

        const continueRecommended = outcome === 'passed'
            || (outcome === 'degraded' && !scopeDriftDetected && invariantViolations.length === 0);

        const summary = this._buildSummary(outcome, checks, invariantViolations, scopeDriftDetected);

        telemetry.operational(
            'autonomy',
            'campaign_checkpoint_completed',
            outcome === 'passed' ? 'info' : 'warn',
            'CampaignCheckpointEngine',
            `Checkpoint ${checkpointId} for step ${step.stepId} (campaign ${campaign.campaignId}): ${outcome} — ${summary}`,
        );

        return {
            checkpointId,
            campaignId: campaign.campaignId,
            stepId: step.stepId,
            evaluatedAt,
            outcome,
            executionSucceeded: result.executionSucceeded,
            checks,
            invariantViolations,
            scopeDriftDetected,
            scopeDriftDetails,
            continueRecommended,
            summary,
        };
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _checkScopeDrift(
        step: CampaignStep,
        mutatedFiles: string[],
    ): { scopeDriftDetected: boolean; scopeDriftDetails?: string } {
        if (mutatedFiles.length === 0) {
            return { scopeDriftDetected: false };
        }

        const scopeHint = step.scopeHint.toLowerCase();
        const outOfScope = mutatedFiles.filter(f => {
            const lower = f.toLowerCase();
            // A file is in-scope if the scopeHint appears in its path OR
            // if the step's targetSubsystem appears in its path.
            const subsystemHint = step.targetSubsystem.toLowerCase();
            return !lower.includes(scopeHint) && !lower.includes(subsystemHint);
        });

        if (outOfScope.length === 0) {
            return { scopeDriftDetected: false };
        }

        return {
            scopeDriftDetected: true,
            scopeDriftDetails: `${outOfScope.length} file(s) mutated outside declared scope ` +
                `'${step.scopeHint}': ${outOfScope.slice(0, 5).join(', ')}`,
        };
    }

    private _computeOutcome(
        result: CampaignStepExecutionResult,
        checks: CampaignCheckpointCheckResult[],
        invariantViolations: string[],
        scopeDriftDetected: boolean,
    ): CampaignCheckpointOutcome {
        // Critical failures → failed
        if (!result.executionSucceeded) return 'failed';
        if (result.rollbackTriggered) return 'failed';
        if (invariantViolations.length > 0) return 'failed';

        // Scope drift alone → degraded (not failed — execution succeeded)
        if (scopeDriftDetected) return 'degraded';

        // Any verification check failed → check if critical
        const failedChecks = checks.filter(c => !c.passed);
        if (failedChecks.length === 0) return 'passed';

        // If only optional verifications failed → degraded
        const criticalFailed = failedChecks.filter(c =>
            !c.checkName.startsWith('verification:') ||
            c.checkName === 'required_verification_passed' ||
            c.checkName === 'verification_results_available',
        );
        if (criticalFailed.length > 0) return 'failed';

        return 'degraded';
    }

    private _buildSummary(
        outcome: CampaignCheckpointOutcome,
        checks: CampaignCheckpointCheckResult[],
        invariantViolations: string[],
        scopeDriftDetected: boolean,
    ): string {
        if (outcome === 'passed') return 'All checks passed; step verified successfully.';

        const failedChecks = checks.filter(c => !c.passed).map(c => c.checkName);
        const parts: string[] = [];
        if (invariantViolations.length > 0) {
            parts.push(`invariant violations: ${invariantViolations.join(', ')}`);
        }
        if (scopeDriftDetected) {
            parts.push('scope drift detected');
        }
        if (failedChecks.length > 0) {
            parts.push(`failed checks: ${failedChecks.join(', ')}`);
        }

        return outcome === 'degraded'
            ? `Step completed with warnings — ${parts.join('; ')}`
            : `Step failed — ${parts.join('; ')}`;
    }
}
