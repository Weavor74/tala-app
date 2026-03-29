/**
 * GoalDetectionEngine.ts — Phase 4 P4B / P4.2 Detection Coverage Expansion
 *
 * Detects candidate autonomous improvement goals from deterministic signal sources.
 *
 * Design principles:
 * - All detection is read-only; no writes during detection.
 * - Fully deterministic — no model calls.
 * - Deduplication against existing active goals via fingerprint matching.
 * - Polling-based (not event-driven) to prevent runaway triggers.
 *
 * Signal sources (P4B originals):
 *   1. Repeated execution failures  — queries ExecutionRunRegistry-compatible data
 *   2. Repeated governance blocks   — queries GovernanceAppService
 *   3. Stale/recurring reflection goals — queries existing GoalService
 *   4. Failed verifications         — any failed_verification run in window → candidate
 *
 * Signal sources added in P4.2:
 *   5. Telemetry anomaly            — ≥3 similar degraded metric samples in window
 *   6. Stale subsystem              — no activity for configured threshold (72h default)
 *   7. Weak coverage signal         — degraded/unavailable capabilities from self-model
 *   8. Unresolved backlog items     — non-user goals unactioned past age threshold
 *
 * Detection fingerprint: stable hash of (source + subsystemId + normalizedTitle)
 * Two candidates with the same fingerprint are the same logical problem.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    GoalCandidate,
    GoalSource,
    GoalSourceContext,
    WeakCoverageContext,
    BacklogGoalContext,
    RecurringReflectionGoalContext,
} from '../../../shared/autonomyTypes';
import type { ExecutionRun } from '../../../shared/executionTypes';
import { telemetry } from '../TelemetryService';

// ─── Internal signal types (not exported) ────────────────────────────────────

/** A metric that has been observed in a sustained degraded state. */
interface DegradedMetricSignal {
    metricName: string;
    subsystemId: string;
    observedValue: number;
    threshold: number;
    /** How many samples within the window were below threshold. */
    sampleCount: number;
    windowMs: number;
}

/** Last-known activity record for a subsystem. */
interface SubsystemActivityRecord {
    subsystemId: string;
    label?: string;
    /** ISO timestamp of last execution or planning activity, or undefined if never active. */
    lastActivityAt?: string;
}

/** A capability that is currently degraded or unavailable. */
interface DegradedCapabilitySignal {
    capabilityId: string;
    subsystemId: string;
    status: 'degraded' | 'unavailable';
    category?: string;
}

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

    // ── Optional P4.2 dependencies ────────────────────────────────────────────
    // All are optional for backward compatibility. When absent the corresponding
    // detector is skipped and returns an empty candidate list for that cycle.

    /**
     * Returns metrics currently observed in a sustained degraded state.
     * Must be backed by an in-process buffer — no disk I/O or network calls.
     */
    getDegradedMetrics?: (windowMs?: number) => DegradedMetricSignal[];

    /**
     * Returns known subsystems with their last recorded execution or planning activity.
     * Backed by SelfModelQueryService + ExecutionRunRegistry in-process state.
     */
    listSubsystemActivity?: () => SubsystemActivityRecord[];

    /**
     * Returns capabilities with degraded or unavailable status from CapabilityRegistry.
     * Each entry must include a subsystemId for grouping.
     */
    getDegradedCapabilities?: () => DegradedCapabilitySignal[];

    /**
     * Returns goals in a backlog/queued state for staleness analysis.
     * Distinct query from listReflectionGoals to allow independent threshold tuning.
     */
    listBacklogGoals?: () => Promise<any[]>;
}

// ─── Detection thresholds ─────────────────────────────────────────────────────

// Existing (P4B)
const EXECUTION_FAILURE_THRESHOLD = 3;                       // ≥3 failures in window
const GOVERNANCE_BLOCK_THRESHOLD = 2;                        // ≥2 blocks in window
const FAILED_VERIFICATION_THRESHOLD = 1;                     // ≥1 verification failure
const EXECUTION_FAILURE_WINDOW_MS = 4 * 60 * 60 * 1000;     // 4 hour window
const GOVERNANCE_BLOCK_WINDOW_MS = 8 * 60 * 60 * 1000;      // 8 hour window
const STALE_GOAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;          // 7 days (user_seeded staleness)
const RECURRING_GOAL_THRESHOLD = 2;                          // ≥2 occurrences of same title

