/**
 * GoalDetectionEngine.ts — Phase 4 P4B
 *
 * Detects candidate autonomous improvement goals from deterministic signal sources.
 *
 * Design principles:
 * - All detection is read-only; no writes during detection.
 * - Fully deterministic — no model calls.
 * - Deduplication against existing active goals via fingerprint matching.
 * - Polling-based (not event-driven) to prevent runaway triggers.
 *
 * Signal sources:
 *   1. Repeated execution failures  — queries ExecutionRunRegistry-compatible data
 *   2. Repeated governance blocks   — queries GovernanceAppService
 *   3. Stale reflection goals       — queries existing GoalService
 *   4. User-seeded goals            — promotes user goals from GoalService
 *   5. Failed verifications         — any failed_verification run in window → candidate
 *
 * Detection fingerprint: stable hash of (source + subsystemId + normalizedTitle)
 * Two candidates with the same fingerprint are the same logical problem.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    GoalCandidate,
    GoalSource,
    GoalSourceContext,
} from '../../../shared/autonomyTypes';
import type { ExecutionRun } from '../../../shared/executionTypes';
import { telemetry } from '../TelemetryService';

// ─── GoalDetectionEngine ──────────────────────────────────────────────────────

export interface GoalDetectionDependencies {
    /** Returns recent execution runs for failure analysis. */
    listRecentExecutionRuns: (windowMs?: number) => ExecutionRun[];
    /** Returns existing governance decisions for block analysis. */
    listGovernanceDecisions: (filter?: { status?: string }) => any[];
    /** Returns existing reflection goals (SelfImprovementGoal[]). */
    listReflectionGoals: () => Promise<any[]>;
    /** Returns the set of active/pending autonomous goal fingerprints for dedup. */
    getActiveGoalFingerprints: () => Set<string>;
}

// Detection thresholds
const EXECUTION_FAILURE_THRESHOLD = 3;       // ≥3 failures in window → candidate
const GOVERNANCE_BLOCK_THRESHOLD = 2;        // ≥2 blocks in window → candidate
const FAILED_VERIFICATION_THRESHOLD = 1;     // ≥1 verification failure in window → candidate
const EXECUTION_FAILURE_WINDOW_MS = 4 * 60 * 60 * 1000;  // 4 hour window
const GOVERNANCE_BLOCK_WINDOW_MS = 8 * 60 * 60 * 1000;   // 8 hour window
const STALE_GOAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;       // 7 days

export class GoalDetectionEngine {
    private pollTimer: NodeJS.Timeout | null = null;
    private _isRunning = false;

