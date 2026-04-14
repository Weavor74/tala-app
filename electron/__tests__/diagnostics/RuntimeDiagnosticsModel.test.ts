/**
 * RuntimeDiagnosticsModel Tests â€” Priority 2A Objective A
 *
 * Validates the canonical runtime diagnostics types and the
 * RuntimeDiagnosticsAggregator snapshot shape.
 *
 * Coverage:
 * - Snapshot includes inference and MCP sections
 * - Normalized statuses are present and valid
 * - last-updated / last-failure fields propagate correctly
 * - Degraded subsystem detection works
 * - Recent failure summary aggregation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InferenceDiagnosticsService } from '../../services/InferenceDiagnosticsService';
import { RuntimeDiagnosticsAggregator } from '../../services/RuntimeDiagnosticsAggregator';
import type { McpInventoryDiagnostics, McpServiceDiagnostics } from '../../../shared/runtimeDiagnosticsTypes';

vi.mock('../../services/db/initMemoryStore', () => ({
    getLastDbHealth: () => ({
        reachable: true,
        authenticated: true,
        databaseExists: true,
        pgvectorInstalled: true,
        migrationsApplied: true,
    }),
}));

vi.mock('../../services/policy/PolicyGate', () => ({
    policyGate: {
        getActiveProfileId: () => 'test-profile',
    },
}));

// â”€â”€â”€ Mock McpLifecycleManager â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeEmptyMcpInventory(): McpInventoryDiagnostics {
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

function makeMockMcpLifecycle(inventory: McpInventoryDiagnostics = makeEmptyMcpInventory()) {
    return {
        getDiagnosticsInventory: vi.fn(() => inventory),
        getServiceDiagnostics: vi.fn((id: string) => inventory.services.find(s => s.serviceId === id) ?? null),
    };
}

// â”€â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('RuntimeDiagnosticsAggregator â€” snapshot shape', () => {
    let inferenceDiag: InferenceDiagnosticsService;

    beforeEach(() => {
        inferenceDiag = new InferenceDiagnosticsService();
    });

    it('returns a snapshot with inference and mcp sections', () => {
        const mcpLifecycle = makeMockMcpLifecycle();
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, mcpLifecycle as any);

        const snap = aggregator.getSnapshot('test-session');

        expect(snap).toHaveProperty('timestamp');
        expect(snap).toHaveProperty('sessionId', 'test-session');
        expect(snap).toHaveProperty('inference');
        expect(snap).toHaveProperty('mcp');
        expect(snap).toHaveProperty('degradedSubsystems');
        expect(snap).toHaveProperty('recentFailures');
        expect(snap).toHaveProperty('lastUpdatedPerSubsystem');
    });

    it('snapshot timestamp is a valid ISO string', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(new Date(snap.timestamp).toISOString()).toBe(snap.timestamp);
    });

    it('inference section has normalized streamStatus field', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(snap.inference.streamStatus).toBe('idle');
        expect(snap.inference.selectedProviderReady).toBe(false);
        expect(snap.inference.fallbackApplied).toBe(false);
        expect(snap.inference.attemptedProviders).toEqual([]);
    });

    it('mcp section has summary counts', () => {
        const inventory = makeEmptyMcpInventory();
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle(inventory) as any);
        const snap = aggregator.getSnapshot();
        expect(snap.mcp.totalConfigured).toBe(0);
        expect(snap.mcp.totalReady).toBe(0);
        expect(snap.mcp.services).toEqual([]);
    });

    it('degradedSubsystems is empty when all systems are healthy', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(snap.degradedSubsystems).toEqual([]);
    });

    it('lastUpdatedPerSubsystem includes inference and mcp keys', () => {
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(snap.lastUpdatedPerSubsystem).toHaveProperty('inference');
        expect(snap.lastUpdatedPerSubsystem).toHaveProperty('mcp');
    });
});

describe('RuntimeDiagnosticsAggregator â€” degraded subsystem detection', () => {
    it('marks inference as degraded when last stream failed', () => {
        const inferenceDiag = new InferenceDiagnosticsService();

        // Simulate a failed stream
        inferenceDiag.recordStreamResult({
            success: false,
            content: '',
            streamStatus: 'failed',
            fallbackApplied: false,
            attemptedProviders: ['ollama'],
            providerId: 'ollama',
            providerType: 'ollama',
            modelName: 'llama3',
            turnId: 'turn-1',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 5000,
            isPartial: false,
            errorCode: 'server_error',
            errorMessage: 'connection refused',
        });

        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(snap.degradedSubsystems).toContain('inference');
    });

    it('marks mcp as degraded when services are unavailable', () => {
        const inferenceDiag = new InferenceDiagnosticsService();

        const service: McpServiceDiagnostics = {
            serviceId: 'test-svc',
            displayName: 'Test Service',
            kind: 'stdio',
            enabled: true,
            status: 'unavailable',
            degraded: false,
            ready: false,
            restartCount: 2,
        };
        const inventory: McpInventoryDiagnostics = {
            ...makeEmptyMcpInventory(),
            services: [service],
            totalConfigured: 1,
            totalUnavailable: 1,
        };

        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle(inventory) as any);
        const snap = aggregator.getSnapshot();
        expect(snap.degradedSubsystems).toContain('mcp');
    });
});

describe('RuntimeDiagnosticsAggregator â€” failure summary', () => {
    it('failure summary is empty when no failures have occurred', () => {
        const inferenceDiag = new InferenceDiagnosticsService();
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(snap.recentFailures.count).toBe(0);
        expect(snap.recentFailures.failedEntityIds).toEqual([]);
    });

    it('failure summary includes inference failure', () => {
        const inferenceDiag = new InferenceDiagnosticsService();
        inferenceDiag.recordStreamResult({
            success: false,
            content: '',
            streamStatus: 'failed',
            fallbackApplied: false,
            attemptedProviders: ['ollama'],
            providerId: 'ollama',
            providerType: 'ollama',
            modelName: 'llama3',
            turnId: 'turn-1',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 100,
            isPartial: false,
            errorMessage: 'test error',
        });

        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(snap.recentFailures.count).toBeGreaterThan(0);
        expect(snap.recentFailures.lastFailureReason).toBe('test error');
    });

    it('failure summary includes MCP service failures', () => {
        const inferenceDiag = new InferenceDiagnosticsService();

        const service: McpServiceDiagnostics = {
            serviceId: 'svc-1',
            displayName: 'Service 1',
            kind: 'stdio',
            enabled: true,
            status: 'failed',
            degraded: false,
            ready: false,
            restartCount: 8,
            lastFailureReason: 'max retries exhausted',
            lastTransitionTime: new Date().toISOString(),
        };
        const inventory: McpInventoryDiagnostics = {
            ...makeEmptyMcpInventory(),
            services: [service],
            totalConfigured: 1,
            totalUnavailable: 1,
        };

        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle(inventory) as any);
        const snap = aggregator.getSnapshot();
        expect(snap.recentFailures.failedEntityIds).toContain('svc-1');
    });
});

describe('RuntimeDiagnosticsAggregator â€” status serialization', () => {
    it('snapshot is JSON-serializable without circular references', () => {
        const inferenceDiag = new InferenceDiagnosticsService();
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot('sess-1');
        expect(() => JSON.stringify(snap)).not.toThrow();
    });

    it('getInferenceStatus returns the inference state directly', () => {
        const inferenceDiag = new InferenceDiagnosticsService();
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const status = aggregator.getInferenceStatus();
        expect(status.streamStatus).toBe('idle');
        expect(status.selectedProviderReady).toBe(false);
    });

    it('getMcpStatus returns the mcp inventory directly', () => {
        const inventory = makeEmptyMcpInventory();
        const aggregator = new RuntimeDiagnosticsAggregator(new InferenceDiagnosticsService(), makeMockMcpLifecycle(inventory) as any);
        const status = aggregator.getMcpStatus();
        expect(status.totalConfigured).toBe(0);
        expect(Array.isArray(status.services)).toBe(true);
    });
});

describe('RuntimeDiagnosticsAggregator — degraded mode framework', () => {
    const markPrimaryProviderReady = (inferenceDiag: InferenceDiagnosticsService) => {
        inferenceDiag.updateFromInventory({
            selectedProviderId: 'primary',
            providers: [
                {
                    providerId: 'primary',
                    displayName: 'Primary',
                    providerType: 'ollama',
                    scope: 'local',
                    transport: 'http',
                    endpoint: 'http://localhost:11434',
                    configured: true,
                    detected: true,
                    ready: true,
                    health: 'healthy',
                    status: 'ready',
                    priority: 1,
                    capabilities: {
                        supportsStreaming: true,
                        supportsTools: true,
                        supportsVision: false,
                        supportsJsonMode: true,
                    },
                    models: ['llama3'],
                },
            ],
        } as any);
    };

    it('reports NORMAL mode when runtime is healthy', () => {
        const inferenceDiag = new InferenceDiagnosticsService();
        markPrimaryProviderReady(inferenceDiag);
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(snap.systemHealth.effective_mode).toBe('NORMAL');
        expect(snap.systemHealth.current_mode).toBe('NORMAL');
        expect(snap.systemHealth.mode_contract.mode).toBe('NORMAL');
    });

    it('reports DEGRADED_INFERENCE when inference fallback is active', () => {
        const inferenceDiag = new InferenceDiagnosticsService();
        inferenceDiag.recordStreamResult({
            success: true,
            content: 'ok',
            streamStatus: 'completed',
            fallbackApplied: true,
            attemptedProviders: ['primary', 'fallback'],
            providerId: 'fallback',
            providerType: 'ollama',
            modelName: 'llama3',
            turnId: 'turn-fallback',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 120,
            isPartial: false,
        });
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const snap = aggregator.getSnapshot();
        expect(snap.systemHealth.effective_mode).toBe('DEGRADED_INFERENCE');
        expect(snap.systemHealth.active_degradation_flags).toContain('DEGRADED_INFERENCE');
    });

    it('tracks deterministic mode transitions in snapshot history', () => {
        const inferenceDiag = new InferenceDiagnosticsService();
        markPrimaryProviderReady(inferenceDiag);
        const aggregator = new RuntimeDiagnosticsAggregator(inferenceDiag, makeMockMcpLifecycle() as any);
        const initial = aggregator.getSnapshot();
        expect(initial.systemHealth.recent_mode_transitions.length).toBe(0);

        inferenceDiag.recordStreamResult({
            success: true,
            content: 'ok',
            streamStatus: 'completed',
            fallbackApplied: true,
            attemptedProviders: ['primary', 'fallback'],
            providerId: 'fallback',
            providerType: 'ollama',
            modelName: 'llama3',
            turnId: 'turn-fallback',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 120,
            isPartial: false,
        });
        const degraded = aggregator.getSnapshot();
        expect(degraded.systemHealth.effective_mode).toBe('DEGRADED_INFERENCE');
        expect(degraded.systemHealth.recent_mode_transitions.length).toBe(1);
        expect(degraded.systemHealth.recent_mode_transitions[0]?.from_mode).toBe('NORMAL');
        expect(degraded.systemHealth.recent_mode_transitions[0]?.to_mode).toBe('DEGRADED_INFERENCE');
    });
});


