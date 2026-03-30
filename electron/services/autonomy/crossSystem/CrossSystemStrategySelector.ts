/**
 * CrossSystemStrategySelector.ts — Phase 6 P6E
 *
 * Maps root cause hypotheses to system-level strategies.
 *
 * Strategy selection rules (deterministic, in priority order):
 *   1. If top hypothesis confidence < 0.30 → defer (not enough evidence)
 *   2. If top hypothesis score < 25 → defer
 *   3. If cluster.severity === 'high' AND subsystems > 2 → escalate_human
 *   4. If category === 'structural_drift' → harmonization_campaign
 *   5. If category === 'campaign_scope_mismatch' → multi_step_campaign
 *   6. If category === 'policy_boundary_gap' → escalate_human
 *   7. If category === 'cross_subsystem_dependency' AND subsystems > 1 → multi_step_campaign
 *   8. If category === 'repeated_execution_error' AND score ≥ 50 → targeted_repair
 *   9. Default → defer
 *
 * Preference: smallest effective scope (prefer targeted_repair over campaign,
 *             campaign over escalate_human).
 *
 * Bounds enforcement:
 *   - No automatic large-scale refactors (harmonization_campaign requires risk_level check)
 *   - escalate_human is always safe and is the fallback when uncertain
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    IncidentCluster,
    RootCauseHypothesis,
    StrategyDecisionRecord,
    CrossSystemStrategyKind,
} from '../../../../shared/crossSystemTypes';
import { telemetry } from '../../TelemetryService';

// ─── CrossSystemStrategySelector ─────────────────────────────────────────────

export class CrossSystemStrategySelector {
    /**
     * Selects a system-level strategy for the given cluster and hypotheses.
     *
     * Deterministic: same inputs → same StrategyDecisionRecord.
     *
     * @param cluster    The incident cluster to address.
     * @param hypotheses Root cause hypotheses sorted by score descending.
     * @returns          An immutable strategy decision record.
     */
    select(
        cluster: IncidentCluster,
        hypotheses: RootCauseHypothesis[],
    ): StrategyDecisionRecord {
        const top = hypotheses[0] ?? null;
        const allStrategies: CrossSystemStrategyKind[] = [
            'targeted_repair',
            'harmonization_campaign',
            'multi_step_campaign',
            'defer',
            'escalate_human',
        ];

        const strategy = this._applyRules(cluster, top);
        const alternatives = allStrategies.filter(s => s !== strategy);
        const rationale = this._buildRationale(cluster, top, strategy, alternatives);

        const policyConstraints: string[] = [
            'No automatic large-scale refactors without human review',
            'escalate_human is always a valid fallback',
            'Smallest effective scope is preferred',
        ];

        const scopeSummary = this._buildScopeSummary(cluster, top, strategy);

        const decision: StrategyDecisionRecord = {
            decisionId: `sdec-${uuidv4()}`,
            clusterId: cluster.clusterId,
            rootCauseId: top?.rootCauseId,
            strategySelected: strategy,
            rationale,
            decidedAt: new Date().toISOString(),
            policyConstraints,
            alternativesConsidered: alternatives,
            scopeSummary,
        };

        telemetry.operational(
            'autonomy',
            'operational',
            'info',
            'CrossSystemStrategySelector',
            `Strategy selected for cluster ${cluster.clusterId}: '${strategy}' ` +
            `(rootCause=${top?.category ?? 'none'}, confidence=${top?.confidence ?? 0}, ` +
            `score=${top?.score ?? 0})`,
        );

        return decision;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Applies strategy selection rules in priority order.
     * Returns the first matching strategy.
     */
    private _applyRules(
        cluster: IncidentCluster,
        top: RootCauseHypothesis | null,
    ): CrossSystemStrategyKind {
        // Rule 1: Insufficient confidence
        if (!top || top.confidence < 0.30) {
            return 'defer';
        }

        // Rule 2: Insufficient score
        if (top.score < 25) {
            return 'defer';
        }

        // Rule 3: High severity + broad subsystem spread → human review
        if (cluster.severity === 'high' && cluster.subsystems.length > 2) {
            return 'escalate_human';
        }

        // Rule 4: Structural drift → harmonization campaign
        if (top.category === 'structural_drift') {
            return 'harmonization_campaign';
        }

        // Rule 5: Campaign scope mismatch → multi-step campaign
        if (top.category === 'campaign_scope_mismatch') {
            return 'multi_step_campaign';
        }

        // Rule 6: Policy boundary gap → requires human review
        if (top.category === 'policy_boundary_gap') {
            return 'escalate_human';
        }

        // Rule 7: Cross-subsystem dependency with >1 subsystem → multi-step campaign
        if (top.category === 'cross_subsystem_dependency' && cluster.subsystems.length > 1) {
            return 'multi_step_campaign';
        }

        // Rule 8: Repeated execution error with sufficient evidence → targeted repair
        if (top.category === 'repeated_execution_error' && top.score >= 50) {
            return 'targeted_repair';
        }

        // Rule 9: Default — defer
        return 'defer';
    }

    /**
     * Produces a non-vague rationale string for the strategy decision.
     */
    private _buildRationale(
        cluster: IncidentCluster,
        top: RootCauseHypothesis | null,
        strategy: CrossSystemStrategyKind,
        alternatives: CrossSystemStrategyKind[],
    ): string {
        if (!top) {
            return `No root cause hypothesis available for cluster ${cluster.clusterId}. ` +
                `Deferring until more signals accumulate (min confidence 0.30 required).`;
        }

        const base = `Cluster ${cluster.clusterId} (${cluster.signalCount} signals, ` +
            `severity=${cluster.severity}, subsystems=${cluster.subsystems.join(', ')}). ` +
            `Top hypothesis: category='${top.category}', score=${top.score}, confidence=${top.confidence}.`;

        switch (strategy) {
            case 'targeted_repair':
                return `${base} Selected targeted_repair: repeated execution error in a single ` +
                    `subsystem with sufficient evidence (score=${top.score} ≥ 50). ` +
                    `Alternatives considered: ${alternatives.join(', ')}.`;

            case 'harmonization_campaign':
                return `${base} Selected harmonization_campaign: structural drift root cause ` +
                    `detected. The harmonization engine should re-apply the canon to affected files. ` +
                    `Alternatives considered: ${alternatives.join(', ')}.`;

            case 'multi_step_campaign':
                return `${base} Selected multi_step_campaign: root cause '${top.category}' ` +
                    `requires coordinated multi-step repair across ${cluster.subsystems.length} subsystem(s). ` +
                    `Alternatives considered: ${alternatives.join(', ')}.`;

            case 'escalate_human':
                return `${base} Selected escalate_human: ` +
                    (cluster.severity === 'high' && cluster.subsystems.length > 2
                        ? `high severity with ${cluster.subsystems.length} subsystems implicated requires human review.`
                        : `policy boundary gap requires operator decision.`) +
                    ` Alternatives considered: ${alternatives.join(', ')}.`;

            case 'defer':
            default:
                return `${base} Deferring: insufficient evidence to act (confidence=${top.confidence}, ` +
                    `score=${top.score}). Will re-evaluate when additional signals accumulate. ` +
                    `Alternatives considered: ${alternatives.join(', ')}.`;
        }
    }

    /**
     * Derives a concise, human-readable scope summary for the decision.
     */
    private _buildScopeSummary(
        cluster: IncidentCluster,
        top: RootCauseHypothesis | null,
        strategy: CrossSystemStrategyKind,
    ): string {
        const filesNote = cluster.sharedFiles.length > 0
            ? ` Shared files: ${cluster.sharedFiles.slice(0, 5).join(', ')}${cluster.sharedFiles.length > 5 ? ` (+${cluster.sharedFiles.length - 5} more)` : ''}.`
            : '';

        const subsystemNote = `Subsystems: ${cluster.subsystems.join(', ')}.`;

        switch (strategy) {
            case 'targeted_repair':
                return `Single-subsystem repair targeting '${cluster.dominantFailureType}' ` +
                    `in ${cluster.subsystems[0] ?? 'unknown'}.${filesNote}`;

            case 'harmonization_campaign':
                return `Harmonization re-application across ${cluster.subsystems.length} subsystem(s). ` +
                    `${subsystemNote}${filesNote}`;

            case 'multi_step_campaign':
                return `Multi-step repair campaign across ${cluster.subsystems.length} subsystem(s) ` +
                    `addressing '${cluster.dominantFailureType}'. ` +
                    `${subsystemNote}${filesNote}`;

            case 'escalate_human':
                return `Human review required. Cluster involves ${cluster.signalCount} signals ` +
                    `across ${cluster.subsystems.length} subsystem(s). ` +
                    `Top hypothesis: ${top?.category ?? 'none'}.${filesNote}`;

            case 'defer':
            default:
                return `Deferred. Cluster has ${cluster.signalCount} signals. ` +
                    `${subsystemNote} Re-evaluate after additional signals.`;
        }
    }
}
