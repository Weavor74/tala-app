/**
 * PlanningSnapshot.ts — Phase 2 Snapshot Model (P2C)
 *
 * Captures a single immutable snapshot of self-model data at the start
 * of each planning run and caches it for the duration of the run.
 *
 * CRITICAL RULE: No service within a planning run may query the self-model
 * independently.  All pipeline stages must read from the cached snapshot.
 * This prevents:
 *   - repeated expensive I/O across stages
 *   - inconsistency between stage inputs (snapshot drift)
 *   - rate-limit exhaustion on the self-model service
 *
 * Memoisation is keyed by runId.  Snapshot data is evicted when the run
 * completes so that memory does not accumulate across many runs.
 */

import type {
    PlanningRunSnapshot,
    SubsystemOwnershipRecord,
    TestInventory,
    BlastRadiusResult,
} from '../../../shared/reflectionPlanTypes';
import type { SelfModelQueryService } from '../selfModel/SelfModelQueryService';
import { telemetry } from '../TelemetryService';
import { v4 as uuidv4 } from 'uuid';

// ─── PlanningSnapshotCapture ──────────────────────────────────────────────────

export class PlanningSnapshotCapture {
    /** Per-run snapshot cache keyed by runId. */
    private cache: Map<string, PlanningRunSnapshot> = new Map();

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Returns the snapshot for the given run.
     *
     * On the first call for a run, queries the self-model ONCE and stores the
     * result.  All subsequent calls within the same run return the cached copy.
     *
     * @param runId       Planning run ID — used as the cache key.
     * @param subsystemId The subsystem being planned for (used for blast radius).
     * @param targetFiles Files the proposed change would touch.
     * @param query       Self-model query service (injected; NOT called more than once).
     */
    captureOnce(
        runId: string,
        subsystemId: string,
        targetFiles: string[],
        query: SelfModelQueryService,
    ): PlanningRunSnapshot {
        const cached = this.cache.get(runId);
        if (cached) {
            telemetry.operational(
                'planning',
                'planning.snapshot.cache_hit',
                'debug',
                'PlanningSnapshotCapture',
                `Run ${runId}: snapshot served from cache (no re-query)`,
            );
            return cached;
        }

        // ── Single self-model query ───────────────────────────────────────────
        const selfSnapshot = query.getSnapshot();

        const subsystemOwnership: SubsystemOwnershipRecord[] = selfSnapshot.ownershipMap.map(
            entry => ({
                subsystemId: entry.subsystem,
                primaryFiles: entry.primaryFile ? [entry.primaryFile] : [],
                secondaryFiles: [],
                layer: entry.layer,
                owner: entry.componentId,
            }),
        );

        const testInventory = this._buildTestInventory(selfSnapshot.components);

        // Compute initial blast radius using snapshot data only (deterministic)
        const blastRadiusInitial = this._computeBlastRadius(
            subsystemId,
            targetFiles,
            subsystemOwnership,
            selfSnapshot.invariants as import('../../../shared/selfModelTypes').SelfModelInvariant[],
        );

        const snapshot: PlanningRunSnapshot = {
            snapshotId: uuidv4(),
            runId,
            capturedAt: new Date().toISOString(),
            subsystemOwnership,
            invariants: selfSnapshot.invariants,
            capabilities: selfSnapshot.capabilities,
            components: selfSnapshot.components,
            blastRadiusInitial,
            tests: testInventory,
        };

        this.cache.set(runId, snapshot);

        telemetry.operational(
            'planning',
            'planning.snapshot.captured',
            'debug',
            'PlanningSnapshotCapture',
            `Run ${runId}: snapshot captured — ${selfSnapshot.invariants.length} invariants, ` +
                `${selfSnapshot.components.length} components`,
        );

        return snapshot;
    }

    /** Returns the cached snapshot for a run without triggering a capture. */
    getFromCache(runId: string): PlanningRunSnapshot | null {
        return this.cache.get(runId) ?? null;
    }

    /** Evicts the snapshot for a completed or failed run. */
    clearRun(runId: string): void {
        this.cache.delete(runId);
    }

