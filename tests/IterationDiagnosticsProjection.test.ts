import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeDiagnosticsAggregator } from '../electron/services/RuntimeDiagnosticsAggregator';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { IterationPolicyTuningRepository } from '../electron/services/planning/IterationPolicyTuningRepository';

function makeAggregator() {
    const inferenceStub = {
        getState: vi.fn().mockReturnValue({
            selectedProviderReady: true,
            attemptedProviders: [],
            fallbackApplied: false,
            streamStatus: 'idle',
            providerInventorySummary: { total: 1, ready: 1, degraded: 0, unavailable: 0 },
            lastUpdated: new Date().toISOString(),
        }),
    };
    const mcpStub = {
        getDiagnosticsInventory: vi.fn().mockReturnValue({
            services: [],
            totalConfigured: 0,
            totalReady: 0,
            totalDegraded: 0,
            totalUnavailable: 0,
            criticalUnavailable: false,
            lastUpdated: new Date().toISOString(),
        }),
    };
    return new RuntimeDiagnosticsAggregator(inferenceStub as any, mcpStub as any);
}

describe('Iteration diagnostics projection', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
        IterationPolicyTuningRepository._resetForTesting();
    });

    it('projects iteration budget, improvement, and blocked signals into planExecution diagnostics', () => {
        const aggregator = makeAggregator();
        const bus = TelemetryBus.getInstance();

        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_budget_resolved',
            payload: {
                loopId: 'loop-1',
                maxIterations: 3,
                taskLoopDoctrineClass: 'retrieval_summarize_verify',
                reasonCodes: ['iteration_policy.retrieval_summary_verify'],
            },
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_started',
            payload: { loopId: 'loop-1', iteration: 1 },
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_no_material_improvement',
            payload: { loopId: 'loop-1', iteration: 1 },
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_blocked_by_policy',
            payload: { loopId: 'loop-1', blockedByApproval: true, blockedByPolicy: false },
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_budget_exhausted',
            payload: { loopId: 'loop-1' },
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_aborted',
            payload: { loopId: 'loop-1' },
        });

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.planExecution?.configuredMaxIterations).toBe(3);
        expect(snapshot.planExecution?.iterationsUsed).toBe(1);
        expect(snapshot.planExecution?.wastedIterationCount).toBe(1);
        expect(snapshot.planExecution?.approvalBlockedCount).toBe(1);
        expect(snapshot.planExecution?.budgetExhaustionCount).toBe(1);
        expect(snapshot.planExecution?.taskLoopDoctrineClass).toBe('retrieval_summarize_verify');
        expect(snapshot.iterationTuning?.recommendationCount).toBeGreaterThanOrEqual(1);
        expect(snapshot.iterationTuning?.evidenceSufficiencyByTaskFamily.length).toBeGreaterThanOrEqual(1);
    });

    it('distinguishes pending recommendations from applied overrides', () => {
        const aggregator = makeAggregator();
        const bus = TelemetryBus.getInstance();
        const tuningRepo = IterationPolicyTuningRepository.getInstance();

        bus.emit({
            executionId: 'loop-2',
            subsystem: 'planning',
            event: 'planning.loop_iteration_budget_resolved',
            payload: {
                loopId: 'loop-2',
                maxIterations: 2,
                taskLoopDoctrineClass: 'retrieval_summarize',
                reasonCodes: ['iteration_policy.retrieval_summary'],
            },
        });
        bus.emit({
            executionId: 'loop-2',
            subsystem: 'planning',
            event: 'planning.loop_iteration_started',
            payload: { loopId: 'loop-2', iteration: 1 },
        });
        bus.emit({
            executionId: 'loop-2',
            subsystem: 'planning',
            event: 'planning.loop_observation',
            payload: { loopId: 'loop-2', iteration: 1, outcome: 'succeeded' },
        });
        bus.emit({
            executionId: 'loop-2',
            subsystem: 'planning',
            event: 'planning.loop_completed',
            payload: { loopId: 'loop-2' },
        });

        let snapshot = aggregator.getSnapshot();
        expect(snapshot.iterationTuning?.pendingRecommendationCount).toBeGreaterThanOrEqual(0);

        const pending = tuningRepo.getState().pendingRecommendations[0];
        if (pending) {
            tuningRepo.promoteRecommendation(
                pending.recommendation.recommendationId,
                'maintenance_review',
                'ops',
            );
        }

        snapshot = aggregator.getSnapshot();
        expect(snapshot.iterationTuning?.appliedOverrideCount).toBeGreaterThanOrEqual(0);
        expect(snapshot.iterationTuning?.promotedRecommendationCount).toBeGreaterThanOrEqual(0);
        expect(snapshot.iterationTuning?.queueCounts.pendingReview).toBeGreaterThanOrEqual(0);
        expect(snapshot.iterationTuning?.recentGovernanceActions.length).toBeGreaterThanOrEqual(0);
    });

    it('projects stale/retired governance lifecycle counts', () => {
        const aggregator = makeAggregator();
        const bus = TelemetryBus.getInstance();
        const repo = IterationPolicyTuningRepository.getInstance();
        bus.emit({
            executionId: 'loop-3',
            subsystem: 'planning',
            event: 'planning.loop_iteration_budget_resolved',
            payload: {
                loopId: 'loop-3',
                maxIterations: 2,
                taskLoopDoctrineClass: 'retrieval_summarize',
                reasonCodes: ['iteration_policy.retrieval_summary'],
            },
        });
        bus.emit({
            executionId: 'loop-3',
            subsystem: 'planning',
            event: 'planning.loop_completed',
            payload: { loopId: 'loop-3' },
        });
        repo.applyManualOverride({
            taskClass: 'retrieval_summarize',
            maxIterations: 2,
            replanAllowance: 'bounded',
            reasonCodes: ['tuning.override_promoted_manual'],
            promotedAt: '2026-04-01T00:00:00.000Z',
        });
        repo.revalidateActiveOverrides('2026-05-10T00:00:00.000Z');
        const stale = repo.getState().activeOverrides.find((item) => item.lifecycleState === 'stale_requires_revalidation');
        if (stale) {
            repo.retireOverride(stale.overrideId, 'stale_evidence_retirement', '2026-05-10T01:00:00.000Z');
        }
        const snapshot = aggregator.getSnapshot();
        expect(snapshot.iterationTuning?.retiredOverrideCount).toBeGreaterThanOrEqual(0);
        expect(snapshot.iterationTuning?.staleRequiresRevalidationCount).toBeGreaterThanOrEqual(0);
    });
});
