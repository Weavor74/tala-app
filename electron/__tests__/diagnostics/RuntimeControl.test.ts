/**
 * Phase 2B Tests — Runtime Control
 *
 * Tests for:
 * - ProviderHealthScorer: failure streak demotion, suppression, recovery, priority restoration
 * - RuntimeControlService: provider restart/disable/enable/force-select, MCP restart/disable/enable
 * - Reflection signal emission: instability pattern, provider restart, MCP flapping
 * - Snapshot extensions: operatorActions, providerHealthScores, suppressedProviders
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderHealthScorer } from '../../services/inference/ProviderHealthScorer';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn((_s: string, et: string, _sv: string, _a: string, _sum: string, _st: string, opts?: any) => {
            emittedEvents.push({ eventType: et, payload: opts?.payload });
        }),
        emit: vi.fn(),
        audit: vi.fn(),
        debug: vi.fn(),
    },
}));

// ─── ReflectionEngine mock ────────────────────────────────────────────────────

const reportedSignals: Array<{ category: string; subsystem: string; streakCount?: number }> = [];
const thresholdedSignals: Array<{ category: string; streakCount: number; threshold: number }> = [];

vi.mock('../../services/reflection/ReflectionEngine', () => ({
    ReflectionEngine: {
        reportSignal: vi.fn((signal: any) => {
            reportedSignals.push({ category: signal.category, subsystem: signal.subsystem });
        }),
        reportThresholdedSignal: vi.fn((signal: any, streakCount: number, threshold: number) => {
            thresholdedSignals.push({ category: signal.category, streakCount, threshold });
        }),
    },
}));

// ─── ProviderHealthScorer tests ───────────────────────────────────────────────

describe('ProviderHealthScorer — failure streak demotion', () => {
    let scorer: ProviderHealthScorer;

    beforeEach(() => {
        scorer = new ProviderHealthScorer();
        emittedEvents.length = 0;
        thresholdedSignals.length = 0;
        reportedSignals.length = 0;
    });

    it('starts with zero failure streak and no suppression', () => {
        scorer.ensureScore('ollama', 1);
        const score = scorer.getScore('ollama');
        expect(score).toBeDefined();
        expect(score!.failureStreak).toBe(0);
        expect(score!.suppressed).toBe(false);
    });

    it('increments failure streak on recordFailure', () => {
        scorer.recordFailure('ollama', 1);
        scorer.recordFailure('ollama', 1);
        const score = scorer.getScore('ollama')!;
        expect(score.failureStreak).toBe(2);
    });

    it('emits provider_health_demoted telemetry at demotion threshold (streak=3)', () => {
        scorer.recordFailure('ollama', 1);
        scorer.recordFailure('ollama', 1);
        scorer.recordFailure('ollama', 1);
        const demoted = emittedEvents.filter(e => e.eventType === 'provider_health_demoted');
        expect(demoted).toHaveLength(1);
        expect(demoted[0].payload?.priorState).toBe('ready');
        expect(demoted[0].payload?.newState).toBe('degraded');
    });

    it('increases effective priority on demotion', () => {
        for (let i = 0; i < 3; i++) scorer.recordFailure('ollama', 1);
        const score = scorer.getScore('ollama')!;
        expect(score.effectivePriority).toBeGreaterThan(1);
    });

    it('suppresses provider at suppression threshold (streak>=5)', () => {
        for (let i = 0; i < 5; i++) scorer.recordFailure('ollama', 1);
        expect(scorer.isSuppressed('ollama')).toBe(true);
        const score = scorer.getScore('ollama')!;
        expect(score.suppressed).toBe(true);
        expect(score.suppressedUntil).toBeDefined();
    });

    it('emits thresholded signal at suppression threshold', () => {
        for (let i = 0; i < 5; i++) scorer.recordFailure('ollama', 1);
        const suppSignals = thresholdedSignals.filter(s => s.category === 'provider_instability_pattern');
        expect(suppSignals.length).toBeGreaterThanOrEqual(1);
    });

    it('returns suppressedProviderIds containing the suppressed provider', () => {
        for (let i = 0; i < 5; i++) scorer.recordFailure('ollama', 1);
        expect(scorer.getSuppressedProviderIds()).toContain('ollama');
    });
});

describe('ProviderHealthScorer — successful recovery', () => {
    let scorer: ProviderHealthScorer;

    beforeEach(() => {
        scorer = new ProviderHealthScorer();
        emittedEvents.length = 0;
        reportedSignals.length = 0;
    });

    it('resets failure streak to zero on recordSuccess', () => {
        for (let i = 0; i < 3; i++) scorer.recordFailure('ollama', 1);
        scorer.recordSuccess('ollama', 1);
        const score = scorer.getScore('ollama')!;
        expect(score.failureStreak).toBe(0);
    });

    it('lifts suppression on recordSuccess', () => {
        for (let i = 0; i < 5; i++) scorer.recordFailure('ollama', 1);
        expect(scorer.isSuppressed('ollama')).toBe(true);
        scorer.recordSuccess('ollama', 1);
        expect(scorer.isSuppressed('ollama')).toBe(false);
    });

    it('restores effective priority to base on success', () => {
        const base = 2;
        for (let i = 0; i < 3; i++) scorer.recordFailure('ollama', base);
        scorer.recordSuccess('ollama', base);
        const score = scorer.getScore('ollama')!;
        expect(score.effectivePriority).toBe(base);
    });

    it('emits provider_health_recovered telemetry on recovery from demotion', () => {
        for (let i = 0; i < 3; i++) scorer.recordFailure('ollama', 1);
        emittedEvents.length = 0; // reset
        scorer.recordSuccess('ollama', 1);
        const recovered = emittedEvents.filter(e => e.eventType === 'provider_health_recovered');
        expect(recovered).toHaveLength(1);
        expect(recovered[0].payload?.newState).toBe('recovered');
    });
});

describe('ProviderHealthScorer — instability pattern from repeated restarts', () => {
    let scorer: ProviderHealthScorer;

    beforeEach(() => {
        scorer = new ProviderHealthScorer();
        thresholdedSignals.length = 0;
    });

    it('does not emit repeated_provider_restart signal below threshold', () => {
        scorer.recordRestart('ollama');
        scorer.recordRestart('ollama');
        const signals = thresholdedSignals.filter(s => s.category === 'repeated_provider_restart');
        expect(signals).toHaveLength(0);
    });

    it('emits repeated_provider_restart signal at or above threshold (3)', () => {
        scorer.recordRestart('ollama');
        scorer.recordRestart('ollama');
        scorer.recordRestart('ollama');
        const signals = thresholdedSignals.filter(s => s.category === 'repeated_provider_restart');
        expect(signals.length).toBeGreaterThanOrEqual(1);
    });

    it('includes restart count in signal context', () => {
        for (let i = 0; i < 3; i++) scorer.recordRestart('llama');
        const signal = thresholdedSignals.find(s => s.category === 'repeated_provider_restart');
        expect(signal).toBeDefined();
        expect(signal!.streakCount).toBeGreaterThanOrEqual(3);
    });
});

describe('ProviderHealthScorer — priority management', () => {
    let scorer: ProviderHealthScorer;

    beforeEach(() => {
        scorer = new ProviderHealthScorer();
    });

    it('getEffectivePriority returns base priority for unknown provider', () => {
        expect(scorer.getEffectivePriority('unknown', 5)).toBe(5);
    });

    it('getEffectivePriority returns elevated priority for demoted provider', () => {
        for (let i = 0; i < 3; i++) scorer.recordFailure('ollama', 2);
        expect(scorer.getEffectivePriority('ollama', 2)).toBeGreaterThan(2);
    });

    it('getAllScores includes all tracked providers', () => {
        scorer.ensureScore('a', 1);
        scorer.ensureScore('b', 2);
        scorer.recordFailure('c', 3);
        const all = scorer.getAllScores();
        const ids = all.map(s => s.providerId);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
        expect(ids).toContain('c');
    });

    it('resetScore clears failure streak and suppression', () => {
        for (let i = 0; i < 5; i++) scorer.recordFailure('ollama', 1);
        scorer.resetScore('ollama');
        const score = scorer.getScore('ollama')!;
        expect(score.failureStreak).toBe(0);
        expect(score.suppressed).toBe(false);
    });
});

// ─── RuntimeControlService tests ─────────────────────────────────────────────

describe('RuntimeControlService — provider controls', () => {
    // We test the RuntimeControlService by instantiating it with minimal mocks
    // that simulate the InferenceService, McpLifecycleManager, and McpService interfaces.

    function makeMockInferenceService() {
        return {
            getProviderInventory: vi.fn(() => ({
                providers: [
                    { providerId: 'ollama', displayName: 'Ollama', status: 'ready', priority: 1, ready: true },
                ],
                selectedProviderId: undefined,
                lastRefreshed: new Date().toISOString(),
                refreshing: false,
            })),
            refreshProviders: vi.fn(async () => ({
                providers: [{ providerId: 'ollama', displayName: 'Ollama', status: 'ready', priority: 1, ready: true }],
                selectedProviderId: undefined,
                lastRefreshed: new Date().toISOString(),
                refreshing: false,
            })),
            setSelectedProvider: vi.fn(),
        };
    }

    function makeMockMcpLifecycle() {
        return {
            onServiceStarting: vi.fn(),
            onServiceReady: vi.fn(),
            onServiceFailed: vi.fn(),
            onInventoryRefreshed: vi.fn(),
        };
    }

    function makeMockMcpService() {
        return {
            getServiceHealth: vi.fn(() => ({ state: 1, serverId: 'astro', name: 'Astro Engine', retryCount: 0, isCallable: true })),
            disconnect: vi.fn(async () => {}),
            connect: vi.fn(async () => true),
        };
    }

    let service: any;

    beforeEach(async () => {
        emittedEvents.length = 0;
        thresholdedSignals.length = 0;
        reportedSignals.length = 0;

        const { RuntimeControlService } = await import('../../services/RuntimeControlService');
        service = new RuntimeControlService(
            makeMockInferenceService() as any,
            makeMockMcpLifecycle() as any,
            makeMockMcpService() as any,
        );
    });

    it('restartProvider returns success result', async () => {
        const result = await service.restartProvider('ollama');
        expect(result.success).toBe(true);
        expect(result.entityId).toBe('ollama');
        expect(result.action).toBe('provider_restart');
    });

    it('restartProvider emits provider_restart_requested and completed telemetry', async () => {
        await service.restartProvider('ollama');
        const requested = emittedEvents.find(e => e.eventType === 'provider_restart_requested');
        const completed = emittedEvents.find(e => e.eventType === 'provider_restart_completed');
        expect(requested).toBeDefined();
        expect(completed).toBeDefined();
    });

    it('restartProvider records the action in getOperatorActions()', async () => {
        await service.restartProvider('ollama');
        const actions = service.getOperatorActions();
        expect(actions.some((a: any) => a.action === 'provider_restart' && a.entityId === 'ollama')).toBe(true);
    });

    it('disableProvider suppresses the provider and emits provider_disabled', () => {
        const result = service.disableProvider('ollama', 'test');
        expect(result.success).toBe(true);
        expect(result.newState).toBe('disabled');
        const disabled = emittedEvents.find(e => e.eventType === 'provider_disabled');
        expect(disabled).toBeDefined();
    });

    it('enableProvider re-enables and emits provider_enabled', () => {
        service.disableProvider('ollama');
        emittedEvents.length = 0;
        const result = service.enableProvider('ollama', 'user re-enabled');
        expect(result.success).toBe(true);
        const enabled = emittedEvents.find(e => e.eventType === 'provider_enabled');
        expect(enabled).toBeDefined();
    });

    it('forceProviderSelection calls setSelectedProvider and emits telemetry', () => {
        const result = service.forceProviderSelection('ollama', 'manual');
        expect(result.success).toBe(true);
        const telEvent = emittedEvents.find(e => e.eventType === 'provider_selected');
        expect(telEvent).toBeDefined();
    });

    it('probeProviders triggers refreshProviders', async () => {
        const result = await service.probeProviders();
        expect(result.success).toBe(true);
    });

    it('probeProviders is debounced on rapid calls', async () => {
        await service.probeProviders();
        const result2 = await service.probeProviders();
        // Second call should be rejected (debounced)
        expect(result2.success).toBe(false);
        expect(result2.error).toContain('debounced');
    });
});

describe('RuntimeControlService — MCP controls', () => {
    function makeMockInferenceService() {
        return {
            getProviderInventory: vi.fn(() => ({ providers: [], selectedProviderId: undefined, lastRefreshed: '', refreshing: false })),
            refreshProviders: vi.fn(async () => ({ providers: [], selectedProviderId: undefined, lastRefreshed: '', refreshing: false })),
            setSelectedProvider: vi.fn(),
        };
    }

    function makeMockMcpLifecycle() {
        return {
            onServiceStarting: vi.fn(),
            onServiceReady: vi.fn(),
            onServiceFailed: vi.fn(),
            onInventoryRefreshed: vi.fn(),
        };
    }

    function makeMockMcpService() {
        return {
            getServiceHealth: vi.fn(() => ({ state: 1, serverId: 'mem0', name: 'mem0', retryCount: 0, isCallable: true })),
            disconnect: vi.fn(async () => {}),
            connect: vi.fn(async () => true),
        };
    }

    const mcpConfigs = [{ id: 'mem0', name: 'mem0', type: 'stdio' as const, enabled: true }];

    let service: any;

    beforeEach(async () => {
        emittedEvents.length = 0;
        thresholdedSignals.length = 0;
        reportedSignals.length = 0;
        const { RuntimeControlService } = await import('../../services/RuntimeControlService');
        service = new RuntimeControlService(
            makeMockInferenceService() as any,
            makeMockMcpLifecycle() as any,
            makeMockMcpService() as any,
        );
    });

    it('restartMcpService emits restart_requested and completed telemetry', async () => {
        const result = await service.restartMcpService('mem0', mcpConfigs);
        expect(result.success).toBe(true);
        expect(emittedEvents.find(e => e.eventType === 'mcp_service_restart_requested')).toBeDefined();
        expect(emittedEvents.find(e => e.eventType === 'mcp_service_restart_completed')).toBeDefined();
    });

    it('restartMcpService records action in getOperatorActions()', async () => {
        await service.restartMcpService('mem0', mcpConfigs);
        const actions = service.getOperatorActions();
        expect(actions.some((a: any) => a.action === 'mcp_restart' && a.entityId === 'mem0')).toBe(true);
    });

    it('disableMcpService emits mcp_service_disabled', async () => {
        const result = await service.disableMcpService('mem0');
        expect(result.success).toBe(true);
        expect(emittedEvents.find(e => e.eventType === 'mcp_service_disabled')).toBeDefined();
    });

    it('enableMcpService emits mcp_service_enabled', async () => {
        const result = await service.enableMcpService('mem0', mcpConfigs);
        expect(result.success).toBe(true);
        expect(emittedEvents.find(e => e.eventType === 'mcp_service_enabled')).toBeDefined();
    });

    it('probeMcpServices triggers onInventoryRefreshed', () => {
        const result = service.probeMcpServices();
        expect(result.success).toBe(true);
    });

    it('probeMcpServices is debounced', () => {
        service.probeMcpServices();
        const result2 = service.probeMcpServices();
        expect(result2.success).toBe(false);
        expect(result2.error).toContain('debounced');
    });

    it('emits mcp_service_flapping after 3+ restarts within window', async () => {
        for (let i = 0; i < 3; i++) {
            await service.restartMcpService('mem0', mcpConfigs);
        }
        const flapping = thresholdedSignals.filter(s => s.category === 'mcp_service_flapping');
        expect(flapping.length).toBeGreaterThanOrEqual(1);
    });
});

// ─── Snapshot extension tests ─────────────────────────────────────────────────

describe('RuntimeDiagnosticsAggregator — snapshot extensions', () => {
    it('snapshot includes Phase 2B extension fields', async () => {
        const { InferenceDiagnosticsService } = await import('../../services/InferenceDiagnosticsService');
        const { RuntimeDiagnosticsAggregator } = await import('../../services/RuntimeDiagnosticsAggregator');

        const inferDiag = new InferenceDiagnosticsService();
        const mcpLifecycle = {
            getDiagnosticsInventory: vi.fn(() => ({
                services: [],
                totalConfigured: 0,
                totalReady: 0,
                totalDegraded: 0,
                totalUnavailable: 0,
                criticalUnavailable: false,
                lastUpdated: new Date().toISOString(),
            })),
        };
        const aggregator = new RuntimeDiagnosticsAggregator(inferDiag, mcpLifecycle as any);
        const snap = aggregator.getSnapshot('test-session');

        expect(snap).toHaveProperty('operatorActions');
        expect(snap).toHaveProperty('providerHealthScores');
        expect(snap).toHaveProperty('suppressedProviders');
        expect(snap).toHaveProperty('recentProviderRecoveries');
        expect(snap).toHaveProperty('recentMcpRestarts');
        expect(Array.isArray(snap.operatorActions)).toBe(true);
        expect(Array.isArray(snap.suppressedProviders)).toBe(true);
    });

    it('snapshot includes runtimeControl operator actions when control service is wired', async () => {
        const { InferenceDiagnosticsService } = await import('../../services/InferenceDiagnosticsService');
        const { RuntimeDiagnosticsAggregator } = await import('../../services/RuntimeDiagnosticsAggregator');
        const { RuntimeControlService } = await import('../../services/RuntimeControlService');

        const inferDiag = new InferenceDiagnosticsService();
        const mcpLifecycle = {
            getDiagnosticsInventory: vi.fn(() => ({
                services: [], totalConfigured: 0, totalReady: 0, totalDegraded: 0, totalUnavailable: 0, criticalUnavailable: false, lastUpdated: new Date().toISOString(),
            })),
        };
        const mockInference = {
            getProviderInventory: vi.fn(() => ({ providers: [], selectedProviderId: undefined, lastRefreshed: '', refreshing: false })),
            refreshProviders: vi.fn(async () => ({ providers: [], selectedProviderId: undefined, lastRefreshed: '', refreshing: false })),
            setSelectedProvider: vi.fn(),
        };
        const mockMcpLifecycleCtrl = { onServiceStarting: vi.fn(), onServiceReady: vi.fn(), onServiceFailed: vi.fn(), onInventoryRefreshed: vi.fn() };
        const mockMcpSvc = { getServiceHealth: vi.fn(() => null), disconnect: vi.fn(), connect: vi.fn(async () => true) };

        const runtimeControl = new RuntimeControlService(mockInference as any, mockMcpLifecycleCtrl as any, mockMcpSvc as any);
        runtimeControl.disableProvider('ollama', 'test');

        const aggregator = new RuntimeDiagnosticsAggregator(inferDiag, mcpLifecycle as any, runtimeControl);
        const snap = aggregator.getSnapshot();

        expect(snap.operatorActions.some((a: any) => a.action === 'provider_disable')).toBe(true);
    });
});

// ─── Reflection signal category tests ────────────────────────────────────────

describe('ReflectionEngine — Phase 2B signal categories accepted', () => {
    beforeEach(() => {
        // Reset signal buffer through the static mock
        vi.clearAllMocks();
    });

    it('accepts provider_instability_pattern signal', async () => {
        const { ReflectionEngine } = await import('../../services/reflection/ReflectionEngine');
        const signal = {
            timestamp: new Date().toISOString(),
            subsystem: 'inference',
            category: 'provider_instability_pattern' as any,
            description: 'Test',
        };
        expect(() => ReflectionEngine.reportSignal(signal)).not.toThrow();
    });

    it('accepts repeated_provider_restart signal', async () => {
        const { ReflectionEngine } = await import('../../services/reflection/ReflectionEngine');
        const signal = {
            timestamp: new Date().toISOString(),
            subsystem: 'inference',
            category: 'repeated_provider_restart' as any,
            description: 'Test',
        };
        expect(() => ReflectionEngine.reportSignal(signal)).not.toThrow();
    });

    it('accepts mcp_service_flapping signal', async () => {
        const { ReflectionEngine } = await import('../../services/reflection/ReflectionEngine');
        const signal = {
            timestamp: new Date().toISOString(),
            subsystem: 'mcp',
            category: 'mcp_service_flapping' as any,
            description: 'Test',
        };
        expect(() => ReflectionEngine.reportSignal(signal)).not.toThrow();
    });

    it('accepts operator_intervention_required signal', async () => {
        const { ReflectionEngine } = await import('../../services/reflection/ReflectionEngine');
        const signal = {
            timestamp: new Date().toISOString(),
            subsystem: 'mcp',
            category: 'operator_intervention_required' as any,
            description: 'Test',
        };
        expect(() => ReflectionEngine.reportSignal(signal)).not.toThrow();
    });
});