    /**
     * Recomputes blast radius for a specific set of target files using the
     * already-captured snapshot (no additional self-model calls).
     *
     * This is the P2D entry point.  It operates purely on the snapshot data.
     */
    computeBlastRadius(
        runId: string,
        subsystemId: string,
        targetFiles: string[],
    ): BlastRadiusResult {
        const snapshot = this.cache.get(runId);
        if (!snapshot) {
            return this._emptyBlastRadius();
        }
        return this._computeBlastRadius(
            subsystemId,
            targetFiles,
            snapshot.subsystemOwnership,
            snapshot.invariants as import('../../../shared/selfModelTypes').SelfModelInvariant[],
        );
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Deterministic blast radius computation.
     *
     * Algorithm:
     * 1. Collect all subsystems whose owned files overlap with targetFiles.
     * 2. For each affected subsystem, expand to all files it owns.
     * 3. Check active invariants whose `enforcedBy` matches an affected subsystem.
     * 4. Derive risk tier from subsystem count + invariant coverage.
     * 5. Compute impact score (0–100) based on affected surface area.
     */
    private _computeBlastRadius(
        subsystemId: string,
        targetFiles: string[],
        ownership: SubsystemOwnershipRecord[],
        invariants: import('../../../shared/selfModelTypes').SelfModelInvariant[],
    ): BlastRadiusResult {
        const normalizedTargets = targetFiles.map(f => f.toLowerCase());

        // Step 1: find directly affected subsystems
        const affectedSubsystemIds = new Set<string>([subsystemId]);
        for (const record of ownership) {
            const allFiles = [...record.primaryFiles, ...record.secondaryFiles].map(f =>
                f.toLowerCase(),
            );
            if (allFiles.some(f => normalizedTargets.some(t => f.includes(t) || t.includes(f)))) {
                affectedSubsystemIds.add(record.subsystemId);
            }
        }

        // Step 2: expand to all files owned by affected subsystems
        const affectedFiles = new Set<string>(targetFiles);
        for (const record of ownership) {
            if (affectedSubsystemIds.has(record.subsystemId)) {
                record.primaryFiles.forEach(f => affectedFiles.add(f));
                record.secondaryFiles.forEach(f => affectedFiles.add(f));
            }
        }

        // Step 3: find threatened invariants
        const threatenedIds: string[] = [];
        const blockedBy: string[] = [];
        const activeInvariants = invariants.filter(inv => inv.status === 'active');

        for (const inv of activeInvariants) {
            if (inv.enforcedBy && affectedSubsystemIds.has(inv.enforcedBy)) {
                threatenedIds.push(inv.id);
                // Safety invariants block auto-promotion
                if (inv.category === 'safety' || inv.category === 'architectural') {
                    blockedBy.push(inv.id);
                }
            }
        }

        // Step 4: risk tier
        const subsystemCount = affectedSubsystemIds.size;
        const hasCriticalInvariant = blockedBy.length > 0;

        let invariantRisk: BlastRadiusResult['invariantRisk'];
        if (hasCriticalInvariant && subsystemCount >= 3) {
            invariantRisk = 'critical';
        } else if (hasCriticalInvariant) {
            invariantRisk = 'high';
        } else if (threatenedIds.length > 0 && subsystemCount >= 2) {
            invariantRisk = 'medium';
        } else if (threatenedIds.length > 0) {
            invariantRisk = 'low';
        } else {
            invariantRisk = 'none';
        }

        // Step 5: normalised impact score
        const subsystemScore = Math.min(subsystemCount * 10, 50);
        const fileScore = Math.min(affectedFiles.size * 2, 30);
        const invariantScore = Math.min(threatenedIds.length * 5, 20);
        const estimatedImpactScore = Math.min(subsystemScore + fileScore + invariantScore, 100);

        return {
            affectedSubsystems: Array.from(affectedSubsystemIds),
            affectedFiles: Array.from(affectedFiles),
            threatenedInvariantIds: threatenedIds,
            invariantRisk,
            estimatedImpactScore,
            blockedBy,
        };
    }

    /** Builds a lightweight test inventory from the component list. */
    private _buildTestInventory(
        components: import('../../../shared/selfModelTypes').SelfModelComponent[],
    ): TestInventory {
        const subsystems = new Set<string>();
        for (const c of components) {
            if (c.ownedBy) subsystems.add(c.ownedBy);
        }
        return {
            totalTests: 0, // populated by VerificationRequirementsEngine at runtime
            testFiles: [],
            coverageSubsystems: Array.from(subsystems),
        };
    }

    private _emptyBlastRadius(): BlastRadiusResult {
        return {
            affectedSubsystems: [],
            affectedFiles: [],
            threatenedInvariantIds: [],
            invariantRisk: 'none',
            estimatedImpactScore: 0,
            blockedBy: [],
        };
    }
}
