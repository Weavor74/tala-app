import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceDiagnosticsState, McpInventoryDiagnostics, RuntimeFailureSummary } from '../../../shared/runtimeDiagnosticsTypes';
import { SystemHealthService } from '../../services/SystemHealthService';

let mockDbHealth: any = {
    reachable: true,
    authenticated: true,
    databaseExists: true,
    pgvectorInstalled: true,
    migrationsApplied: true,
};
let mockPolicyProfileId: string | null = 'test-profile';
let mockEvents: Array<{ event: string }> = [];

vi.mock('../../services/db/initMemoryStore', () => ({
    getLastDbHealth: () => mockDbHealth,
}));

vi.mock('../../services/policy/PolicyGate', () => ({
    policyGate: {
        getActiveProfileId: () => mockPolicyProfileId,
    },
}));

vi.mock('../../services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            getRecentEvents: () => mockEvents,
            emit: () => undefined,
        }),
    },
}));

function makeInference(overrides: Partial<InferenceDiagnosticsState> = {}): InferenceDiagnosticsState {
    return {
        selectedProviderReady: true,
        attemptedProviders: [],
        fallbackApplied: false,
        streamStatus: 'idle',
        providerInventorySummary: { total: 1, ready: 1, unavailable: 0, degraded: 0 },
        lastUpdated: '2026-04-14T12:00:00.000Z',
        ...overrides,
    };
}

function makeMcp(overrides: Partial<McpInventoryDiagnostics> = {}): McpInventoryDiagnostics {
    return {
        services: [],
        totalConfigured: 0,
        totalReady: 0,
        totalDegraded: 0,
        totalUnavailable: 0,
        criticalUnavailable: false,
        lastUpdated: '2026-04-14T12:00:00.000Z',
        ...overrides,
    };
}

const noFailures: RuntimeFailureSummary = {
    count: 0,
    failedEntityIds: [],
};

describe('SystemHealthService', () => {
    beforeEach(() => {
        mockDbHealth = {
            reachable: true,
            authenticated: true,
            databaseExists: true,
            pgvectorInstalled: true,
            migrationsApplied: true,
        };
        mockPolicyProfileId = 'test-profile';
        mockEvents = [];
    });

    it('produces deterministic snapshots for identical input', () => {
        const service = new SystemHealthService();
        const input = {
            now: '2026-04-14T12:00:00.000Z',
            inference: makeInference(),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
            lastCognitiveMode: 'assistant',
        };

        const first = service.buildSnapshot(input);
        const second = service.buildSnapshot(input);
        expect(second).toEqual(first);
    });

    it('applies deterministic overall-status precedence', () => {
        const service = new SystemHealthService();
        mockEvents = [{ event: 'tool.completed' }];
        const baseInput = {
            now: '2026-04-14T12:00:00.000Z',
            inference: makeInference(),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
            lastCognitiveMode: 'assistant',
        };

        expect(service.buildSnapshot(baseInput).overall_status).toBe('healthy');

        mockPolicyProfileId = null;
        expect(service.buildSnapshot(baseInput).overall_status).toBe('maintenance');

        mockPolicyProfileId = 'test-profile';
        expect(service.buildSnapshot({ ...baseInput, inference: makeInference({ fallbackApplied: true }) }).overall_status).toBe('degraded');

        const recoveryService = new SystemHealthService({ getReflectionSummary: () => 'repair pending' });
        mockEvents = [{ event: 'memory.repair_trigger' }];
        expect(recoveryService.buildSnapshot(baseInput).overall_status).toBe('recovery');

        mockEvents = [];
        mockDbHealth = { ...mockDbHealth, databaseExists: false };
        expect(service.buildSnapshot(baseInput).overall_status).toBe('impaired');

        mockDbHealth = { ...mockDbHealth, reachable: false };
        expect(service.buildSnapshot(baseInput).overall_status).toBe('failed');
    });

    it('tracks last_changed_at only when status changes', () => {
        const service = new SystemHealthService();

        const healthy = service.buildSnapshot({
            now: '2026-04-14T12:00:00.000Z',
            inference: makeInference(),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
        });
        const inferenceHealthyChangedAt = healthy.subsystem_entries.find((s) => s.name === 'inference_service')?.last_changed_at;

        const sameStatus = service.buildSnapshot({
            now: '2026-04-14T12:01:00.000Z',
            inference: makeInference(),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
        });
        const unchanged = sameStatus.subsystem_entries.find((s) => s.name === 'inference_service')?.last_changed_at;
        expect(unchanged).toBe(inferenceHealthyChangedAt);

        const degraded = service.buildSnapshot({
            now: '2026-04-14T12:02:00.000Z',
            inference: makeInference({ fallbackApplied: true }),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
        });
        const changed = degraded.subsystem_entries.find((s) => s.name === 'inference_service')?.last_changed_at;
        expect(changed).toBe('2026-04-14T12:02:00.000Z');
    });

    it('includes trust score inputs and required subsystem snapshot fields', () => {
        const service = new SystemHealthService();
        const snapshot = service.buildSnapshot({
            now: '2026-04-14T12:00:00.000Z',
            inference: makeInference(),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
        });

        expect(snapshot.trust_score_inputs.expected_max_age_ms).toBe(90_000);
        expect(typeof snapshot.trust_score_inputs.db_evidence_observed).toBe('boolean');
        expect(snapshot.subsystem_entries.every((entry) =>
            Boolean(entry.last_checked_at) && Boolean(entry.last_changed_at) && Boolean(entry.operator_impact),
        )).toBe(true);
    });
});
