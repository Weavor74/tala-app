import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RuntimeDiagnosticsAggregator } from '../electron/services/RuntimeDiagnosticsAggregator';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type {
    InferenceDiagnosticsState,
    McpInventoryDiagnostics,
} from '../shared/runtimeDiagnosticsTypes';

function inferenceState(): InferenceDiagnosticsState {
    return {
        selectedProviderReady: true,
        attemptedProviders: [],
        fallbackApplied: false,
        streamStatus: 'idle',
        providerInventorySummary: {
            total: 1,
            ready: 1,
            unavailable: 0,
            degraded: 0,
        },
        lastUpdated: new Date().toISOString(),
    };
}

function mcpState(): McpInventoryDiagnostics {
    return {
        services: [],
        totalConfigured: 0,
        totalReady: 0,
        totalDegraded: 0,
        totalUnavailable: 0,
        criticalUnavailable: false,
        lastUpdated: new Date().toISOString(),
    };
}

describe('Planning memory diagnostics projection', () => {
    let agg: RuntimeDiagnosticsAggregator;

    beforeEach(() => {
        TelemetryBus._resetForTesting();
        agg = new RuntimeDiagnosticsAggregator(
            { getState: () => inferenceState() } as any,
            { getDiagnosticsInventory: () => mcpState() },
        );
    });

    afterEach(() => {
        agg.dispose();
    });

    it('projects planning memory context and strategy selection into runtime diagnostics', () => {
        const bus = TelemetryBus.getInstance();
        bus.emit({
            executionId: 'goal-1',
            subsystem: 'planning',
            event: 'planning.memory_context_built',
            payload: {
                similarEpisodeCount: 4,
                reasonCodes: ['policy:verification_required'],
                knownFailurePatterns: ['timeout'],
                knownRecoveryPatterns: ['reroute'],
            },
        });
        bus.emit({
            executionId: 'goal-1',
            subsystem: 'planning',
            event: 'planning.strategy_selected',
            payload: {
                selectedLane: 'workflow',
                strategyFamily: 'deterministic_workflow',
                verificationDepth: 'elevated',
                confidence: 0.82,
                reasonCodes: ['memory:similar_task_preferred_strategy'],
            },
        });

        const snapshot = agg.getSnapshot('session-1');
        expect(snapshot.planningMemory).toBeDefined();
        expect(snapshot.planningMemory?.consulted).toBe(true);
        expect(snapshot.planningMemory?.similarEpisodeCount).toBe(4);
        expect(snapshot.planningMemory?.selectedStrategyFamily).toBe('deterministic_workflow');
        expect(snapshot.planningMemory?.selectedVerificationDepth).toBe('elevated');
        expect(snapshot.planningMemory?.dominantFailurePattern).toBe('timeout');
    });
});

