/**
 * VerificationRequirementsEngine.ts — Phase 2 P2E
 *
 * Derives the minimum verification steps required before a proposal
 * can be promoted, based entirely on the blast radius and invariant
 * impact report.
 *
 * All decisions are deterministic — no model calls, no file I/O
 * beyond what is already present in the planning snapshot.
 */

import type {
    PlanningRunSnapshot,
    BlastRadiusResult,
    VerificationRequirements,
} from '../../../shared/reflectionPlanTypes';
import type { InvariantImpactReport } from './InvariantImpactEvaluator';
import { telemetry } from '../TelemetryService';

// ─── VerificationRequirementsEngine ──────────────────────────────────────────

export class VerificationRequirementsEngine {

    /**
     * Computes verification requirements for a proposal.
     *
     * @param runId        Planning run ID (for telemetry only).
     * @param snapshot     Immutable snapshot from run start.
     * @param blastRadius  Blast radius for the change.
     * @param impact       Invariant impact report.
     * @param targetFiles  Files to be modified.
     */
    compute(
        runId: string,
        snapshot: PlanningRunSnapshot,
        blastRadius: BlastRadiusResult,
        impact: InvariantImpactReport,
        targetFiles: string[],
    ): VerificationRequirements {
        const isHighRisk =
            blastRadius.invariantRisk === 'critical' || blastRadius.invariantRisk === 'high';
        const isAnyRisk = blastRadius.invariantRisk !== 'none';
        const hasSafetyOrArchitectural = impact.details.some(
            d => d.category === 'safety' || d.category === 'architectural',
        );

        const requiresBuild = isHighRisk || this._touchesMainProcess(targetFiles);
        const requiresTypecheck = isAnyRisk || this._touchesSharedTypes(targetFiles);
        const requiresLint = true; // always lint

        const requiredTests = this._selectRequiredTests(
            snapshot,
            blastRadius,
            targetFiles,
        );

        const smokeChecks = this._buildSmokeChecks(blastRadius, isHighRisk);

        const manualReviewRequired =
            impact.blockingCount > 0 ||
            hasSafetyOrArchitectural ||
            blastRadius.invariantRisk === 'critical';

        const estimatedDurationMs = this._estimateDuration(
            requiresBuild,
            requiresTypecheck,
            requiredTests.length,
            smokeChecks.length,
        );

        const req: VerificationRequirements = {
            requiresBuild,
            requiresTypecheck,
            requiresLint,
            requiredTests,
            smokeChecks,
            manualReviewRequired,
            estimatedDurationMs,
        };

        telemetry.operational(
            'planning',
            'planning.verification.computed',
            'debug',
            'VerificationRequirementsEngine',
            `Run ${runId}: build=${requiresBuild}, typecheck=${requiresTypecheck}, ` +
                `tests=${requiredTests.length}, manual=${manualReviewRequired}`,
        );

        return req;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _touchesMainProcess(files: string[]): boolean {
        return files.some(f =>
            f.includes('electron/') || f.includes('main.ts') || f.includes('preload'),
        );
    }

    private _touchesSharedTypes(files: string[]): boolean {
        return files.some(f => f.includes('shared/') || f.endsWith('Types.ts'));
    }

    private _selectRequiredTests(
        snapshot: PlanningRunSnapshot,
        blastRadius: BlastRadiusResult,
        targetFiles: string[],
    ): string[] {
        const tests = new Set<string>();

        // Include tests for affected subsystems
        for (const sub of blastRadius.affectedSubsystems) {
            // Map subsystem IDs to test file patterns
            const normalized = sub.toLowerCase().replace(/[^a-z0-9]/g, '');
            tests.add(`tests/${normalized}/**`);
            tests.add(`tests/*${normalized}*`);
        }

        // Include tests that explicitly cover modified files
        for (const file of targetFiles) {
            const base = file.replace(/\.[^.]+$/, '').replace(/.*\//, '');
            tests.add(`tests/${base}.test.ts`);
            tests.add(`tests/**/${base}.test.ts`);
        }

        // Always include IPC uniqueness test when reflection services change
        if (targetFiles.some(f => f.includes('ReflectionAppService'))) {
            tests.add('electron/__tests__/IpcChannelUniqueness.test.ts');
        }

        return Array.from(tests);
    }

    private _buildSmokeChecks(
        blastRadius: BlastRadiusResult,
        isHighRisk: boolean,
    ): string[] {
        const checks: string[] = [];

        if (blastRadius.affectedSubsystems.includes('inference')) {
            checks.push('npm run test -- tests/InferenceService.test.ts');
        }
        if (blastRadius.affectedSubsystems.includes('memory')) {
            checks.push('npm run test -- tests/MemoryService.test.ts');
        }
        if (isHighRisk) {
            checks.push('npm run typecheck');
            checks.push('npm run test -- tests/SystemVerification.test.ts');
        }

        return checks;
    }

    private _estimateDuration(
        requiresBuild: boolean,
        requiresTypecheck: boolean,
        testCount: number,
        smokeCount: number,
    ): number {
        let ms = 0;
        if (requiresBuild) ms += 60_000;     // ~1 min build
        if (requiresTypecheck) ms += 30_000; // ~30s typecheck
        ms += testCount * 5_000;             // ~5s per test pattern
        ms += smokeCount * 10_000;           // ~10s per smoke check
        return ms;
    }
}
