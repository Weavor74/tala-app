/**
 * RollbackClassifier.ts — Phase 2 P2F
 *
 * Determines the rollback strategy and safety class for a proposed change.
 *
 * Classification is deterministic:
 *   - No model calls.
 *   - Reads only the blast radius and invariant impact from the snapshot.
 *   - Produces a concrete rollback plan with ordered steps.
 *
 * Safety tiers (from safest to most restricted):
 *   safe_auto        — may be promoted automatically without human review.
 *   safe_with_review — promotion allowed after human review.
 *   high_risk        — requires explicit approval + elevated verification.
 *   blocked          — change MUST NOT be auto-promoted under any condition.
 */

import type {
    BlastRadiusResult,
    VerificationRequirements,
    RollbackClassification,
    RollbackStrategy,
    SafetyClass,
    ProposalChange,
} from '../../../shared/reflectionPlanTypes';
import type { InvariantImpactReport } from './InvariantImpactEvaluator';
import { telemetry } from '../TelemetryService';

// ─── RollbackClassifier ───────────────────────────────────────────────────────

export class RollbackClassifier {

    /**
     * Classifies the rollback strategy and safety tier for a proposed change.
     *
     * @param runId        Planning run ID (for telemetry only).
     * @param changes      The concrete file changes in the proposal.
     * @param blastRadius  Blast radius computed for these changes.
     * @param impact       Invariant impact report.
     * @param verification Verification requirements.
     */
    classify(
        runId: string,
        changes: ProposalChange[],
        blastRadius: BlastRadiusResult,
        impact: InvariantImpactReport,
        verification: VerificationRequirements,
    ): RollbackClassification {
        const strategy = this._determineStrategy(changes, blastRadius);
        const safetyClass = this._determineSafetyClass(
            blastRadius,
            impact,
            verification,
            changes,
        );
        const rollbackSteps = this._buildRollbackSteps(strategy, changes, blastRadius);
        const requiresApproval = safetyClass !== 'safe_auto';
        const estimatedRollbackMs = this._estimateRollbackTime(strategy, rollbackSteps.length);
        const classificationReasoning = this._buildReasoning(safetyClass, blastRadius, impact);

        const result: RollbackClassification = {
            strategy,
            safetyClass,
            rollbackSteps,
            requiresApproval,
            estimatedRollbackMs,
            classificationReasoning,
        };

        telemetry.operational(
            'planning',
            'planning.rollback.classified',
            'debug',
            'RollbackClassifier',
            `Run ${runId}: strategy=${strategy}, safetyClass=${safetyClass}`,
        );

        return result;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _determineStrategy(
        changes: ProposalChange[],
        blast: BlastRadiusResult,
    ): RollbackStrategy {
        const hasDeletes = changes.some(c => c.type === 'delete');
        const isAddOnly = changes.every(c => c.type === 'create');
        const touchesProtectedSubsystems = blast.affectedSubsystems.some(s =>
            ['identity', 'soul', 'capability_gating'].includes(s),
        );

        if (touchesProtectedSubsystems) return 'manual_only';
        if (isAddOnly && !hasDeletes) return 'no_rollback_needed';
        if (blast.invariantRisk === 'critical' || blast.invariantRisk === 'high') {
            return 'git_revert';
        }
        return 'file_restore';
    }

    private _determineSafetyClass(
        blast: BlastRadiusResult,
        impact: InvariantImpactReport,
        verification: VerificationRequirements,
        changes: ProposalChange[],
    ): SafetyClass {
        // Hard blocks
        if (blast.blockedBy.length > 0) return 'blocked';
        if (changes.some(c => c.type === 'delete')) return 'high_risk';
        if (blast.affectedSubsystems.some(s =>
            ['identity', 'soul', 'capability_gating'].includes(s),
        )) {
            return 'blocked';
        }

        // High risk conditions
        if (blast.invariantRisk === 'critical') return 'high_risk';
        if (impact.blockingCount > 0) return 'high_risk';
        if (verification.manualReviewRequired) return 'safe_with_review';

        // Medium risk
        if (blast.invariantRisk === 'high') return 'safe_with_review';
        if (blast.affectedSubsystems.length >= 3) return 'safe_with_review';
        if (impact.threatenedCount > 0) return 'safe_with_review';

        // Low risk
        if (blast.invariantRisk === 'none' && impact.threatenedCount === 0) {
            return 'safe_auto';
        }

        return 'safe_with_review';
    }

    private _buildRollbackSteps(
        strategy: RollbackStrategy,
        changes: ProposalChange[],
        blast: BlastRadiusResult,
    ): string[] {
        switch (strategy) {
            case 'no_rollback_needed':
                return ['No rollback required — change is additive-only.'];

            case 'file_restore': {
                const steps: string[] = [
                    'Stop any running services that depend on modified files.',
                ];
                for (const c of changes) {
                    if (c.type !== 'create') {
                        steps.push(`Restore backup of: ${c.path}`);
                    }
                }
                steps.push('Restart affected services.');
                steps.push('Run smoke checks to confirm baseline behaviour is restored.');
                return steps;
            }

            case 'git_revert': {
                return [
                    'Identify the promotion commit hash from the promotion record.',
                    'Run: git revert <commit-hash> --no-edit',
                    'Run: npm run typecheck && npm run test',
                    'Deploy reverted state and confirm baseline behaviour.',
                ];
            }

            case 'config_rollback': {
                return [
                    'Identify configuration keys changed by the proposal.',
                    'Restore prior configuration values from the pre-change backup.',
                    'Restart affected services.',
                    'Confirm baseline behaviour with smoke checks.',
                ];
            }

            case 'manual_only': {
                const subsystems = blast.affectedSubsystems.join(', ');
                return [
                    `MANUAL ROLLBACK REQUIRED — affected subsystems: ${subsystems}`,
                    'Consult the promotion record for the list of changed files.',
                    'Restore each file manually from the archive.',
                    'Do NOT use automated tooling for this rollback.',
                    'Notify the operator after rollback is complete.',
                ];
            }
        }
    }

    private _estimateRollbackTime(strategy: RollbackStrategy, stepCount: number): number {
        const base: Record<RollbackStrategy, number> = {
            no_rollback_needed: 0,
            file_restore: 30_000,
            git_revert: 120_000,
            config_rollback: 60_000,
            manual_only: 600_000,
        };
        return base[strategy] + stepCount * 5_000;
    }

    private _buildReasoning(
        safetyClass: SafetyClass,
        blast: BlastRadiusResult,
        impact: InvariantImpactReport,
    ): string {
        const parts: string[] = [`Safety class: ${safetyClass}.`];

        if (blast.blockedBy.length > 0) {
            parts.push(`Blocked by invariants: ${blast.blockedBy.join(', ')}.`);
        }
        if (impact.blockingCount > 0) {
            parts.push(`${impact.blockingCount} invariant(s) block auto-promotion.`);
        }
        if (blast.affectedSubsystems.length > 0) {
            parts.push(`Blast radius: ${blast.affectedSubsystems.length} subsystem(s) affected.`);
        }
        parts.push(`Invariant risk tier: ${blast.invariantRisk}.`);

        return parts.join(' ');
    }
}
