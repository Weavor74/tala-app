import { describe, expect, it, beforeEach } from 'vitest';
import { SystemModeManager } from '../../services/SystemModeManager';
import { SystemHealthService } from '../../services/SystemHealthService';
import type {
    SystemCapability,
    SystemOperatingMode,
    SystemHealthSnapshot,
    SystemModeContract,
} from '../../../shared/system-health-types';
import type { InferenceDiagnosticsState, McpInventoryDiagnostics, RuntimeFailureSummary } from '../../../shared/runtimeDiagnosticsTypes';

const ALL_CAPABILITIES: SystemCapability[] = [
    'chat_inference',
    'workflow_execute',
    'tool_execute_read',
    'tool_execute_write',
    'tool_execute_diagnostic',
    'memory_canonical_read',
    'memory_canonical_write',
    'memory_promotion',
    'autonomy_execute',
    'repair_execute',
    'repair_promotion',
    'self_modify',
];

const EXPECTED_BLOCKED_BY_MODE: Record<SystemOperatingMode, SystemCapability[]> = {
    NORMAL: [],
    DEGRADED_INFERENCE: [],
    DEGRADED_MEMORY: ['memory_promotion'],
    DEGRADED_TOOLS: ['tool_execute_write'],
    DEGRADED_AUTONOMY: ['autonomy_execute'],
    SAFE_MODE: [
        'workflow_execute',
        'tool_execute_write',
        'memory_canonical_write',
        'memory_promotion',
        'autonomy_execute',
        'repair_execute',
        'repair_promotion',
        'self_modify',
    ],
    READ_ONLY: [
        'workflow_execute',
        'tool_execute_write',
        'memory_canonical_write',
        'memory_promotion',
        'autonomy_execute',
        'repair_promotion',
        'self_modify',
    ],
    RECOVERY: ['repair_promotion'],
    MAINTENANCE: [
        'chat_inference',
        'workflow_execute',
        'tool_execute_write',
        'memory_canonical_write',
        'memory_promotion',
        'autonomy_execute',
        'repair_promotion',
        'self_modify',
    ],
};

function makeModeInput() {
    return {
        timestamp: '2026-04-14T12:00:00.000Z',
        overallStatus: 'healthy' as const,
        degradedCapabilities: [],
        blockedCapabilities: [],
        pendingRepairs: [],
        activeFallbacks: [],
        operatorAttentionRequired: false,
        trustScore: 1,
    };
}

function makeInference(overrides: Partial<InferenceDiagnosticsState> = {}): InferenceDiagnosticsState {
    return {
        selectedProviderReady: true,
        attemptedProviders: [],
        fallbackApplied: false,
        streamStatus: 'idle',
        providerInventorySummary: { total: 1, ready: 1, degraded: 0, unavailable: 0 },
        lastUpdated: '2026-04-14T12:00:00.000Z',
        ...overrides,
    };
}

function makeMcp(overrides: Partial<McpInventoryDiagnostics> = {}): McpInventoryDiagnostics {
    return {
        services: [],
        totalConfigured: 1,
        totalReady: 1,
        totalDegraded: 0,
        totalUnavailable: 0,
        criticalUnavailable: false,
        lastUpdated: '2026-04-14T12:00:00.000Z',
        ...overrides,
    };
}

const NO_FAILURES: RuntimeFailureSummary = { count: 0, failedEntityIds: [] };

function makeSnapshotForMode(mode: SystemOperatingMode): SystemHealthSnapshot {
    const manager = new SystemModeManager();
    if (mode !== 'NORMAL') {
        manager.setOperatorModeOverride(mode);
    }
    const evaluated = manager.evaluate(makeModeInput());
    return {
        timestamp: '2026-04-14T12:00:00.000Z',
        overall_status: mode === 'SAFE_MODE' || mode === 'READ_ONLY' ? 'impaired' : 'healthy',
        subsystem_entries: [],
        trust_score: 1,
        degraded_capabilities: [],
        blocked_capabilities: [],
        active_fallbacks: [],
        active_incidents: [],
        pending_repairs: [],
        current_mode: evaluated.effectiveMode,
        effective_mode: evaluated.effectiveMode,
        active_degradation_flags: evaluated.activeFlags,
        mode_contract: evaluated.modeContract,
        recent_mode_transitions: evaluated.recentTransitions,
        capability_matrix: [],
        active_incident_entries: [],
        trust_explanation: {
            telemetry_freshness: {
                inference_age_ms: 0,
                mcp_age_ms: 0,
                expected_max_age_ms: 90_000,
            },
            last_successful_subsystem_check: '2026-04-14T12:00:00.000Z',
            stale_components: [],
            missing_evidence: [],
            suppressed_assumptions: [],
            confidence_penalties: [],
        },
        trust_score_inputs: {
            inference_age_ms: 0,
            mcp_age_ms: 0,
            expected_max_age_ms: 90_000,
            db_evidence_observed: true,
            telemetry_stream_observed: true,
        },
        operator_attention_required: false,
    };
}