// New (P4.2)
const TELEMETRY_ANOMALY_THRESHOLD = 3;                       // ≥3 degraded samples in window
const TELEMETRY_ANOMALY_WINDOW_MS = 30 * 60 * 1000;         // 30 minute window
const STALE_SUBSYSTEM_THRESHOLD_DAYS = 3;                    // 72 hours with no activity
const BACKLOG_STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days unactioned

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

        telemetry.operational(
            'autonomy',
            'autonomy_detection_cycle_started',
            'debug',
            'GoalDetectionEngine',
            'Detection cycle started',
        );

        const [
            execCandidates,
            govCandidates,
            reflectionCandidates,
            verificationCandidates,
            telemetryCandidates,
            staleCandidates,
            weakCoverageCandidates,
            backlogCandidates,
        ] = await Promise.all([
            this._detectExecutionFailures(activeFingerprints),
            this._detectGovernanceBlocks(activeFingerprints),
            this._detectStaleReflectionGoals(activeFingerprints),
            this._detectFailedVerifications(activeFingerprints),
            this._detectTelemetryAnomalies(activeFingerprints),
            this._detectStaleSubsystems(activeFingerprints),
            this._detectWeakCoverageSignals(activeFingerprints),
            this._detectUnresolvedBacklogItems(activeFingerprints),
        ]);

        candidates.push(
            ...execCandidates, ...govCandidates, ...reflectionCandidates, ...verificationCandidates,
            ...telemetryCandidates, ...staleCandidates, ...weakCoverageCandidates, ...backlogCandidates,
        );

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

    /**
     * Detects stale user-seeded goals (age-based) and recurring reflection goals
     * (recurrence-count-based).
     *
     * User-seeded: queued user goal older than STALE_GOAL_AGE_MS → user_seeded candidate.
     * Recurring: ≥RECURRING_GOAL_THRESHOLD queued non-user goals with the same
     * (category, title) → recurring_reflection_goal candidate with RecurringReflectionGoalContext.
     */
    private async _detectStaleReflectionGoals(
        activeFingerprints: Set<string>,
    ): Promise<GoalCandidate[]> {
        const candidates: GoalCandidate[] = [];
        try {
            const goals = await this.deps.listReflectionGoals();
            const cutoff = Date.now() - STALE_GOAL_AGE_MS;

            // ── User-seeded: age-based ──────────────────────────────────────────
            for (const g of goals) {
                if (g.status !== 'queued') continue;
                if (g.source !== 'user') continue;
                const created = new Date(g.createdAt).getTime();
                if (created > cutoff) continue;

                const subsystemId = g.category ?? 'general';
                const title = `Stale improvement goal: ${g.title}`;
                const fp = this.fingerprint('user_seeded', subsystemId, g.goalId);
                const isDuplicate = activeFingerprints.has(fp);

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'user_seeded',
                    subsystemId,
                    title,
                    description: g.description ?? g.title,
                    sourceContext: { kind: 'user_seeded', userNote: g.notes ?? '' },
                    dedupFingerprint: fp,
                    isDuplicate,
                });
            }

            // ── Recurring reflection goals: count-based grouping ────────────────
            // Group non-user queued goals by (category, title) to find repeated issues.
            const recurringGroups = new Map<string, any[]>();
            for (const g of goals) {
                if (g.status !== 'queued') continue;
                if (g.source === 'user') continue;
                const key = `${g.category ?? 'general'}::${g.title ?? ''}`;
                if (!recurringGroups.has(key)) recurringGroups.set(key, []);
                recurringGroups.get(key)!.push(g);
            }

            for (const [key, group] of recurringGroups) {
                if (group.length < RECURRING_GOAL_THRESHOLD) continue;

                // Sort by createdAt descending to get the most recent occurrence
                group.sort((a, b) =>
                    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
                );
                const mostRecent = group[0];
                const subsystemId = mostRecent.category ?? 'general';
                const normalizedTitle = mostRecent.title ?? key;
                const fp = this.fingerprint('recurring_reflection_goal', subsystemId, normalizedTitle);
                const isDuplicate = activeFingerprints.has(fp);

                const ctx: RecurringReflectionGoalContext = {
                    kind: 'recurring_reflection_goal',
                    recurrenceCount: group.length,
                    lastOccurrence: mostRecent.createdAt,
                };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'recurring_reflection_goal',
                    subsystemId,
                    title: `Recurring reflection goal: ${normalizedTitle}`,
                    description: `Goal '${normalizedTitle}' in subsystem '${subsystemId}' has appeared ${group.length} times without resolution.`,
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

    // ── Telemetry anomaly detection (P4.2B) ─────────────────────────────────────

    /**
     * Detects sustained telemetry degradation.
     * Requires deps.getDegradedMetrics to be provided; skips gracefully if absent.
     * Groups by (subsystemId, metricName) — one candidate per unique pair.
     */
    private _detectTelemetryAnomalies(
        activeFingerprints: Set<string>,
    ): GoalCandidate[] {
        const candidates: GoalCandidate[] = [];
        if (!this.deps.getDegradedMetrics) return candidates;
        try {
            const metrics = this.deps.getDegradedMetrics(TELEMETRY_ANOMALY_WINDOW_MS);
            for (const m of metrics) {
                if (m.sampleCount < TELEMETRY_ANOMALY_THRESHOLD) continue;

                const title = `Telemetry anomaly: ${m.metricName} in ${m.subsystemId}`;
                const fp = this.fingerprint('telemetry_anomaly', m.subsystemId, m.metricName);
                const isDuplicate = activeFingerprints.has(fp);

                const ctx: GoalSourceContext = {
                    kind: 'telemetry_anomaly',
                    metricName: m.metricName,
                    observedValue: m.observedValue,
                    threshold: m.threshold,
                    windowMs: m.windowMs,
                };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'telemetry_anomaly',
                    subsystemId: m.subsystemId,
                    title,
                    description: `Metric '${m.metricName}' in subsystem '${m.subsystemId}' has been degraded for ${m.sampleCount} samples in the last ${m.windowMs / 60000} minutes.`,
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
                `Telemetry anomaly detection error: ${err.message}`,
            );
        }
        return candidates;
    }

    // ── Stale subsystem detection (P4.2C) ───────────────────────────────────────

    /**
     * Detects subsystems with no recorded execution or planning activity for
     * STALE_SUBSYSTEM_THRESHOLD_DAYS. Uses a fixed title key ('stale') so the
     * fingerprint is stable per-subsystem across detection cycles.
     */
    private _detectStaleSubsystems(
        activeFingerprints: Set<string>,
    ): GoalCandidate[] {
        const candidates: GoalCandidate[] = [];
        if (!this.deps.listSubsystemActivity) return candidates;
        try {
            const records = this.deps.listSubsystemActivity();
            const now = Date.now();
            const thresholdMs = STALE_SUBSYSTEM_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

            for (const rec of records) {
                const lastMs = rec.lastActivityAt
                    ? new Date(rec.lastActivityAt).getTime()
                    : 0;
                const inactivityMs = now - lastMs;
                if (inactivityMs < thresholdMs) continue;

                const staleDays = Math.floor(inactivityMs / 86400000);
                const fp = this.fingerprint('stale_subsystem', rec.subsystemId, 'stale');
                const isDuplicate = activeFingerprints.has(fp);

                const ctx: GoalSourceContext = {
                    kind: 'stale_subsystem',
                    lastModifiedAt: rec.lastActivityAt,
                    staleDays,
                };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'stale_subsystem',
                    subsystemId: rec.subsystemId,
                    title: `Stale subsystem: ${rec.subsystemId}`,
                    description: `Subsystem '${rec.subsystemId}' has had no recorded activity for ${staleDays} days.`,
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
                `Stale subsystem detection error: ${err.message}`,
            );
        }
        return candidates;
    }

    // ── Weak coverage signal detection (P4.2D) ──────────────────────────────────

    /**
     * Detects subsystems with degraded or unavailable capabilities.
     * Groups by subsystemId — one candidate per subsystem with ≥1 degraded capability.
     * Fingerprint key is the sorted, comma-joined capability ID list; changes if the
     * degraded set changes (correct: new signal warrants new candidate).
     */
    private _detectWeakCoverageSignals(
        activeFingerprints: Set<string>,
    ): GoalCandidate[] {
        const candidates: GoalCandidate[] = [];
        if (!this.deps.getDegradedCapabilities) return candidates;
        try {
            const caps = this.deps.getDegradedCapabilities();
            const bySubsystem = new Map<string, DegradedCapabilitySignal[]>();
            for (const cap of caps) {
                if (!bySubsystem.has(cap.subsystemId)) bySubsystem.set(cap.subsystemId, []);
                bySubsystem.get(cap.subsystemId)!.push(cap);
            }

            for (const [subsystemId, degraded] of bySubsystem) {
                const ids = degraded.map(c => c.capabilityId).sort();
                const fp = this.fingerprint('weak_coverage_signal', subsystemId, ids.join(','));
                const isDuplicate = activeFingerprints.has(fp);

                const worstStatus = degraded.some(c => c.status === 'unavailable')
                    ? 'unavailable' as const
                    : 'degraded' as const;

                const ctx: WeakCoverageContext = {
                    kind: 'weak_coverage_signal',
                    testCount: degraded.length,
                    missingCoverageIndicators: ids,
                };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'weak_coverage_signal',
                    subsystemId,
                    title: `Weak coverage signal in ${subsystemId}`,
                    description: `${degraded.length} capability/capabilities ${worstStatus} in subsystem '${subsystemId}': ${ids.join(', ')}.`,
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
                `Weak coverage detection error: ${err.message}`,
            );
        }
        return candidates;
    }

    // ── Unresolved backlog item detection (P4.2E) ────────────────────────────────

    /**
     * Detects non-user goals that have been queued and unactioned past
     * BACKLOG_STALE_THRESHOLD_MS. Distinct from _detectStaleReflectionGoals:
     * uses a longer age threshold (14d vs 7d) and BacklogGoalContext.
     * User-seeded goals are handled by the user_seeded branch in
     * _detectStaleReflectionGoals and are excluded here.
     */
    private async _detectUnresolvedBacklogItems(
        activeFingerprints: Set<string>,
    ): Promise<GoalCandidate[]> {
        const candidates: GoalCandidate[] = [];
        if (!this.deps.listBacklogGoals) return candidates;
        try {
            const goals = await this.deps.listBacklogGoals();
            const cutoff = Date.now() - BACKLOG_STALE_THRESHOLD_MS;

            for (const g of goals) {
                if (g.status !== 'queued') continue;
                if (g.source === 'user') continue; // user goals → user_seeded source
                const created = new Date(g.createdAt).getTime();
                if (created > cutoff) continue;

                const subsystemId = g.category ?? 'general';
                const ageDays = Math.floor((Date.now() - created) / 86400000);
                const previousAttempts: number = typeof g.attemptCount === 'number'
                    ? g.attemptCount : 0;

                const fp = this.fingerprint('unresolved_backlog_item', subsystemId, g.goalId);
                const isDuplicate = activeFingerprints.has(fp);

                const ctx: BacklogGoalContext = {
                    kind: 'unresolved_backlog_item',
                    age: ageDays,
                    previousAttempts,
                };

                candidates.push({
                    candidateId: uuidv4(),
                    detectedAt: new Date().toISOString(),
                    source: 'unresolved_backlog_item',
                    subsystemId,
                    title: `Unresolved backlog item: ${g.title}`,
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
                `Backlog detection error: ${err.message}`,
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
