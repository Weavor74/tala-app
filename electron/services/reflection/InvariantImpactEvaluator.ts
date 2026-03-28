/**
 * InvariantImpactEvaluator.ts — Phase 2 P2D
 *
 * Blast Radius & Invariant Impact Evaluation.
 *
 * Operates entirely on the PlanningRunSnapshot — no self-model queries,
 * no file I/O, no model calls.  All analysis is deterministic.
 *
 * Responsibilities:
 * - Evaluate which invariants are at risk given a set of target files.
 * - Determine whether any invariant would be violated by the proposal.
 * - Annotate the blast radius with invariant-specific risk metadata.
 * - Produce a structured impact report for downstream stages.
 */

import type {
    PlanningRunSnapshot,
    BlastRadiusResult,
} from '../../../shared/reflectionPlanTypes';
import type { SelfModelInvariant } from '../../../shared/selfModelTypes';
import { telemetry } from '../TelemetryService';

// ─── Impact Report ────────────────────────────────────────────────────────────

export interface InvariantImpactDetail {
    invariantId: string;
    label: string;
    category: SelfModelInvariant['category'];
    /** Why this invariant is considered at risk. */
    riskReason: string;
    /** Whether this invariant fully blocks automatic promotion. */
    blocksAutoPromotion: boolean;
}

export interface InvariantImpactReport {
    runId: string;
    evaluatedAt: string;
    totalInvariantsChecked: number;
    threatenedCount: number;
    blockingCount: number;
    details: InvariantImpactDetail[];
    overallRisk: BlastRadiusResult['invariantRisk'];
    summary: string;
}

// ─── InvariantImpactEvaluator ─────────────────────────────────────────────────

export class InvariantImpactEvaluator {

    /**
     * Evaluates invariant impact for a proposed change.
     *
     * @param runId        Planning run ID (for telemetry only).
     * @param snapshot     Immutable snapshot captured at run start.
     * @param blastRadius  Pre-computed blast radius for the target change.
     * @param targetFiles  Files the proposal intends to modify.
     */
    evaluate(
        runId: string,
        snapshot: PlanningRunSnapshot,
        blastRadius: BlastRadiusResult,
        targetFiles: string[],
    ): InvariantImpactReport {
        const activeInvariants = snapshot.invariants.filter(
            inv => inv.status === 'active',
        ) as SelfModelInvariant[];

        const affectedSubsystemSet = new Set(blastRadius.affectedSubsystems);
        const affectedFileSet = new Set(
            [...blastRadius.affectedFiles, ...targetFiles].map(f => f.toLowerCase()),
        );

        const details: InvariantImpactDetail[] = [];

        for (const inv of activeInvariants) {
            const reason = this._assessRisk(inv, affectedSubsystemSet, affectedFileSet);
            if (!reason) continue;

            const blocksAutoPromotion =
                inv.category === 'safety' ||
                inv.category === 'architectural' ||
                blastRadius.blockedBy.includes(inv.id);

            details.push({
                invariantId: inv.id,
                label: inv.label,
                category: inv.category,
                riskReason: reason,
                blocksAutoPromotion,
            });
        }

        const blockingCount = details.filter(d => d.blocksAutoPromotion).length;
        const overallRisk = this._deriveOverallRisk(details.length, blockingCount, blastRadius);

        const report: InvariantImpactReport = {
            runId,
            evaluatedAt: new Date().toISOString(),
            totalInvariantsChecked: activeInvariants.length,
            threatenedCount: details.length,
            blockingCount,
            details,
            overallRisk,
            summary: this._buildSummary(details.length, blockingCount, overallRisk),
        };

        telemetry.operational(
            'planning',
            'planning.invariant_impact.evaluated',
            'debug',
            'InvariantImpactEvaluator',
            `Run ${runId}: ${details.length} threatened invariants, ${blockingCount} blocking`,
        );

        return report;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Returns a risk reason string if the invariant is at risk from the
     * proposed change, or null if it is not affected.
     */
    private _assessRisk(
        inv: SelfModelInvariant,
        affectedSubsystems: Set<string>,
        affectedFiles: Set<string>,
    ): string | null {
        // Invariant is at risk if its enforcer subsystem is in the blast radius
        if (inv.enforcedBy && affectedSubsystems.has(inv.enforcedBy)) {
            return `Enforcer subsystem '${inv.enforcedBy}' is within blast radius`;
        }

        // Invariant is at risk if its enforcer path overlaps with affected files
        if (inv.enforcedBy) {
            const enforcerNorm = inv.enforcedBy.toLowerCase();
            for (const f of affectedFiles) {
                if (f.includes(enforcerNorm) || enforcerNorm.includes(f)) {
                    return `Enforcer path '${inv.enforcedBy}' overlaps with affected file '${f}'`;
                }
            }
        }

        return null;
    }

    private _deriveOverallRisk(
        threatened: number,
        blocking: number,
        blast: BlastRadiusResult,
    ): BlastRadiusResult['invariantRisk'] {
        // Defer to the blast radius tier if it is already elevated
        if (blast.invariantRisk === 'critical') return 'critical';
        if (blocking >= 2) return 'critical';
        if (blocking === 1) return 'high';
        if (threatened >= 3) return 'medium';
        if (threatened >= 1) return 'low';
        return 'none';
    }

    private _buildSummary(
        threatened: number,
        blocking: number,
        risk: BlastRadiusResult['invariantRisk'],
    ): string {
        if (threatened === 0) return 'No invariants at risk.';
        const blockingNote = blocking > 0 ? ` (${blocking} blocking auto-promotion)` : '';
        return `${threatened} invariant(s) threatened — overall risk: ${risk}${blockingNote}.`;
    }
}
