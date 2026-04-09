/**
 * MemoryOptimizationSuggestion.test.ts
 *
 * Unit tests for the human-gated optimization suggestion engine:
 *   - MemoryOptimizationSuggestionService (MOS01–MOS40)
 *
 * Covers:
 *   MOS01–MOS08  — Report structure and invariants
 *   MOS09–MOS14  — Provider tuning suggestions
 *   MOS15–MOS20  — Subsystem hardening suggestions
 *   MOS21–MOS26  — Replay policy suggestions
 *   MOS27–MOS30  — Scheduler cadence suggestions
 *   MOS31–MOS33  — Queue threshold suggestions
 *   MOS34–MOS36  — Escalation policy suggestions
 *   MOS37–MOS38  — Observability gap suggestions
 *   MOS39–MOS40  — Telemetry emission
 *
 * No real DB, no Electron.  All DB interactions are stubbed.
 * TelemetryBus is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Stub TelemetryBus
// ---------------------------------------------------------------------------

const emittedEvents: Array<{ event: string; payload?: Record<string, unknown> }> = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) =>
                emittedEvents.push(event as { event: string; payload?: Record<string, unknown> }),
            subscribe: vi.fn().mockReturnValue(vi.fn()),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { MemoryOptimizationSuggestionService } from '../electron/services/memory/MemoryOptimizationSuggestionService';
import { MemoryAdaptivePlanningService }        from '../electron/services/memory/MemoryAdaptivePlanningService';
import type {
    MemoryRepairInsightSummary,
    RecurringFailure,
    ActionEffectivenessEntry,
    EscalationCandidate,
} from '../shared/memory/MemoryRepairInsights';
import type { MemoryAdaptivePlan }               from '../shared/memory/MemoryAdaptivePlan';
import type {
    MemoryOptimizationSuggestionReport,
} from '../shared/memory/MemoryOptimizationSuggestion';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<MemoryRepairInsightSummary> = {}): MemoryRepairInsightSummary {
    return {
        windowHours: 24,
        generatedAt: new Date().toISOString(),
        totalCycles: 5,
        totalTriggers: 5,
        recurrentFailures: [],
        actionEffectiveness: [],
        queueBehavior: {
            totalReplays: 0,
            replaySuccesses: 0,
            replayFailures: 0,
            deadLetterCount: 0,
            deadLetterGrowing: false,
        },
        escalationCandidates: [],
        trajectories: [],
        ...overrides,
    };
}

function makeFailure(overrides: Partial<RecurringFailure> = {}): RecurringFailure {
    return {
        reason: 'mem0_unavailable',
        subsystem: 'mem0',
        occurrenceCount: 3,
        firstSeenAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
        lastSeenAt:  new Date(Date.now() - 2 * 3_600_000).toISOString(),
        recoversBetweenFailures: true,
        ...overrides,
    };
}

function makeAction(overrides: Partial<ActionEffectivenessEntry> = {}): ActionEffectivenessEntry {
    return {
        actionType: 'reconnect_mem0',
        totalExecutions: 5,
        successCount: 1,
        failureCount: 4,
        skipCount: 0,
        successRate: 0.2,
        ...overrides,
    };
}

function makeEscalation(
    code: EscalationCandidate['code'] = 'repeated_failure_reason',
    overrides: Record<string, unknown> = {},
): EscalationCandidate {
    return {
        code,
        description: `test escalation: ${code}`,
        evidence: { subsystem: 'mem0', reason: 'mem0_unavailable', occurrenceCount: 3, ...overrides },
        firstEvidenceAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastEvidenceAt:  new Date().toISOString(),
    };
}

function makePlan(
    summary: MemoryRepairInsightSummary,
    overrides: Partial<MemoryAdaptivePlan> = {},
): MemoryAdaptivePlan {
    const planner = new MemoryAdaptivePlanningService();
    return { ...planner.generatePlan(summary), ...overrides };
}

// ===========================================================================
// MemoryOptimizationSuggestionService — MOS01–MOS40
// ===========================================================================

describe('MemoryOptimizationSuggestionService', () => {
    let svc: MemoryOptimizationSuggestionService;

    beforeEach(() => {
        svc = new MemoryOptimizationSuggestionService();
        emittedEvents.length = 0;
    });

    // ── Report structure and invariants (MOS01–MOS08) ─────────────────────────

    // MOS01 — clean summary → empty suggestions
    it('MOS01: clean summary produces no suggestions except possibly observability_gap', () => {
        const summary = makeSummary({ totalCycles: 5, totalTriggers: 5 });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.every(s => s.category !== 'provider_tuning')).toBe(true);
        expect(report.suggestions.every(s => s.category !== 'subsystem_hardening')).toBe(true);
        expect(report.suggestions.every(s => s.category !== 'replay_policy')).toBe(true);
    });

    // MOS02 — report includes required top-level fields
    it('MOS02: report always has generatedAt, windowHours, suggestions, hasHighPrioritySuggestions, topLineSummary', () => {
        const summary = makeSummary();
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(typeof report.generatedAt).toBe('string');
        expect(report.windowHours).toBe(24);
        expect(Array.isArray(report.suggestions)).toBe(true);
        expect(typeof report.hasHighPrioritySuggestions).toBe('boolean');
        expect(typeof report.topLineSummary).toBe('string');
    });

    // MOS03 — suggestions are bounded by maxSuggestions
    it('MOS03: suggestions are capped by maxSuggestions', () => {
        const maxSuggestions = 3;
        const customSvc = new MemoryOptimizationSuggestionService({ maxSuggestions });

        const failures: RecurringFailure[] = [
            makeFailure({ subsystem: 'mem0',      reason: 'mem0_unavailable' }),
            makeFailure({ subsystem: 'canonical', reason: 'canonical_unavailable' }),
            makeFailure({ subsystem: 'graph',     reason: 'graph_projection_unavailable' }),
            makeFailure({ subsystem: 'rag',       reason: 'rag_logging_unavailable' }),
        ];
        const summary = makeSummary({
            recurrentFailures: failures,
            queueBehavior: {
                totalReplays: 10,
                replaySuccesses: 5,
                replayFailures: 5,
                deadLetterCount: 5,
                deadLetterGrowing: true,
            },
        });
        const plan = makePlan(summary);
        const report = customSvc.generateReport(summary, plan);

        expect(report.suggestions.length).toBeLessThanOrEqual(maxSuggestions);
    });

    // MOS04 — suggestions are ordered by priorityScore descending
    it('MOS04: suggestions are ordered by priorityScore descending', () => {
        const summary = makeSummary({
            recurrentFailures: [
                makeFailure({ subsystem: 'mem0',      reason: 'mem0_unavailable',      occurrenceCount: 10 }),
                makeFailure({ subsystem: 'canonical', reason: 'canonical_unavailable', occurrenceCount: 2 }),
            ],
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        for (let i = 0; i < report.suggestions.length - 1; i++) {
            expect(report.suggestions[i].priorityScore).toBeGreaterThanOrEqual(
                report.suggestions[i + 1].priorityScore,
            );
        }
    });

    // MOS05 — every suggestion has required fields
    it('MOS05: every suggestion has id, category, title, summary, rationale, severity, priorityScore, evidence, affectedSubsystems, generatedAt', () => {
        const summary = makeSummary({
            recurrentFailures: [makeFailure()],
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        for (const s of report.suggestions) {
            expect(typeof s.id).toBe('string');
            expect(s.id.length).toBeGreaterThan(0);
            expect(typeof s.category).toBe('string');
            expect(typeof s.title).toBe('string');
            expect(typeof s.summary).toBe('string');
            expect(typeof s.rationale).toBe('string');
            expect(['info','warning','error','critical']).toContain(s.severity);
            expect(typeof s.priorityScore).toBe('number');
            expect(s.priorityScore).toBeGreaterThanOrEqual(0);
            expect(s.priorityScore).toBeLessThanOrEqual(100);
            expect(typeof s.evidence).toBe('object');
            expect(Array.isArray(s.affectedSubsystems)).toBe(true);
            expect(typeof s.generatedAt).toBe('string');
        }
    });

    // MOS06 — priorityScore is always in [0, 100]
    it('MOS06: priorityScore is always in [0, 100]', () => {
        const summary = makeSummary({
            recurrentFailures: [makeFailure({ occurrenceCount: 999 })],
            escalationCandidates: [
                makeEscalation('repeated_failure_reason'),
                makeEscalation('repeated_cycle_failure'),
                makeEscalation('prolonged_degraded'),
                makeEscalation('growing_dead_letter_queue'),
            ],
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        for (const s of report.suggestions) {
            expect(s.priorityScore).toBeGreaterThanOrEqual(0);
            expect(s.priorityScore).toBeLessThanOrEqual(100);
        }
    });

    // MOS07 — hasHighPrioritySuggestions is true when critical or error severity present
    it('MOS07: hasHighPrioritySuggestions reflects critical or error severity', () => {
        // Force a high-score scenario: many occurrences + escalation
        const summary = makeSummary({
            recurrentFailures: [makeFailure({ occurrenceCount: 10,
                lastSeenAt: new Date().toISOString() })],
            escalationCandidates: [makeEscalation('repeated_failure_reason')],
        });
        const plan = makePlan(summary, {
            unstableSubsystems: ['mem0'],
        });
        const report = svc.generateReport(summary, plan);

        const hasErrorOrCritical = report.suggestions.some(
            s => s.severity === 'error' || s.severity === 'critical',
        );
        expect(report.hasHighPrioritySuggestions).toBe(hasErrorOrCritical);
    });

    // MOS08 — topLineSummary all-clear when no suggestions
    it('MOS08: topLineSummary is all-clear when suggestions is empty', () => {
        const summary = makeSummary({ totalCycles: 5, totalTriggers: 5 });
        const plan = makePlan(summary, {
            unstableSubsystems: [],
            cadence: {
                recommendation: 'normal',
                suggestedMultiplier: 1.0,
                reason: 'system stable',
                evidence: {},
            },
        });
        const report = svc.generateReport(summary, plan);

        if (report.suggestions.length === 0) {
            expect(report.topLineSummary).toContain('No optimization suggestions');
        } else {
            expect(report.topLineSummary.length).toBeGreaterThan(0);
        }
    });

    // ── Provider tuning suggestions (MOS09–MOS14) ─────────────────────────────

    // MOS09 — recurring failure below minFailureOccurrences → no provider_tuning suggestion
    it('MOS09: failure below minFailureOccurrences threshold → no provider_tuning suggestion', () => {
        const customSvc = new MemoryOptimizationSuggestionService({ minFailureOccurrences: 5 });
        const summary = makeSummary({
            recurrentFailures: [makeFailure({ occurrenceCount: 2 })],
        });
        const plan = makePlan(summary);
        const report = customSvc.generateReport(summary, plan);

        const providerSuggestions = report.suggestions.filter(s => s.category === 'provider_tuning');
        expect(providerSuggestions).toHaveLength(0);
    });

    // MOS10 — recurring failure at or above threshold → provider_tuning suggestion produced
    it('MOS10: recurring failure at minFailureOccurrences threshold → provider_tuning suggestion produced', () => {
        const summary = makeSummary({
            recurrentFailures: [makeFailure({ occurrenceCount: 2 })],
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        const providerSuggestions = report.suggestions.filter(s => s.category === 'provider_tuning');
        expect(providerSuggestions.length).toBeGreaterThanOrEqual(1);
    });

    // MOS11 — provider_tuning suggestion id is stable: 'provider_tuning:<subsystem>'
    it('MOS11: provider_tuning suggestion id is provider_tuning:<subsystem>', () => {
        const summary = makeSummary({
            recurrentFailures: [makeFailure({ subsystem: 'mem0' })],
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'provider_tuning');
        expect(s).toBeDefined();
        expect(s!.id).toBe('provider_tuning:mem0');
    });

    // MOS12 — low action effectiveness boosts provider_tuning score
    it('MOS12: low action effectiveness increases provider_tuning priorityScore', () => {
        const summaryBase = makeSummary({
            recurrentFailures: [makeFailure()],
            actionEffectiveness: [],
        });
        const summaryLow = makeSummary({
            recurrentFailures: [makeFailure()],
            actionEffectiveness: [makeAction({ successRate: 0.1 })],
        });

        const planBase = makePlan(summaryBase);
        const planLow  = makePlan(summaryLow);

        const reportBase = svc.generateReport(summaryBase, planBase);
        const reportLow  = svc.generateReport(summaryLow, planLow);

        const scoreBase = reportBase.suggestions.find(s => s.category === 'provider_tuning')?.priorityScore ?? 0;
        const scoreLow  = reportLow.suggestions.find(s => s.category === 'provider_tuning')?.priorityScore ?? 0;

        expect(scoreLow).toBeGreaterThan(scoreBase);
    });

    // MOS13 — escalated subsystem boosts provider_tuning score
    it('MOS13: unstableSubsystems flag boosts provider_tuning priorityScore', () => {
        const summaryNormal = makeSummary({ recurrentFailures: [makeFailure()] });
        const summaryEscalated = makeSummary({ recurrentFailures: [makeFailure()] });

        const planNormal    = makePlan(summaryNormal, { unstableSubsystems: [] });
        const planEscalated = makePlan(summaryEscalated, { unstableSubsystems: ['mem0'] });

        const reportNormal    = svc.generateReport(summaryNormal, planNormal);
        const reportEscalated = svc.generateReport(summaryEscalated, planEscalated);

        const scoreNormal    = reportNormal.suggestions.find(s => s.id === 'provider_tuning:mem0')?.priorityScore ?? 0;
        const scoreEscalated = reportEscalated.suggestions.find(s => s.id === 'provider_tuning:mem0')?.priorityScore ?? 0;

        expect(scoreEscalated).toBeGreaterThan(scoreNormal);
    });

    // MOS14 — provider_tuning evidence includes subsystem, reason, occurrenceCount
    it('MOS14: provider_tuning evidence includes subsystem, reason, occurrenceCount', () => {
        const failure = makeFailure({ subsystem: 'canonical', reason: 'canonical_unavailable', occurrenceCount: 4 });
        const summary = makeSummary({ recurrentFailures: [failure] });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.id === 'provider_tuning:canonical');
        expect(s).toBeDefined();
        expect(s!.evidence['subsystem']).toBe('canonical');
        expect(s!.evidence['reason']).toBe('canonical_unavailable');
        expect(s!.evidence['occurrenceCount']).toBe(4);
    });

    // ── Subsystem hardening suggestions (MOS15–MOS20) ─────────────────────────

    // MOS15 — no unstable subsystems in plan → no subsystem_hardening suggestion
    it('MOS15: no unstable subsystems → no subsystem_hardening suggestion', () => {
        const summary = makeSummary();
        const plan = makePlan(summary, { unstableSubsystems: [] });
        const report = svc.generateReport(summary, plan);

        const hardeningSuggestions = report.suggestions.filter(s => s.category === 'subsystem_hardening');
        expect(hardeningSuggestions).toHaveLength(0);
    });

    // MOS16 — unstable subsystems in plan → subsystem_hardening suggestion produced
    it('MOS16: unstable subsystem in plan → subsystem_hardening suggestion produced', () => {
        const summary = makeSummary({
            recurrentFailures: [makeFailure({ subsystem: 'graph', reason: 'graph_projection_unavailable' })],
            escalationCandidates: [makeEscalation('repeated_failure_reason', { subsystem: 'graph' })],
        });
        const plan = makePlan(summary, { unstableSubsystems: ['graph'] });
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'subsystem_hardening');
        expect(s).toBeDefined();
        expect(s!.id).toBe('subsystem_hardening:graph');
    });

    // MOS17 — subsystem_hardening affectedSubsystems contains the unstable subsystem
    it('MOS17: subsystem_hardening affectedSubsystems contains the flagged subsystem', () => {
        const summary = makeSummary();
        const plan = makePlan(summary, { unstableSubsystems: ['rag'] });
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.id === 'subsystem_hardening:rag');
        expect(s).toBeDefined();
        expect(s!.affectedSubsystems).toContain('rag');
    });

    // MOS18 — subsystem_hardening evidence includes occurrenceCount and escalationCount
    it('MOS18: subsystem_hardening evidence includes occurrenceCount and escalationCount', () => {
        const summary = makeSummary({
            recurrentFailures: [makeFailure({ subsystem: 'mem0', occurrenceCount: 5 })],
            escalationCandidates: [
                makeEscalation('repeated_failure_reason', { subsystem: 'mem0' }),
                makeEscalation('repeated_cycle_failure', { subsystem: 'mem0' }),
            ],
        });
        const plan = makePlan(summary, { unstableSubsystems: ['mem0'] });
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.id === 'subsystem_hardening:mem0');
        expect(s).toBeDefined();
        expect(s!.evidence['occurrenceCount']).toBe(5);
        expect(s!.evidence['escalationCount']).toBe(2);
    });

    // MOS19 — multiple unstable subsystems → one hardening suggestion per subsystem
    it('MOS19: two unstable subsystems → two subsystem_hardening suggestions', () => {
        const summary = makeSummary();
        const plan = makePlan(summary, { unstableSubsystems: ['mem0', 'canonical'] });
        const report = svc.generateReport(summary, plan);

        const ids = report.suggestions
            .filter(s => s.category === 'subsystem_hardening')
            .map(s => s.id);

        expect(ids).toContain('subsystem_hardening:mem0');
        expect(ids).toContain('subsystem_hardening:canonical');
    });

    // MOS20 — escalation bonus raises subsystem_hardening score
    it('MOS20: subsystem_hardening score is elevated when escalation candidates present', () => {
        const summaryNoEscalation = makeSummary();
        const summaryWithEscalation = makeSummary({
            escalationCandidates: [makeEscalation('repeated_failure_reason', { subsystem: 'mem0' })],
        });

        const planNo   = makePlan(summaryNoEscalation,   { unstableSubsystems: ['mem0'] });
        const planWith = makePlan(summaryWithEscalation, { unstableSubsystems: ['mem0'] });

        const reportNo   = svc.generateReport(summaryNoEscalation,   planNo);
        const reportWith = svc.generateReport(summaryWithEscalation, planWith);

        const scoreNo   = reportNo.suggestions.find(s => s.id === 'subsystem_hardening:mem0')?.priorityScore ?? 0;
        const scoreWith = reportWith.suggestions.find(s => s.id === 'subsystem_hardening:mem0')?.priorityScore ?? 0;

        expect(scoreWith).toBeGreaterThanOrEqual(scoreNo);
    });

    // ── Replay policy suggestions (MOS21–MOS26) ───────────────────────────────

    // MOS21 — no dead letters and no high failure rate → no replay_policy suggestion
    it('MOS21: no dead letters and low failure rate → no replay_policy suggestion', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 10,
                replaySuccesses: 10,
                replayFailures: 0,
                deadLetterCount: 0,
                deadLetterGrowing: false,
            },
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'replay_policy')).toHaveLength(0);
    });

    // MOS22 — dead letter count >= threshold → replay_policy suggestion
    it('MOS22: dead letter count at trigger threshold → replay_policy suggestion produced', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 5,
                replaySuccesses: 3,
                replayFailures: 2,
                deadLetterCount: 1,
                deadLetterGrowing: false,
            },
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'replay_policy').length).toBeGreaterThanOrEqual(1);
    });

    // MOS23 — growing dead-letter queue increases replay_policy score
    it('MOS23: growing dead-letter queue increases replay_policy priorityScore', () => {
        const summaryFlat = makeSummary({
            queueBehavior: {
                totalReplays: 5, replaySuccesses: 3, replayFailures: 2,
                deadLetterCount: 1, deadLetterGrowing: false,
            },
        });
        const summaryGrowing = makeSummary({
            queueBehavior: {
                totalReplays: 5, replaySuccesses: 3, replayFailures: 2,
                deadLetterCount: 1, deadLetterGrowing: true,
            },
        });

        const planFlat    = makePlan(summaryFlat);
        const planGrowing = makePlan(summaryGrowing);

        const reportFlat    = svc.generateReport(summaryFlat, planFlat);
        const reportGrowing = svc.generateReport(summaryGrowing, planGrowing);

        const scoreFlat    = reportFlat.suggestions.find(s => s.category === 'replay_policy')?.priorityScore ?? 0;
        const scoreGrowing = reportGrowing.suggestions.find(s => s.category === 'replay_policy')?.priorityScore ?? 0;

        expect(scoreGrowing).toBeGreaterThan(scoreFlat);
    });

    // MOS24 — high replay failure rate (with sufficient replays) → replay_policy suggestion
    it('MOS24: high replay failure rate with sufficient replays → replay_policy suggestion', () => {
        const customSvc = new MemoryOptimizationSuggestionService({
            minReplayExecutions: 3,
            highReplayFailureRateThreshold: 0.5,
            deadLetterTriggerCount: 999, // suppress dead-letter path
        });
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 10,
                replaySuccesses: 4,
                replayFailures: 6,
                deadLetterCount: 0,
                deadLetterGrowing: false,
            },
        });
        const plan = makePlan(summary);
        const report = customSvc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'replay_policy').length).toBeGreaterThanOrEqual(1);
    });

    // MOS25 — replay_policy evidence includes deadLetterCount, replayFailures, replayFailureRate
    it('MOS25: replay_policy evidence includes deadLetterCount, replayFailures, replayFailureRate', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 10,
                replaySuccesses: 5,
                replayFailures: 5,
                deadLetterCount: 3,
                deadLetterGrowing: false,
            },
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'replay_policy');
        expect(s).toBeDefined();
        expect(s!.evidence['deadLetterCount']).toBe(3);
        expect(s!.evidence['replayFailures']).toBe(5);
        expect(typeof s!.evidence['replayFailureRate']).toBe('number');
    });

    // MOS26 — replay_policy affectedSubsystems is empty (system-wide)
    it('MOS26: replay_policy affectedSubsystems is empty array (system-wide concern)', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 5, replaySuccesses: 0, replayFailures: 5,
                deadLetterCount: 2, deadLetterGrowing: true,
            },
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'replay_policy');
        expect(s).toBeDefined();
        expect(s!.affectedSubsystems).toHaveLength(0);
    });

    // ── Scheduler cadence suggestions (MOS27–MOS30) ───────────────────────────

    // MOS27 — normal cadence recommendation → no scheduler_cadence suggestion
    it('MOS27: normal cadence recommendation → no scheduler_cadence suggestion', () => {
        const summary = makeSummary();
        const plan = makePlan(summary, {
            cadence: {
                recommendation: 'normal',
                suggestedMultiplier: 1.0,
                reason: 'system stable',
                evidence: {},
            },
        });
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'scheduler_cadence')).toHaveLength(0);
    });

    // MOS28 — tighten cadence recommendation → scheduler_cadence suggestion produced
    it('MOS28: tighten cadence → scheduler_cadence suggestion with id scheduler_cadence:tighten', () => {
        const summary = makeSummary();
        const plan = makePlan(summary, {
            cadence: {
                recommendation: 'tighten',
                suggestedMultiplier: 0.5,
                reason: 'recurring failures detected',
                evidence: {},
            },
        });
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'scheduler_cadence');
        expect(s).toBeDefined();
        expect(s!.id).toBe('scheduler_cadence:tighten');
    });

    // MOS29 — relax cadence recommendation → scheduler_cadence suggestion produced
    it('MOS29: relax cadence → scheduler_cadence suggestion with id scheduler_cadence:relax', () => {
        const summary = makeSummary();
        const plan = makePlan(summary, {
            cadence: {
                recommendation: 'relax',
                suggestedMultiplier: 2.0,
                reason: 'system quiet',
                evidence: {},
            },
        });
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'scheduler_cadence');
        expect(s).toBeDefined();
        expect(s!.id).toBe('scheduler_cadence:relax');
    });

    // MOS30 — scheduler_cadence evidence includes cadenceRecommendation and suggestedMultiplier
    it('MOS30: scheduler_cadence evidence includes cadenceRecommendation and suggestedMultiplier', () => {
        const summary = makeSummary();
        const plan = makePlan(summary, {
            cadence: {
                recommendation: 'tighten',
                suggestedMultiplier: 0.5,
                reason: 'pressure detected',
                evidence: {},
            },
        });
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'scheduler_cadence');
        expect(s).toBeDefined();
        expect(s!.evidence['cadenceRecommendation']).toBe('tighten');
        expect(s!.evidence['suggestedMultiplier']).toBe(0.5);
    });

    // ── Queue threshold suggestions (MOS31–MOS33) ─────────────────────────────

    // MOS31 — non-growing dead-letter queue → no queue_thresholds suggestion
    it('MOS31: non-growing dead-letter queue → no queue_thresholds suggestion', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 5, replaySuccesses: 3, replayFailures: 2,
                deadLetterCount: 3, deadLetterGrowing: false,
            },
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'queue_thresholds')).toHaveLength(0);
    });

    // MOS32 — growing dead-letter + replay failures → queue_thresholds suggestion
    it('MOS32: growing dead-letter queue with replay failures → queue_thresholds suggestion', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 5, replaySuccesses: 2, replayFailures: 3,
                deadLetterCount: 5, deadLetterGrowing: true,
            },
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'queue_thresholds').length).toBeGreaterThanOrEqual(1);
    });

    // MOS33 — queue_thresholds evidence includes deadLetterGrowing and replayFailures
    it('MOS33: queue_thresholds evidence includes deadLetterGrowing and replayFailures', () => {
        const summary = makeSummary({
            queueBehavior: {
                totalReplays: 5, replaySuccesses: 2, replayFailures: 3,
                deadLetterCount: 5, deadLetterGrowing: true,
            },
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'queue_thresholds');
        expect(s).toBeDefined();
        expect(s!.evidence['deadLetterGrowing']).toBe(true);
        expect(s!.evidence['replayFailures']).toBe(3);
    });

    // ── Escalation policy suggestions (MOS34–MOS36) ───────────────────────────

    // MOS34 — few escalation candidates → no escalation_policy suggestion
    it('MOS34: 1 escalation candidate (below threshold 2) → no escalation_policy suggestion', () => {
        const summary = makeSummary({
            escalationCandidates: [makeEscalation('repeated_failure_reason')],
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'escalation_policy')).toHaveLength(0);
    });

    // MOS35 — enough escalation candidates → escalation_policy suggestion produced
    it('MOS35: 2+ escalation candidates → escalation_policy suggestion produced', () => {
        const summary = makeSummary({
            escalationCandidates: [
                makeEscalation('repeated_failure_reason'),
                makeEscalation('repeated_cycle_failure'),
            ],
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'escalation_policy').length).toBeGreaterThanOrEqual(1);
    });

    // MOS36 — escalation_policy evidence includes escalationCandidateCount and escalationCodes
    it('MOS36: escalation_policy evidence includes escalationCandidateCount and escalationCodes', () => {
        const summary = makeSummary({
            escalationCandidates: [
                makeEscalation('repeated_failure_reason'),
                makeEscalation('prolonged_degraded'),
            ],
        });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'escalation_policy');
        expect(s).toBeDefined();
        expect(s!.evidence['escalationCandidateCount']).toBe(2);
        expect(Array.isArray(s!.evidence['escalationCodes'])).toBe(true);
        expect((s!.evidence['escalationCodes'] as string[])).toContain('repeated_failure_reason');
    });

    // ── Observability gap suggestions (MOS37–MOS38) ───────────────────────────

    // MOS37 — no cycles and no triggers → observability_gap suggestion
    it('MOS37: no cycles and no triggers → observability_gap suggestion produced', () => {
        const summary = makeSummary({ totalCycles: 0, totalTriggers: 0 });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        const s = report.suggestions.find(s => s.category === 'observability_gap');
        expect(s).toBeDefined();
        expect(s!.id).toBe('observability_gap:no_events');
    });

    // MOS38 — cycles > 0 → no observability_gap suggestion
    it('MOS38: totalCycles > 0 → no observability_gap suggestion', () => {
        const summary = makeSummary({ totalCycles: 3, totalTriggers: 0 });
        const plan = makePlan(summary);
        const report = svc.generateReport(summary, plan);

        expect(report.suggestions.filter(s => s.category === 'observability_gap')).toHaveLength(0);
    });

    // ── Telemetry emission (MOS39–MOS40) ──────────────────────────────────────

    // MOS39 — generateReport emits memory.optimization_suggestions_generated
    it('MOS39: generateReport emits memory.optimization_suggestions_generated', () => {
        const summary = makeSummary();
        const plan = makePlan(summary);
        svc.generateReport(summary, plan);

        const event = emittedEvents.find(e => e.event === 'memory.optimization_suggestions_generated');
        expect(event).toBeDefined();
    });

    // MOS40 — emitted event payload includes suggestionCount, hasHighPrioritySuggestions, categories
    it('MOS40: emitted event payload includes suggestionCount, hasHighPrioritySuggestions, categories', () => {
        const summary = makeSummary({
            recurrentFailures: [makeFailure()],
        });
        const plan = makePlan(summary);
        svc.generateReport(summary, plan);

        const event = emittedEvents.find(e => e.event === 'memory.optimization_suggestions_generated');
        expect(event).toBeDefined();
        expect(typeof (event!.payload as Record<string, unknown>)['suggestionCount']).toBe('number');
        expect(typeof (event!.payload as Record<string, unknown>)['hasHighPrioritySuggestions']).toBe('boolean');
        expect(Array.isArray((event!.payload as Record<string, unknown>)['categories'])).toBe(true);
    });
});
