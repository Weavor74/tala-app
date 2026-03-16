/**
 * McpLifecycle Tests — Priority 2A Objective C & D
 *
 * Validates the McpLifecycleManager lifecycle state model and diagnostics
 * inventory projection.
 *
 * Coverage:
 * - starting → ready transition
 * - ready → degraded transition
 * - degraded → recovered transition
 * - unavailable / failed classification
 * - repeated instability metadata
 * - MCP lifecycle telemetry events emitted for major transitions
 * - Inventory auto-discovery from McpService health
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McpLifecycleManager } from '../../services/McpLifecycleManager';
import { ServerState } from '../../services/McpService';
import type { McpServiceHealth } from '../../services/McpService';

// ─── Telemetry mock ───────────────────────────────────────────────────────────

const emittedEvents: Array<{ eventType: string; severity: string; status: string }> = [];

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn((_s: string, et: string, sv: string, _a: string, _sum: string, st: string) => {
            emittedEvents.push({ eventType: et, severity: sv, status: st });
        }),
        emit: vi.fn(),
        audit: vi.fn(),
        debug: vi.fn(),
    },
}));

// ─── ReflectionEngine mock ────────────────────────────────────────────────────

const reportedSignals: Array<{ category: string; subsystem: string }> = [];

vi.mock('../../services/reflection/ReflectionEngine', () => ({
    ReflectionEngine: {
        reportSignal: vi.fn((signal: any) => {
            reportedSignals.push({ category: signal.category, subsystem: signal.subsystem });
        }),
        reportThresholdedSignal: vi.fn(),
    },
}));

// ─── McpService mock ──────────────────────────────────────────────────────────

function makeMockMcpService(healthMap: Record<string, McpServiceHealth> = {}) {
    return {
        getAllServiceHealth: vi.fn(() => Object.values(healthMap)),
        getServiceHealth: vi.fn((id: string) => healthMap[id] ?? null),
    };
}

function makeServiceHealth(overrides: Partial<McpServiceHealth> = {}): McpServiceHealth {
    return {
        serverId: 'test-svc',
        name: 'Test Service',
        state: ServerState.CONNECTED,
        retryCount: 0,
        lastRetryTime: Date.now(),
        isCallable: true,
        statusMessage: 'Service is ready and accepting tool calls.',
        ...overrides,
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearMocks() {
    emittedEvents.length = 0;
    reportedSignals.length = 0;
    vi.clearAllMocks();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpLifecycleManager — lifecycle transitions', () => {
    beforeEach(clearMocks);

    it('emits mcp_service_starting telemetry on onServiceStarting()', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onServiceStarting('svc-1');

        const starting = emittedEvents.filter(e => e.eventType === 'mcp_service_starting');
        expect(starting.length).toBeGreaterThan(0);
    });

    it('emits mcp_service_ready telemetry on onServiceReady()', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onServiceStarting('svc-1');
        clearMocks();
        manager.onServiceReady('svc-1');

        const ready = emittedEvents.filter(e => e.eventType === 'mcp_service_ready' || e.eventType === 'mcp_service_recovered');
        expect(ready.length).toBeGreaterThan(0);
        expect(ready[0].status).toBe('success');
    });

    it('emits mcp_service_degraded telemetry on onServiceDegraded()', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onServiceReady('svc-1');
        clearMocks();
        manager.onServiceDegraded('svc-1', 'health check failed');

        const degraded = emittedEvents.filter(e => e.eventType === 'mcp_service_degraded');
        expect(degraded.length).toBeGreaterThan(0);
        expect(degraded[0].status).toBe('failure');
    });

    it('emits mcp_service_recovered when recovering from degraded state', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onServiceDegraded('svc-1', 'test failure');
        clearMocks();
        manager.onServiceReady('svc-1');

        const recovered = emittedEvents.filter(e => e.eventType === 'mcp_service_recovered');
        expect(recovered.length).toBeGreaterThan(0);
    });

    it('emits mcp_service_unavailable telemetry on onServiceUnavailable()', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onServiceUnavailable('svc-1', 'endpoint unreachable');

        const unavailable = emittedEvents.filter(e => e.eventType === 'mcp_service_unavailable');
        expect(unavailable.length).toBeGreaterThan(0);
    });

    it('emits mcp_service_failed and reports reflection signal on onServiceFailed()', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onServiceFailed('svc-1', 'max retries exhausted', 8);

        const failed = emittedEvents.filter(e => e.eventType === 'mcp_service_failed');
        expect(failed.length).toBeGreaterThan(0);
        expect(failed[0].status).toBe('failure');

        expect(reportedSignals.some(s => s.category === 'mcp_instability')).toBe(true);
    });

    it('increments restartCount on onServiceRecovering()', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onServiceRecovering('svc-1');
        manager.onServiceRecovering('svc-1');

        // Check inventory shows restart count
        const health = makeServiceHealth({ serverId: 'svc-1', state: ServerState.DEGRADED });
        const mcpWithHealth = makeMockMcpService({ 'svc-1': health });
        const manager2 = new McpLifecycleManager(mcpWithHealth as any);
        manager2.registerService('svc-1', 'My Service', 'stdio', true);
        manager2.onServiceRecovering('svc-1');
        manager2.onServiceRecovering('svc-1');

        const inv = manager2.getDiagnosticsInventory();
        const svc = inv.services.find(s => s.serviceId === 'svc-1');
        expect(svc?.restartCount).toBe(2);
    });
});

describe('McpLifecycleManager — diagnostics inventory', () => {
    beforeEach(clearMocks);

    it('returns empty inventory when no services are tracked', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        const inv = manager.getDiagnosticsInventory();
        expect(inv.totalConfigured).toBe(0);
        expect(inv.services).toEqual([]);
    });

    it('includes registered services in inventory', () => {
        const health = makeServiceHealth({ serverId: 'svc-1', state: ServerState.CONNECTED });
        const mcp = makeMockMcpService({ 'svc-1': health });
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);

        const inv = manager.getDiagnosticsInventory();
        expect(inv.totalConfigured).toBe(1);
        const svc = inv.services.find(s => s.serviceId === 'svc-1');
        expect(svc).toBeDefined();
        expect(svc?.ready).toBe(true);
        expect(svc?.status).toBe('ready');
    });

    it('marks service as degraded in inventory when state is DEGRADED', () => {
        const health = makeServiceHealth({ serverId: 'svc-1', state: ServerState.DEGRADED, isCallable: false });
        const mcp = makeMockMcpService({ 'svc-1': health });
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);

        const inv = manager.getDiagnosticsInventory();
        const svc = inv.services.find(s => s.serviceId === 'svc-1');
        expect(svc?.degraded).toBe(true);
        expect(svc?.ready).toBe(false);
        expect(svc?.status).toBe('degraded');
    });

    it('marks service as failed in inventory when state is FAILED', () => {
        const health = makeServiceHealth({ serverId: 'svc-1', state: ServerState.FAILED, isCallable: false });
        const mcp = makeMockMcpService({ 'svc-1': health });
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);

        const inv = manager.getDiagnosticsInventory();
        const svc = inv.services.find(s => s.serviceId === 'svc-1');
        expect(svc?.status).toBe('failed');
        expect(svc?.ready).toBe(false);
    });

    it('marks disabled service correctly', () => {
        const health = makeServiceHealth({ serverId: 'svc-1', state: ServerState.DISABLED, isCallable: false });
        const mcp = makeMockMcpService({ 'svc-1': health });
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', false);

        const inv = manager.getDiagnosticsInventory();
        const svc = inv.services.find(s => s.serviceId === 'svc-1');
        expect(svc?.status).toBe('disabled');
        expect(svc?.enabled).toBe(false);
    });

    it('computes summary counts correctly', () => {
        const healthMap = {
            'svc-ready': makeServiceHealth({ serverId: 'svc-ready', state: ServerState.CONNECTED }),
            'svc-degraded': makeServiceHealth({ serverId: 'svc-degraded', state: ServerState.DEGRADED }),
            'svc-failed': makeServiceHealth({ serverId: 'svc-failed', state: ServerState.FAILED }),
        };
        const mcp = makeMockMcpService(healthMap);
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-ready', 'Service A', 'stdio', true);
        manager.registerService('svc-degraded', 'Service B', 'stdio', true);
        manager.registerService('svc-failed', 'Service C', 'stdio', true);

        const inv = manager.getDiagnosticsInventory();
        expect(inv.totalConfigured).toBe(3);
        expect(inv.totalReady).toBe(1);
        expect(inv.totalDegraded).toBe(1);
        expect(inv.totalUnavailable).toBe(1);
    });
});

describe('McpLifecycleManager — auto-discovery', () => {
    beforeEach(clearMocks);

    it('auto-discovers services from McpService health in syncFromService()', () => {
        const health = makeServiceHealth({ serverId: 'auto-svc', name: 'Auto Service', state: ServerState.CONNECTED });
        const mcp = makeMockMcpService({ 'auto-svc': health });
        const manager = new McpLifecycleManager(mcp as any);

        // Don't manually register — let syncFromService discover it
        manager.syncFromService();

        const inv = manager.getDiagnosticsInventory();
        expect(inv.services.some(s => s.serviceId === 'auto-svc')).toBe(true);
    });

    it('auto-discovers services in getDiagnosticsInventory() for health-only services', () => {
        const health = makeServiceHealth({ serverId: 'discovered', name: 'Discovered', state: ServerState.CONNECTED });
        const mcp = makeMockMcpService({ 'discovered': health });
        const manager = new McpLifecycleManager(mcp as any);

        // No explicit registerService() call
        const inv = manager.getDiagnosticsInventory();
        expect(inv.services.some(s => s.serviceId === 'discovered')).toBe(true);
        expect(inv.totalReady).toBe(1);
    });
});

describe('McpLifecycleManager — instability signals', () => {
    beforeEach(clearMocks);

    it('reports mcp_instability signal after repeated failures', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);

        // 3 failures = instability threshold
        manager.onServiceDegraded('svc-1', 'failure 1');
        manager.onServiceDegraded('svc-1', 'failure 2');
        manager.onServiceDegraded('svc-1', 'failure 3');

        const instabilitySignals = reportedSignals.filter(s => s.category === 'mcp_instability');
        expect(instabilitySignals.length).toBeGreaterThan(0);
    });

    it('does not report instability signal after single failure', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onServiceDegraded('svc-1', 'one failure');

        // Only one failure — should not trigger instability signal
        // (the FAILED signal fires at onServiceFailed, not onServiceDegraded)
        const instabilitySignals = reportedSignals.filter(s => s.category === 'mcp_instability');
        expect(instabilitySignals.length).toBe(0);
    });

    it('resets failure streak when service recovers', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);

        manager.onServiceDegraded('svc-1', 'failure');
        manager.onServiceDegraded('svc-1', 'failure');
        manager.onServiceReady('svc-1'); // Recovery resets streak
        clearMocks();

        // One more failure after recovery — should not trigger instability
        manager.onServiceDegraded('svc-1', 'new failure');
        const instabilitySignals = reportedSignals.filter(s => s.category === 'mcp_instability');
        expect(instabilitySignals.length).toBe(0);
    });
});

describe('McpLifecycleManager — health check telemetry', () => {
    beforeEach(clearMocks);

    it('emits mcp_health_check_completed for healthy check', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onHealthCheckCompleted('svc-1', true, 50);

        const healthy = emittedEvents.filter(e => e.eventType === 'mcp_health_check_completed');
        expect(healthy.length).toBeGreaterThan(0);
        expect(healthy[0].status).toBe('success');
    });

    it('emits mcp_health_check_failed for unhealthy check', () => {
        const mcp = makeMockMcpService();
        const manager = new McpLifecycleManager(mcp as any);
        manager.registerService('svc-1', 'My Service', 'stdio', true);
        manager.onHealthCheckCompleted('svc-1', false, 100);

        const failed = emittedEvents.filter(e => e.eventType === 'mcp_health_check_failed');
        expect(failed.length).toBeGreaterThan(0);
        expect(failed[0].status).toBe('failure');
    });
});
