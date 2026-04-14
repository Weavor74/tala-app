import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceDiagnosticsState, McpInventoryDiagnostics, RuntimeFailureSummary } from '../../../shared/runtimeDiagnosticsTypes';
import type { SystemCapability } from '../../../shared/system-health-types';
import { SystemHealthService } from '../../services/SystemHealthService';
import { SystemModeManager } from '../../services/SystemModeManager';

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
        SystemModeManager.clearDiagnosticsProviderForTests();
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

    it('emits incident evidence links as artifact references or explicit unavailable markers', () => {
        const service = new SystemHealthService();
        mockDbHealth = { ...mockDbHealth, reachable: false };
        mockEvents = [{
            id: 'tevt-1',
            timestamp: '2026-04-14T12:00:00.000Z',
            executionId: 'exec-1',
            subsystem: 'system',
            event: 'execution.failed',
        } as any];
        const snapshot = service.buildSnapshot({
            now: '2026-04-14T12:00:00.000Z',
            inference: makeInference(),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
        });
        const incident = snapshot.active_incident_entries.find((i) => i.title.includes('db health service'));
        expect(incident).toBeTruthy();
        expect(incident?.evidence_links.some((link) => link.startsWith('artifact://'))).toBe(true);
        expect(
            incident?.evidence_links.some((link) => link.startsWith('artifact://telemetry/event/'))
            || incident?.evidence_links.includes('evidence_unavailable:telemetry_event_not_found'),
        ).toBe(true);
    });

    it('emits deterministic mode transition reason codes from health reductions', () => {
        const service = new SystemHealthService();
        const degraded = service.buildSnapshot({
            now: '2026-04-14T12:00:00.000Z',
            inference: makeInference({ fallbackApplied: true }),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
        });

        expect(degraded.effective_mode).toBe('DEGRADED_INFERENCE');
        expect(degraded.recent_mode_transitions).toHaveLength(1);
        expect(degraded.recent_mode_transitions[0].reason_codes).toEqual([
            'mode_entered:degraded_inference',
            'flag:degraded_inference',
            'overall_status:degraded',
        ]);
    });

    it('keeps mode transitions idempotent for repeated equivalent health states', () => {
        const service = new SystemHealthService();
        const input = {
            now: '2026-04-14T12:00:00.000Z',
            inference: makeInference({ fallbackApplied: true }),
            mcp: makeMcp(),
            recentFailures: noFailures,
            suppressedProviders: [],
        };

        const first = service.buildSnapshot(input);
        const second = service.buildSnapshot(input);
        expect(first.recent_mode_transitions).toHaveLength(1);
        expect(second.recent_mode_transitions).toHaveLength(1);
        expect(second.recent_mode_transitions[0]).toEqual(first.recent_mode_transitions[0]);
    });

    it('exposes deterministic capability checks through the central mode contract', () => {
        const health = makeSnapshotContractFixture();
        SystemModeManager.configureDiagnosticsProvider(() => ({
            getSystemHealthSnapshot: () => health,
            isCapabilityAllowed: (_capability: SystemCapability) => ({
                allowed: false,
                effective_mode: 'SAFE_MODE',
                reason: 'blocked_by_mode_contract:SAFE_MODE',
            }),
        }));

        const denied = SystemModeManager.checkCapability('tool_execute_write', 'system-health-test');
        expect(denied.allowed).toBe(false);
        expect(denied.reason_code).toBe('blocked_by_mode_contract:safe_mode');
        expect(() => SystemModeManager.assertCapability('tool_execute_write', 'system-health-test')).toThrow(
            /Blocked by runtime mode SAFE_MODE/,
        );
        expect(SystemModeManager.resolveToolCapability('fs_read_text')).toBe('tool_execute_read');
        expect(SystemModeManager.resolveToolCapability('provider_health_probe')).toBe('tool_execute_diagnostic');
    });
});

function makeSnapshotContractFixture() {
    return {
        timestamp: '2026-04-14T12:00:00.000Z',
        overall_status: 'healthy' as const,
        subsystem_entries: [],
        trust_score: 1,
        trust_score_inputs: {
            expected_max_age_ms: 60_000,
            db_evidence_observed: true,
            inference_evidence_observed: true,
            telemetry_freshness_penalty: 0,
            stale_component_count: 0,
            missing_evidence_count: 0,
            suppressed_assumption_count: 0,
        },
        degraded_capabilities: [],
        blocked_capabilities: [],
        active_fallbacks: [],
        active_incidents: [],
        pending_repairs: [],
        current_mode: 'NORMAL' as const,
        effective_mode: 'NORMAL' as const,
        active_degradation_flags: [],
        mode_contract: {
            mode: 'NORMAL' as const,
            entry_conditions: [],
            exit_conditions: [],
            allowed_capabilities: [],
            blocked_capabilities: [],
            fallback_behavior: [],
            user_facing_behavior_changes: [],
            telemetry_expectations: [],
            operator_actions_allowed: [],
            autonomy_allowed: true,
            writes_allowed: true,
            operator_approval_required_for: [],
        },
        recent_mode_transitions: [],
        operator_attention_required: false,
        capability_matrix: [],
    };
}
