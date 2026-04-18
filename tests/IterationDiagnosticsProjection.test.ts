import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeDiagnosticsAggregator } from '../electron/services/RuntimeDiagnosticsAggregator';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';

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
    });

    it('projects iteration budget, improvement, and blocked signals into planExecution diagnostics', () => {
        const aggregator = makeAggregator();
        const bus = TelemetryBus.getInstance();

        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_budget_resolved',
            payload: {
                maxIterations: 3,
                taskLoopDoctrineClass: 'retrieval_summarize_verify',
                reasonCodes: ['iteration_policy.retrieval_summary_verify'],
            },
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_started',
            payload: { iteration: 1 },
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_no_material_improvement',
            payload: {},
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_blocked_by_policy',
            payload: { blockedByApproval: true, blockedByPolicy: false },
        });
        bus.emit({
            executionId: 'loop-1',
            subsystem: 'planning',
            event: 'planning.loop_iteration_budget_exhausted',
            payload: {},
        });

        const snapshot = aggregator.getSnapshot();
        expect(snapshot.planExecution?.configuredMaxIterations).toBe(3);
        expect(snapshot.planExecution?.iterationsUsed).toBe(1);
        expect(snapshot.planExecution?.wastedIterationCount).toBe(1);
        expect(snapshot.planExecution?.approvalBlockedCount).toBe(1);
        expect(snapshot.planExecution?.budgetExhaustionCount).toBe(1);
        expect(snapshot.planExecution?.taskLoopDoctrineClass).toBe('retrieval_summarize_verify');
    });
});

