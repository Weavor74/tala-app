/**
 * RootCauseAnalyzer.ts — Phase 6 P6D
 *
 * Deterministic root cause analysis for incident clusters.
 *
 * For each cluster, generates up to MAX_ROOT_CAUSES_PER_CLUSTER candidate hypotheses.
 * Each hypothesis is scored using deterministic rules (no model calls).
 *
 * Scoring factors:
 *   1. signal_frequency (0–40): how many signals in the cluster (normalized to MAX_CLUSTER_SIZE)
 *   2. subsystem_spread (0–20): number of distinct subsystems implicated
 *   3. failure_consistency (0–20): fraction of signals with the same failureType
 *   4. recurrence (0–20): signals span > TEMPORAL_PROXIMITY_MS (pattern is not a one-time spike)
 *
 * Root cause category is determined by heuristic rules:
 *   - If >1 subsystem AND same failure_type → cross_subsystem_dependency
 *   - If sourceType is 'harmonization_drift' → structural_drift
 *   - If sourceType is 'governance_block' + frequency ≥ 3 → policy_boundary_gap
 *   - If sourceType is 'campaign_failure' → campaign_scope_mismatch
 *   - If same subsystem + same failure_type + high frequency → repeated_execution_error
 *   - Otherwise → unknown
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    IncidentCluster,
    CrossSystemSignal,
    RootCauseHypothesis,
    RootCauseScoringFactor,
    RootCauseCategory,
} from '../../../../shared/crossSystemTypes';
import { CROSS_SYSTEM_BOUNDS } from '../../../../shared/crossSystemTypes';
import { telemetry } from '../../TelemetryService';

// ─── Scoring weights ──────────────────────────────────────────────────────────

const WEIGHT_SIGNAL_FREQUENCY  = 0.40;
const WEIGHT_SUBSYSTEM_SPREAD  = 0.20;
const WEIGHT_FAILURE_CONSISTENCY = 0.20;
const WEIGHT_RECURRENCE        = 0.20;

// Max raw values (used for normalization)
const MAX_RAW_FREQUENCY        = CROSS_SYSTEM_BOUNDS.MAX_CLUSTER_SIZE;
const MAX_RAW_SUBSYSTEM_SPREAD = 5; // normalise against 5 distinct subsystems

// ─── RootCauseAnalyzer ────────────────────────────────────────────────────────

export class RootCauseAnalyzer {
    /**
     * Generates up to MAX_ROOT_CAUSES_PER_CLUSTER root cause hypotheses for the cluster.
     *
     * Hypotheses are sorted by score descending.
     * At most one hypothesis per distinct RootCauseCategory is generated.
     */
    analyze(
        cluster: IncidentCluster,
        signals: CrossSystemSignal[],
    ): RootCauseHypothesis[] {
        // Filter signals that belong to this cluster
        const clusterSignals = signals.filter(s => cluster.signalIds.includes(s.signalId));

        if (clusterSignals.length < CROSS_SYSTEM_BOUNDS.MIN_SIGNALS_TO_CLUSTER) {
            return [];
        }

        const seenCategories = new Set<RootCauseCategory>();
        const hypotheses: RootCauseHypothesis[] = [];

        // Primary hypothesis — category derived from dominant signals
        const primaryCategory = this._determineCategory(clusterSignals, cluster);
        const primaryScore = this._scoreHypothesis(primaryCategory, clusterSignals, cluster);
        const primaryFactors = this._scoringFactors(clusterSignals, cluster);

        hypotheses.push(this._buildHypothesis(
            cluster,
            clusterSignals,
            primaryCategory,
            primaryScore,
            primaryFactors,
        ));
        seenCategories.add(primaryCategory);

        // Secondary hypotheses — attempt additional categories if cap not reached
        const candidateCategories: RootCauseCategory[] = [
            'repeated_execution_error',
            'structural_drift',
            'policy_boundary_gap',
            'campaign_scope_mismatch',
            'cross_subsystem_dependency',
            'unknown',
        ];

        for (const category of candidateCategories) {
            if (hypotheses.length >= CROSS_SYSTEM_BOUNDS.MAX_ROOT_CAUSES_PER_CLUSTER) break;
            if (seenCategories.has(category)) continue;

            const score = this._scoreHypothesis(category, clusterSignals, cluster);
            // Only emit secondary hypotheses with meaningful evidence (score > 20)
            if (score <= 20) continue;

            const factors = this._scoringFactors(clusterSignals, cluster);
            hypotheses.push(this._buildHypothesis(cluster, clusterSignals, category, score, factors));
            seenCategories.add(category);
        }

        hypotheses.sort((a, b) => b.score - a.score);

        telemetry.operational(
            'autonomy',
            'operational',
            'debug',
            'RootCauseAnalyzer',
            `Root cause analysis for cluster ${cluster.clusterId}: ` +
            `${hypotheses.length} hypothesis(es) generated, ` +
            `top category=${hypotheses[0]?.category ?? 'none'} score=${hypotheses[0]?.score ?? 0}`,
        );

        return hypotheses;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Computes a 0–100 score for the given root cause category against this cluster.
     */
    private _scoreHypothesis(
        category: RootCauseCategory,
        signals: CrossSystemSignal[],
        cluster: IncidentCluster,
    ): number {
        const factors = this._scoringFactors(signals, cluster);
        const rawScore = factors.reduce((sum, f) => sum + f.contribution, 0);

        // Category-specific adjustment: boost the score if this category
        // aligns with the dominant signal patterns
        let adjustment = 0;
        const dominantSourceType = this._dominantSourceType(signals);

        if (category === 'structural_drift' && dominantSourceType === 'harmonization_drift') {
            adjustment = 10;
        }
        if (category === 'policy_boundary_gap' && dominantSourceType === 'governance_block') {
            adjustment = 10;
        }
        if (category === 'campaign_scope_mismatch' && dominantSourceType === 'campaign_failure') {
            adjustment = 10;
        }
        if (
            category === 'cross_subsystem_dependency' &&
            cluster.subsystems.length > 1 &&
            cluster.dominantFailureType !== ''
        ) {
            adjustment = 8;
        }
        if (
            category === 'repeated_execution_error' &&
            cluster.subsystems.length === 1 &&
            signals.length >= 3
        ) {
            adjustment = 8;
        }

        return Math.min(100, Math.round(rawScore + adjustment));
    }

    /**
     * Computes the four scoring factors for a cluster.
     */
    private _scoringFactors(
        signals: CrossSystemSignal[],
        cluster: IncidentCluster,
    ): RootCauseScoringFactor[] {
        const factors: RootCauseScoringFactor[] = [];

        // Factor 1: signal_frequency — normalised count of signals in the cluster
        const freqValue = Math.min(signals.length, MAX_RAW_FREQUENCY);
        const freqNormalized = freqValue / MAX_RAW_FREQUENCY;
        const freqContribution = freqNormalized * (WEIGHT_SIGNAL_FREQUENCY * 100);
        factors.push({
            factorName: 'signal_frequency',
            value: freqValue,
            weight: WEIGHT_SIGNAL_FREQUENCY,
            contribution: Math.round(freqContribution),
            rationale: `${signals.length} signal(s) in cluster (max ${MAX_RAW_FREQUENCY})`,
        });

        // Factor 2: subsystem_spread — normalised distinct subsystem count
        const spreadValue = Math.min(cluster.subsystems.length, MAX_RAW_SUBSYSTEM_SPREAD);
        const spreadNormalized = spreadValue / MAX_RAW_SUBSYSTEM_SPREAD;
        const spreadContribution = spreadNormalized * (WEIGHT_SUBSYSTEM_SPREAD * 100);
        factors.push({
            factorName: 'subsystem_spread',
            value: cluster.subsystems.length,
            weight: WEIGHT_SUBSYSTEM_SPREAD,
            contribution: Math.round(spreadContribution),
            rationale:
                `${cluster.subsystems.length} distinct subsystem(s): ${cluster.subsystems.join(', ')}`,
        });

        // Factor 3: failure_consistency — fraction of signals sharing the dominant failure type
        const dominantCount = signals.filter(
            s => s.failureType === cluster.dominantFailureType,
        ).length;
        const consistency = signals.length > 0 ? dominantCount / signals.length : 0;
        const consistencyContribution = consistency * (WEIGHT_FAILURE_CONSISTENCY * 100);
        factors.push({
            factorName: 'failure_consistency',
            value: Math.round(consistency * 100),
            weight: WEIGHT_FAILURE_CONSISTENCY,
            contribution: Math.round(consistencyContribution),
            rationale:
                `${dominantCount}/${signals.length} signals have failureType '${cluster.dominantFailureType}'`,
        });

        // Factor 4: recurrence — span of signals exceeds TEMPORAL_PROXIMITY_MS
        const firstMs = new Date(cluster.firstSeenAt).getTime();
        const lastMs = new Date(cluster.lastSeenAt).getTime();
        const spanMs = lastMs - firstMs;
        const recurrenceValue = spanMs > CROSS_SYSTEM_BOUNDS.TEMPORAL_PROXIMITY_MS ? 1 : 0;
        const recurrenceContribution = recurrenceValue * (WEIGHT_RECURRENCE * 100);
        factors.push({
            factorName: 'recurrence',
            value: recurrenceValue,
            weight: WEIGHT_RECURRENCE,
            contribution: Math.round(recurrenceContribution),
            rationale: recurrenceValue === 1
                ? `Signals span ${Math.round(spanMs / 60000)} min, exceeding ` +
                  `temporal proximity threshold (${CROSS_SYSTEM_BOUNDS.TEMPORAL_PROXIMITY_MS / 60000} min)`
                : `Signals are concentrated within the temporal proximity window`,
        });

        return factors;
    }

    /**
     * Determines the most likely root cause category for the cluster
     * using heuristic rules applied to the signal set.
     */
    private _determineCategory(
        signals: CrossSystemSignal[],
        cluster: IncidentCluster,
    ): RootCauseCategory {
        const dominantSourceType = this._dominantSourceType(signals);
        const harmonizationCount = signals.filter(s => s.sourceType === 'harmonization_drift').length;
        const governanceCount = signals.filter(s => s.sourceType === 'governance_block').length;
        const campaignCount = signals.filter(s => s.sourceType === 'campaign_failure').length;

        // harmonization_drift signals → structural_drift
        if (dominantSourceType === 'harmonization_drift' || harmonizationCount >= 2) {
            return 'structural_drift';
        }

        // governance_block with ≥3 occurrences → policy_boundary_gap
        if (dominantSourceType === 'governance_block' && governanceCount >= 3) {
            return 'policy_boundary_gap';
        }

        // campaign_failure → campaign_scope_mismatch
        if (dominantSourceType === 'campaign_failure' || campaignCount >= 2) {
            return 'campaign_scope_mismatch';
        }

        // >1 subsystem with same failureType → cross_subsystem_dependency
        if (cluster.subsystems.length > 1 && cluster.dominantFailureType !== '') {
            const consistencyHigh = signals.filter(
                s => s.failureType === cluster.dominantFailureType,
            ).length / signals.length > 0.5;
            if (consistencyHigh) return 'cross_subsystem_dependency';
        }

        // Same subsystem, same failure type, high frequency → repeated_execution_error
        if (
            cluster.subsystems.length === 1 &&
            cluster.dominantFailureType !== '' &&
            signals.length >= 3
        ) {
            return 'repeated_execution_error';
        }

        return 'unknown';
    }

    /**
     * Returns the sourceType that appears most frequently in the signal set.
     */
    private _dominantSourceType(signals: CrossSystemSignal[]): string {
        const counts: Record<string, number> = {};
        for (const s of signals) {
            counts[s.sourceType] = (counts[s.sourceType] ?? 0) + 1;
        }
        let best = '';
        let bestCount = 0;
        for (const [k, v] of Object.entries(counts)) {
            if (v > bestCount) { best = k; bestCount = v; }
        }
        return best;
    }

    /**
     * Assembles a complete RootCauseHypothesis from computed components.
     */
    private _buildHypothesis(
        cluster: IncidentCluster,
        signals: CrossSystemSignal[],
        category: RootCauseCategory,
        score: number,
        factors: RootCauseScoringFactor[],
    ): RootCauseHypothesis {
        const confidence = Math.min(1, score / 100);
        const description = this._describeCategory(category, cluster, signals);

        return {
            rootCauseId: `rc-${uuidv4()}`,
            clusterId: cluster.clusterId,
            category,
            description,
            score,
            scoringFactors: factors,
            confidence: Math.round(confidence * 100) / 100,
            subsystemsImplicated: [...cluster.subsystems],
            filesImplicated: [...cluster.sharedFiles],
            generatedAt: new Date().toISOString(),
            outcomeHistory: [],
        };
    }

    /**
     * Produces a non-vague, implementation-aware description for a category.
     */
    private _describeCategory(
        category: RootCauseCategory,
        cluster: IncidentCluster,
        signals: CrossSystemSignal[],
    ): string {
        const subsystemList = cluster.subsystems.join(', ') || 'unknown';
        const count = signals.length;

        switch (category) {
            case 'structural_drift':
                return `Harmonization drift detected across ${subsystemList}: ` +
                    `${count} signal(s) indicate structural inconsistency between files. ` +
                    `The harmonization canon may need to be updated or re-applied.`;

            case 'repeated_execution_error':
                return `The same execution failure ('${cluster.dominantFailureType}') ` +
                    `recurred ${count} time(s) in subsystem '${subsystemList}'. ` +
                    `A targeted repair of the affected files is likely required.`;

            case 'cross_subsystem_dependency':
                return `Failure type '${cluster.dominantFailureType}' propagated across ` +
                    `${cluster.subsystems.length} subsystems (${subsystemList}). ` +
                    `One subsystem's failure appears to be triggering failures in others.`;

            case 'policy_boundary_gap':
                return `Governance policy repeatedly blocked changes in ${subsystemList}. ` +
                    `${count} governance_block signal(s) suggest a policy constraint is ` +
                    `misaligned with the required changes.`;

            case 'campaign_scope_mismatch':
                return `Repair campaigns for ${subsystemList} failed ${count} time(s). ` +
                    `The campaign scope or step templates may be insufficient for ` +
                    `the underlying problem in '${cluster.dominantFailureType}'.`;

            case 'unknown':
            default:
                return `Cross-system pattern detected in ${subsystemList}: ` +
                    `${count} signal(s) with failure type '${cluster.dominantFailureType}'. ` +
                    `Insufficient evidence to classify the root cause category.`;
        }
    }
}