    constructor(
        private readonly deps: GoalDetectionDependencies,
        private readonly onCandidatesDetected: (candidates: GoalCandidate[]) => void,
    ) {}

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    start(intervalMs = 5 * 60 * 1000): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(async () => {
            if (this._isRunning) return; // prevent overlap
            this._isRunning = true;
            try {
                const candidates = await this.runOnce();
                if (candidates.length > 0) {
                    this.onCandidatesDetected(candidates);
                }
            } catch (err: any) {
                telemetry.operational(
                    'autonomy',
                    'operational',
                    'warn',
                    'GoalDetectionEngine',
                    `Detection cycle error: ${err.message}`,
                );
            } finally {
                this._isRunning = false;
            }
        }, intervalMs);
        if (this.pollTimer.unref) this.pollTimer.unref();
    }

    stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    // ── Detection ───────────────────────────────────────────────────────────────

    /**
     * Runs a single detection cycle across all signal sources.
     * Returns deduplicated GoalCandidate[] sorted by detected time.
     *
     * Safe to call from tests (no side effects).
     */
    async runOnce(): Promise<GoalCandidate[]> {
        const activeFingerprints = this.deps.getActiveGoalFingerprints();
        const candidates: GoalCandidate[] = [];

        const [execCandidates, govCandidates, reflectionCandidates, verificationCandidates] = await Promise.all([
            this._detectExecutionFailures(activeFingerprints),
            this._detectGovernanceBlocks(activeFingerprints),
            this._detectStaleReflectionGoals(activeFingerprints),
            this._detectFailedVerifications(activeFingerprints),
        ]);

        candidates.push(...execCandidates, ...govCandidates, ...reflectionCandidates, ...verificationCandidates);

        // Deduplicate across sources (same fingerprint → keep first)
        const seen = new Set<string>();
        const deduped: GoalCandidate[] = [];
        for (const c of candidates) {
            if (!seen.has(c.dedupFingerprint)) {
                seen.add(c.dedupFingerprint);
                deduped.push(c);
            } else {
                telemetry.operational(
                    'autonomy',
                    'autonomy_goal_deduped',
                    'debug',
                    'GoalDetectionEngine',
                    `Candidate '${c.title}' (${c.subsystemId}) deduped across sources`,
                );
            }
        }

        telemetry.operational(
            'autonomy',
            'autonomy_goal_detected',
            'debug',
            'GoalDetectionEngine',
            `Detection cycle complete: ${deduped.length} candidates (${candidates.length - deduped.length} deduped)`,
        );

        return deduped;
    }

    // ── Execution failure detection ─────────────────────────────────────────────

    private _detectExecutionFailures(
        activeFingerprints: Set<string>,
    ): GoalCandidate[] {
        const candidates: GoalCandidate[] = [];
        try {
            const runs = this.deps.listRecentExecutionRuns(EXECUTION_FAILURE_WINDOW_MS);
            const failedBySubsystem = new Map<string, ExecutionRun[]>();

            for (const run of runs) {
                if (run.status === 'aborted' || run.status === 'rolled_back' ||
                    run.status === 'failed_verification') {
                    const sub = run.subsystemId;
                    if (!failedBySubsystem.has(sub)) failedBySubsystem.set(sub, []);
                    failedBySubsystem.get(sub)!.push(run);
                }
            }

            for (const [subsystemId, failures] of failedBySubsystem) {
                if (failures.length < EXECUTION_FAILURE_THRESHOLD) continue;

                const title = `Repeated execution failures in ${subsystemId}`;
                const fp = this.fingerprint('repeated_execution_failure', subsystemId, title);
                const isDuplicate = activeFingerprints.has(fp);

                const lastRun = failures[0];
                const ctx: GoalSourceContext = {
                    kind: 'repeated_execution_failure',
                    failureCount: failures.length,
                    periodMs: EXECUTION_FAILURE_WINDOW_MS,
                    lastExecutionRunId: lastRun.executionId,
                    failureReason: lastRun.status,
                };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'repeated_execution_failure',
                    subsystemId,
                    title,
                    description: `${failures.length} execution failures detected in subsystem '${subsystemId}' within the last ${EXECUTION_FAILURE_WINDOW_MS / 60000} minutes.`,
                    sourceContext: ctx,
                    dedupFingerprint: fp,
                    isDuplicate,
                });
            }
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'GoalDetectionEngine',
                `Execution failure detection error: ${err.message}`,
            );
        }
        return candidates;
    }

    // ── Governance block detection ──────────────────────────────────────────────

    private _detectGovernanceBlocks(
        activeFingerprints: Set<string>,
    ): GoalCandidate[] {
        const candidates: GoalCandidate[] = [];
        try {
            const decisions = this.deps.listGovernanceDecisions({ status: 'blocked' });
            const cutoff = Date.now() - GOVERNANCE_BLOCK_WINDOW_MS;
            const recentBlocked = decisions.filter(
                d => new Date(d.createdAt).getTime() >= cutoff,
            );

            // Group by target subsystem
            const bySubsystem = new Map<string, typeof recentBlocked>();
            for (const d of recentBlocked) {
                const sub = d.proposalSnapshot?.targetSubsystem ?? 'unknown';
                if (!bySubsystem.has(sub)) bySubsystem.set(sub, []);
                bySubsystem.get(sub)!.push(d);
            }

            for (const [subsystemId, blocks] of bySubsystem) {
                if (blocks.length < GOVERNANCE_BLOCK_THRESHOLD) continue;

                const title = `Repeated governance blocks in ${subsystemId}`;
                const fp = this.fingerprint('repeated_governance_block', subsystemId, title);
                const isDuplicate = activeFingerprints.has(fp);

                const ctx: GoalSourceContext = {
                    kind: 'repeated_governance_block',
                    blockCount: blocks.length,
                    lastDecisionId: blocks[0].decisionId,
                };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'repeated_governance_block',
                    subsystemId,
                    title,
                    description: `${blocks.length} governance blocks detected for subsystem '${subsystemId}' within the last ${GOVERNANCE_BLOCK_WINDOW_MS / 3600000} hours. Human review may be needed.`,
                    sourceContext: ctx,
                    dedupFingerprint: fp,
                    isDuplicate,
                });
            }
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'GoalDetectionEngine',
                `Governance block detection error: ${err.message}`,
            );
        }
        return candidates;
    }

    // ── Failed verification detection ───────────────────────────────────────────

    /**
     * Detects subsystems that have had at least one failed_verification execution
     * run within the detection window.
     *
     * Distinct from _detectExecutionFailures: this source fires on any single
     * verification failure and produces a goal with source='failed_verification',
     * which maps to its own category policy and priority scoring.
     */
    private _detectFailedVerifications(
        activeFingerprints: Set<string>,
    ): GoalCandidate[] {
        const candidates: GoalCandidate[] = [];
        try {
            const runs = this.deps.listRecentExecutionRuns(EXECUTION_FAILURE_WINDOW_MS);
            const verificationFailsBySubsystem = new Map<string, ExecutionRun[]>();

            for (const run of runs) {
                if (run.status === 'failed_verification') {
                    const sub = run.subsystemId;
                    if (!verificationFailsBySubsystem.has(sub)) {
                        verificationFailsBySubsystem.set(sub, []);
                    }
                    verificationFailsBySubsystem.get(sub)!.push(run);
                }
            }

            for (const [subsystemId, failures] of verificationFailsBySubsystem) {
                if (failures.length < FAILED_VERIFICATION_THRESHOLD) continue;

                const title = `Verification failure in ${subsystemId}`;
                const fp = this.fingerprint('failed_verification', subsystemId, title);
                const isDuplicate = activeFingerprints.has(fp);

                const ctx: GoalSourceContext = {
                    kind: 'generic',
                    detail: `${failures.length} verification failure(s) in subsystem '${subsystemId}'. Last failing run: ${failures[0].executionId}.`,
                };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'failed_verification',
                    subsystemId,
                    title,
                    description: `${failures.length} verification failure(s) detected in subsystem '${subsystemId}' within the last ${EXECUTION_FAILURE_WINDOW_MS / 60000} minutes.`,
                    sourceContext: ctx,
                    dedupFingerprint: fp,
                    isDuplicate,
                });
            }
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'GoalDetectionEngine',
                `Verification failure detection error: ${err.message}`,
            );
        }
        return candidates;
    }

    // ── Stale reflection goal detection ────────────────────────────────────────

    private async _detectStaleReflectionGoals(
        activeFingerprints: Set<string>,
    ): Promise<GoalCandidate[]> {
        const candidates: GoalCandidate[] = [];
        try {
            const goals = await this.deps.listReflectionGoals();
            const cutoff = Date.now() - STALE_GOAL_AGE_MS;

            for (const g of goals) {
                if (g.status !== 'queued') continue;
                const created = new Date(g.createdAt).getTime();
                if (created > cutoff) continue; // Not stale yet

                const source: GoalSource = g.source === 'user'
                    ? 'user_seeded'
                    : 'recurring_reflection_goal';
                const subsystemId = g.category ?? 'general';
                const title = `Stale improvement goal: ${g.title}`;
                const fp = this.fingerprint(source, subsystemId, g.goalId);
                const isDuplicate = activeFingerprints.has(fp);

                const ctx: GoalSourceContext = source === 'user_seeded'
                    ? { kind: 'user_seeded', userNote: g.notes ?? '' }
                    : { kind: 'generic', detail: g.description };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source,
                    subsystemId,
                    title,
                    description: g.description ?? g.title,
                    sourceContext: ctx,
                    dedupFingerprint: fp,
                    isDuplicate,
                });
            }
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'GoalDetectionEngine',
                `Stale goal detection error: ${err.message}`,
            );
        }
        return candidates;
    }

    // ── Fingerprint ─────────────────────────────────────────────────────────────

    /**
     * Computes a stable deduplication fingerprint.
     * Deterministic: same inputs → same output.
     */
    fingerprint(source: GoalSource, subsystemId: string, title: string): string {
        const raw = `${source}::${subsystemId}::${title}`;
        // Simple FNV-1a hash (no crypto dep needed)
        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
    }
}
