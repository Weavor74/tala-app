/**
 * RuntimeDiagnosticsModel Tests — Priority 2A Objective A
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

// ─── Mock McpLifecycleManager ─────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RuntimeDiagnosticsAggregator — snapshot shape', () => {
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

describe('RuntimeDiagnosticsAggregator — degraded subsystem detection', () => {
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

describe('RuntimeDiagnosticsAggregator — failure summary', () => {
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

describe('RuntimeDiagnosticsAggregator — status serialization', () => {
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