describe('SystemModeManager governance matrix', () => {
    beforeEach(() => {
        SystemModeManager.clearDiagnosticsProviderForTests();
    });

    it('enforces full mode x capability blocked matrix deterministically', () => {
        const modes: SystemOperatingMode[] = [
            'NORMAL',
            'DEGRADED_INFERENCE',
            'DEGRADED_MEMORY',
            'DEGRADED_TOOLS',
            'DEGRADED_AUTONOMY',
            'SAFE_MODE',
            'READ_ONLY',
            'RECOVERY',
            'MAINTENANCE',
        ];

        for (const mode of modes) {
            const manager = new SystemModeManager();
            if (mode !== 'NORMAL') manager.setOperatorModeOverride(mode);
            const evaluated = manager.evaluate(makeModeInput());
            expect(evaluated.effectiveMode).toBe(mode);
            const expectedBlocked = EXPECTED_BLOCKED_BY_MODE[mode].slice().sort();
            expect(evaluated.modeContract.blocked_capabilities.slice().sort()).toEqual(expectedBlocked);

            for (const capability of ALL_CAPABILITIES) {
                const expectedAllowed =
                    evaluated.modeContract.allowed_capabilities.includes(capability)
                    && !evaluated.modeContract.blocked_capabilities.includes(capability);
                expect(manager.isCapabilityAllowed(capability, evaluated)).toBe(expectedAllowed);
            }
        }
    });

    it('enforces tool class capability gating across modes', () => {
        const safeMode = makeSnapshotForMode('SAFE_MODE');
        const degradedTools = makeSnapshotForMode('DEGRADED_TOOLS');
        let active = degradedTools;
        SystemModeManager.configureDiagnosticsProvider(() => ({
            getSystemHealthSnapshot: () => active,
            isCapabilityAllowed: (capability: SystemCapability) => {
                const blocked = active.mode_contract.blocked_capabilities.includes(capability);
                const allowed = active.mode_contract.allowed_capabilities.includes(capability);
                return {
                    allowed: allowed && !blocked,
                    effective_mode: active.effective_mode,
                    reason: allowed && !blocked ? 'allowed_by_mode_contract' : `blocked_by_mode_contract:${active.effective_mode}`,
                };
            },
        }));

        const readCap = SystemModeManager.resolveToolCapability('fs_read_text');
        const diagCap = SystemModeManager.resolveToolCapability('provider_health_probe');
        const writeCap = SystemModeManager.resolveToolCapability('fs_write_text');
        expect(readCap).toBe('tool_execute_read');
        expect(diagCap).toBe('tool_execute_diagnostic');
        expect(writeCap).toBe('tool_execute_write');

        expect(SystemModeManager.checkCapability(readCap, 'mode-test').allowed).toBe(true);
        expect(SystemModeManager.checkCapability(diagCap, 'mode-test').allowed).toBe(true);
        expect(SystemModeManager.checkCapability(writeCap, 'mode-test').allowed).toBe(false);

        active = safeMode;
        expect(SystemModeManager.checkCapability(readCap, 'mode-test').allowed).toBe(true);
        expect(SystemModeManager.checkCapability(diagCap, 'mode-test').allowed).toBe(true);
        expect(SystemModeManager.checkCapability(writeCap, 'mode-test').allowed).toBe(false);
    });

    it('keeps transitions idempotent and reason codes deterministic for identical inputs', () => {
        const input = {
            ...makeModeInput(),
            overallStatus: 'degraded' as const,
            degradedCapabilities: ['inference_service'],
            activeFallbacks: ['provider_fallback'],
        };
        const manager = new SystemModeManager();
        const first = manager.evaluate(input);
        const second = manager.evaluate(input);

        expect(first.recentTransitions.length).toBe(1);
        expect(second.recentTransitions.length).toBe(1);
        expect(second.recentTransitions[0]).toEqual(first.recentTransitions[0]);

        const managerTwo = new SystemModeManager();
        const third = managerTwo.evaluate(input);
        expect(third.recentTransitions[0]?.reason_codes).toEqual(first.recentTransitions[0]?.reason_codes);
    });
});

describe('SystemHealthService capability state distinctions', () => {
    it('distinguishes degraded vs blocked vs approval_required capability statuses', () => {
        const service = new SystemHealthService();

        const degraded = service.buildSnapshot({
            now: '2026-04-14T12:00:00.000Z',
            inference: makeInference({ fallbackApplied: true }),
            mcp: makeMcp(),
            recentFailures: NO_FAILURES,
            suppressedProviders: [],
        });
        expect(degraded.capability_matrix.find((c) => c.capability === 'chat')?.status).toBe('degraded');

        service.setOperatorModeOverride('SAFE_MODE', { reason: 'test' });
        const blocked = service.buildSnapshot({
            now: '2026-04-14T12:01:00.000Z',
            inference: makeInference(),
            mcp: makeMcp(),
            recentFailures: NO_FAILURES,
            suppressedProviders: [],
        });
        expect(blocked.capability_matrix.find((c) => c.capability === 'run_tools')?.status).toBe('blocked');

        service.setOperatorModeOverride('DEGRADED_MEMORY', { reason: 'test' });
        const approval = service.buildSnapshot({
            now: '2026-04-14T12:02:00.000Z',
            inference: makeInference(),
            mcp: makeMcp(),
            recentFailures: NO_FAILURES,
            suppressedProviders: [],
        });
        expect(approval.capability_matrix.find((c) => c.capability === 'safe_auto_fix')?.status).toBe('approval_required');
    });
});
