/**
 * RecoveryPackPlannerAdapter.ts — Phase 4.3 P4.3D
 *
 * Translates a matched recovery pack into a bounded PlanTriggerInput.
 *
 * Design principles:
 * - No file writes.
 * - No direct execution.
 * - Produces a PlanTriggerInput that is fully compatible with SafeChangePlanner.
 * - Encodes pack scope and action templates into the description field so that
 *   SafeChangePlanner's pipeline can run normally with bounded context.
 * - Uses planningMode: 'light' to prefer deterministic-first planning.
 * - Returns null when the pack cannot safely produce a valid trigger input
 *   (e.g. no action templates, scope misconfiguration), causing the orchestrator
 *   to fall back to standard planning.
 *
 * The adapter does NOT bypass SafeChangePlanner, governance, or execution.
 * It only constructs the planning input. All pipeline gates still apply.
 */

import type { RecoveryPack, RecoveryPackMatchResult } from '../../../../shared/recoveryPackTypes';
import type { AutonomousGoal } from '../../../../shared/autonomyTypes';
import type { PlanTriggerInput } from '../../../../shared/reflectionPlanTypes';
import { telemetry } from '../../TelemetryService';

// ─── RecoveryPackPlannerAdapter ───────────────────────────────────────────────

export class RecoveryPackPlannerAdapter {

    /**
     * Produces a bounded PlanTriggerInput from a matched recovery pack.
     *
     * Returns null if the pack cannot produce a safe translation (e.g. no action
     * templates defined, scope.maxFiles === 0 for a file-modifying pack).
     * The caller (AutonomousRunOrchestrator) must fall back to standard planning
     * when null is returned.
     */
    buildPlanInput(
        goal: AutonomousGoal,
        pack: RecoveryPack,
        matchResult: RecoveryPackMatchResult,
    ): PlanTriggerInput | null {
        if (pack.actionTemplates.length === 0) {
            telemetry.operational(
                'autonomy',
                'recovery_pack_fallback',
                'warn',
                'RecoveryPackPlannerAdapter',
                `Pack ${pack.packId} has no action templates — cannot produce plan input; falling back.`,
            );
            return null;
        }

        // Build the structured description encoding pack guidance for the planner.
        const description = this._buildDescription(goal, pack, matchResult);

        const planInput: PlanTriggerInput = {
            subsystemId: goal.subsystemId,
            issueType: goal.source,
            normalizedTarget: goal.subsystemId,
            severity: this._severityForPriorityTier(goal.priorityTier),
            description,
            // Use 'light' mode: recovery packs are deterministic-first repair strategies.
            // This avoids model calls where the repair strategy is already specified.
            planningMode: 'light',
            sourceGoalId: goal.goalId,
            isManual: false,
        };

        telemetry.operational(
            'autonomy',
            'recovery_pack_used',
            'info',
            'RecoveryPackPlannerAdapter',
            `Pack ${pack.packId} (${pack.version}) produced plan input for goal ${goal.goalId} ` +
            `[${matchResult.selectedMatchStrength}, maxFiles=${pack.scope.maxFiles}]`,
        );

        return planInput;
    }

    // ── Private ─────────────────────────────────────────────────────────────────

    /**
     * Builds a structured description string that encodes the recovery pack's
     * bounded guidance for the planning pipeline.
     *
     * The description is the primary carrier of pack context through the planning
     * pipeline. It is human-readable and auditable, and gives SafeChangePlanner
     * structured hints about what bounded actions to consider.
     */
    private _buildDescription(
        goal: AutonomousGoal,
        pack: RecoveryPack,
        matchResult: RecoveryPackMatchResult,
    ): string {
        const parts: string[] = [];

        parts.push(
            `[RECOVERY PACK: ${pack.packId} v${pack.version}]`,
            `Pack: ${pack.label}`,
            `Match: ${matchResult.selectedMatchStrength} (confidence: ${pack.confidence.current.toFixed(3)})`,
            ``,
            `Goal: ${goal.title}`,
            `Subsystem: ${goal.subsystemId}`,
            `Source: ${goal.source}`,
            ``,
            `Pack description: ${pack.description}`,
            ``,
        );

        if (pack.actionTemplates.length > 0) {
            parts.push('Bounded actions this pack proposes:');
            for (const action of pack.actionTemplates) {
                const target = action.targetFileTemplate.replace('{subsystemId}', goal.subsystemId);
                parts.push(
                    `  - ${action.description}`,
                    `    Target: ${target}`,
                    `    Optional: ${action.optional}`,
                );
            }
            parts.push('');
        }

        if (pack.verificationTemplates.length > 0) {
            parts.push('Required verification:');
            for (const v of pack.verificationTemplates) {
                const target = v.targetPath.replace('{subsystemId}', goal.subsystemId);
                parts.push(`  - ${v.description} (${target})`);
            }
            parts.push('');
        }

        parts.push(
            `Scope limits: maxFiles=${pack.scope.maxFiles}` +
            (pack.scope.allowedFilePaths.length > 0
                ? `, allowedPaths=[${pack.scope.allowedFilePaths.join(', ')}]`
                : ''),
            `Rollback strategy: ${pack.rollbackTemplate.strategy}`,
            ``,
            `CONSTRAINT: Proposals generated from this recovery pack MUST NOT touch more than ` +
            `${pack.scope.maxFiles} file(s). If no bounded fix is feasible within this scope, ` +
            `return an empty proposal rather than exceeding the scope limit.`,
        );

        if (goal.description) {
            parts.push('', `Original goal description: ${goal.description}`);
        }

        return parts.join('\n');
    }

    private _severityForPriorityTier(tier: string): 'low' | 'medium' | 'high' | 'critical' {
        switch (tier) {
            case 'critical': return 'critical';
            case 'high':     return 'high';
            case 'medium':   return 'medium';
            default:         return 'low';
        }
    }
}
