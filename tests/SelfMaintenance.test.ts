/**
 * SelfMaintenance.test.ts — Phase 4B: Self-Maintenance Foundation
 *
 * Validates:
 *   1. Issue detection — provider unavailable/degraded, MCP unavailable/flapping, world model issues.
 *   2. Policy engine — auto-approve, approval-needed, cooldown, suppression, mode gating.
 *   3. Action execution — allowed actions execute; blocked_by_policy when appropriate; failed surfaced.
 *   4. Maintenance loop — observation_only / recommend_only / safe_auto_recovery mode behavior.
 *   5. World/cognitive integration — summary for relevant turns; suppressed for irrelevant turns.
 *   6. Diagnostics / IPC — state retrievable; issues and actions represented correctly.
 *   7. Telemetry — detection, policy, execution, cooldown events emitted; no unsafe data leakage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-test' },
}));

vi.mock('../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
        event: vi.fn(),
    },
}));

vi.mock('uuid', () => ({
    v4: vi.fn(() => `test-uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import type { RuntimeDiagnosticsSnapshot } from '../shared/runtimeDiagnosticsTypes';
import type { TalaWorldModel } from '../shared/worldModelTypes';
import type { MaintenanceMode } from '../shared/maintenance/maintenanceTypes';
import { MaintenanceIssueDetector } from '../electron/services/maintenance/MaintenanceIssueDetector';
import { MaintenancePolicyEngine } from '../electron/services/maintenance/MaintenancePolicyEngine';
import { MaintenanceActionExecutor } from '../electron/services/maintenance/MaintenanceActionExecutor';
import { MaintenanceLoopService } from '../electron/services/maintenance/MaintenanceLoopService';
import { telemetry } from '../electron/services/TelemetryService';

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeMinimalSnapshot(overrides: Partial<RuntimeDiagnosticsSnapshot> = {}): RuntimeDiagnosticsSnapshot {
    const now = new Date().toISOString();
    return {
        timestamp: now,
        inference: {
            selectedProviderId: 'ollama',
            selectedProviderName: 'Ollama',
            selectedProviderReady: true,
            attemptedProviders: [],
            fallbackApplied: false,
            streamStatus: 'idle',
            providerInventorySummary: { total: 1, ready: 1, unavailable: 0, degraded: 0 },
            lastUpdated: now,
        },
        mcp: {
            services: [],
            totalConfigured: 0,
            totalReady: 0,
            totalDegraded: 0,
            totalUnavailable: 0,
            criticalUnavailable: false,
            lastUpdated: now,
        },
        degradedSubsystems: [],
        recentFailures: { count: 0, failedEntityIds: [] },
        lastUpdatedPerSubsystem: {},
        operatorActions: [],
        providerHealthScores: [],
        suppressedProviders: [],
        recentProviderRecoveries: [],
        recentMcpRestarts: [],
        systemHealth: {
            timestamp: now,
            overall_status: 'healthy',
            subsystem_entries: [],
            trust_score: 1,
            degraded_capabilities: [],
            blocked_capabilities: [],
            active_fallbacks: [],
            active_incidents: [],
            pending_repairs: [],
            current_mode: 'assistant',
            operator_attention_required: false,
        },
        ...overrides,
    } as RuntimeDiagnosticsSnapshot;
}

function makeUnavailableProviderSnapshot(): RuntimeDiagnosticsSnapshot {
    return makeMinimalSnapshot({
        inference: {
            selectedProviderId: 'ollama',
            selectedProviderName: 'Ollama',
            selectedProviderReady: false,
            attemptedProviders: ['ollama'],
            fallbackApplied: false,
            streamStatus: 'idle',
            providerInventorySummary: { total: 1, ready: 0, unavailable: 1, degraded: 0 },
            lastUpdated: new Date().toISOString(),
        },
    });
}

function makeDegradedProviderSnapshot(): RuntimeDiagnosticsSnapshot {
    return makeMinimalSnapshot({
        inference: {
            selectedProviderId: 'ollama',
            selectedProviderName: 'Ollama',
            selectedProviderReady: false,
            attemptedProviders: ['ollama'],
            fallbackApplied: false,
            streamStatus: 'idle',
            providerInventorySummary: { total: 1, ready: 0, unavailable: 0, degraded: 1 },
            lastUpdated: new Date().toISOString(),
        },
        providerHealthScores: [
            {
                providerId: 'ollama',
                failureStreak: 5,
                timeoutCount: 1,
                fallbackCount: 2,
                suppressed: false,
                effectivePriority: 1,
            },
        ],
    });
}

function makeFlappingMcpSnapshot(): RuntimeDiagnosticsSnapshot {
    return makeMinimalSnapshot({
        mcp: {
            services: [
                {
                    serviceId: 'test-mcp',
                    displayName: 'Test MCP',
                    kind: 'stdio',
                    enabled: true,
                    status: 'unavailable',
                    degraded: false,
                    ready: false,
                    restartCount: 3,
                },
            ],
            totalConfigured: 1,
            totalReady: 0,
            totalDegraded: 0,
            totalUnavailable: 1,
            criticalUnavailable: false,
            lastUpdated: new Date().toISOString(),
        },
        recentMcpRestarts: [
            { serviceId: 'test-mcp', timestamp: new Date().toISOString(), reason: 'crash' },
            { serviceId: 'test-mcp', timestamp: new Date().toISOString(), reason: 'crash' },
            { serviceId: 'test-mcp', timestamp: new Date().toISOString(), reason: 'crash' },
        ],
    });
}

function makeDegradedProviderHealthSnapshot(): RuntimeDiagnosticsSnapshot {
    return makeMinimalSnapshot({
        providerHealthScores: [
            {
                providerId: 'ollama',
                failureStreak: 5,
                timeoutCount: 2,
                fallbackCount: 4,
                suppressed: false,
                effectivePriority: 1,
            },
        ],
    });
}

function makeMockRuntimeControl() {
    return {
        restartProvider: vi.fn().mockResolvedValue({ success: true, entityId: 'ollama', action: 'provider_restart', correlationId: 'x' }),
        probeProviders: vi.fn().mockResolvedValue({ success: true, entityId: 'all', action: 'provider_probe', correlationId: 'x' }),
        probeMcpServices: vi.fn().mockReturnValue({ success: true, entityId: 'all', action: 'mcp_probe', correlationId: 'x' }),
        restartMcpService: vi.fn().mockResolvedValue({ success: true, entityId: 'test-mcp', action: 'mcp_restart', correlationId: 'x' }),
        getOperatorActions: vi.fn().mockReturnValue([]),
        getRecentProviderRecoveries: vi.fn().mockReturnValue([]),
        getRecentMcpRestarts: vi.fn().mockReturnValue([]),
    } as any;
}

// ─── 1. Issue Detection ───────────────────────────────────────────────────────

describe('MaintenanceIssueDetector', () => {
    let detector: MaintenanceIssueDetector;

    beforeEach(() => {
        detector = new MaintenanceIssueDetector();
    });

    it('detects provider_unavailable when selected provider is unavailable', () => {
        const snapshot = makeUnavailableProviderSnapshot();
        const issues = detector.detect(snapshot);
        const providerIssues = issues.filter(i => i.category === 'provider_unavailable');
        expect(providerIssues.length).toBeGreaterThanOrEqual(1);
        expect(providerIssues[0].severity).toBe('critical');
        expect(providerIssues[0].confidence).toBeGreaterThan(0.8);
    });

    it('detects provider_degraded when selected provider is degraded', () => {
        const snapshot = makeDegradedProviderSnapshot();
        const issues = detector.detect(snapshot);
        const degraded = issues.filter(i => i.category === 'provider_degraded');
        expect(degraded.length).toBeGreaterThanOrEqual(1);
        expect(degraded[0].severity).toBe('high');
    });

    it('detects provider_degraded from health score failure streak', () => {
        const snapshot = makeDegradedProviderHealthSnapshot();
        const issues = detector.detect(snapshot);
        const degraded = issues.filter(i => i.category === 'provider_degraded' && i.affectedEntityId === 'ollama');
        expect(degraded.length).toBeGreaterThanOrEqual(1);
        expect(degraded[0].severity).toBe('high');
    });

    it('detects mcp_service_unavailable when MCP service is unavailable', () => {
        const snapshot = makeFlappingMcpSnapshot();
        const issues = detector.detect(snapshot);
        const mcpIssues = issues.filter(i => i.category === 'mcp_service_unavailable');
        expect(mcpIssues.length).toBeGreaterThanOrEqual(1);
        expect(mcpIssues[0].affectedEntityId).toBe('test-mcp');
    });

    it('detects mcp_service_flapping when service is restarted repeatedly', () => {
        const snapshot = makeFlappingMcpSnapshot();
        const issues = detector.detect(snapshot);
        const flapping = issues.filter(i => i.category === 'mcp_service_flapping');
        expect(flapping.length).toBeGreaterThanOrEqual(1);
        expect(flapping[0].affectedEntityId).toBe('test-mcp');
        expect(flapping[0].requiresApproval).toBe(true);
    });

    it('returns no issues for healthy snapshot', () => {
        const snapshot = makeMinimalSnapshot();
        const issues = detector.detect(snapshot);
        expect(issues.length).toBe(0);
    });

    it('filters out issues below low confidence threshold', () => {
        // Low-quality snapshot with no concrete evidence should not produce issues
        const snapshot = makeMinimalSnapshot();
        const issues = detector.detect(snapshot);
        expect(issues.every(i => i.confidence >= 0.4)).toBe(true);
    });

    it('detects world model runtime degradation issues', () => {
        const snapshot = makeMinimalSnapshot();
        const worldModel = {
            runtime: {
                meta: { availability: 'degraded', degradedReason: 'inference offline', assembledAt: new Date().toISOString(), freshness: 'fresh' },
                inferenceReady: false,
                hasActiveDegradation: true,
                degradedSubsystems: ['inference'],
                totalProviders: 1,
                readyProviders: 0,
                streamActive: false,
            },
            workspace: {
                meta: { availability: 'available', assembledAt: new Date().toISOString(), freshness: 'fresh' },
            },
        } as unknown as TalaWorldModel;

        const issues = detector.detect(snapshot, worldModel);
        const runtimeIssues = issues.filter(i => i.category === 'unknown_runtime_instability');
        expect(runtimeIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('detects workspace_state_issue from world model', () => {
        const snapshot = makeMinimalSnapshot();
        const worldModel = {
            runtime: {
                meta: { availability: 'available', assembledAt: new Date().toISOString(), freshness: 'fresh' },
                inferenceReady: true,
                hasActiveDegradation: false,
                degradedSubsystems: [],
                totalProviders: 1,
                readyProviders: 1,
                streamActive: false,
            },
            workspace: {
                meta: { availability: 'unavailable', degradedReason: 'root not found', assembledAt: new Date().toISOString(), freshness: 'unknown' },
            },
        } as unknown as TalaWorldModel;

        const issues = detector.detect(snapshot, worldModel);
        const wsIssues = issues.filter(i => i.category === 'workspace_state_issue');
        expect(wsIssues.length).toBeGreaterThanOrEqual(1);
    });

    it('assigns higher severity for long failure streaks', () => {
        const snapshot = makeMinimalSnapshot({
            providerHealthScores: [{
                providerId: 'test-provider',
                failureStreak: 8,
                timeoutCount: 0,
                fallbackCount: 0,
                suppressed: false,
                effectivePriority: 1,
            }],
        });
        const issues = detector.detect(snapshot);
        const degraded = issues.filter(i => i.affectedEntityId === 'test-provider');
        expect(degraded.length).toBeGreaterThanOrEqual(1);
        expect(degraded[0].severity).toBe('high');
    });
});

// ─── 2. Policy Engine ─────────────────────────────────────────────────────────

describe('MaintenancePolicyEngine', () => {
    let engine: MaintenancePolicyEngine;

    beforeEach(() => {
        engine = new MaintenancePolicyEngine();
    });

    function makeIssue(overrides: Partial<ReturnType<typeof makeBaseIssue>> = {}) {
        return makeBaseIssue(overrides);
    }

    function makeBaseIssue(overrides: any = {}) {
        return {
            id: 'test-issue-1',
            detectedAt: new Date().toISOString(),
            category: 'provider_unavailable',
            severity: 'critical' as const,
            confidence: 0.95,
            sourceSubsystem: 'inference',
            affectedEntityId: 'ollama',
            description: 'Provider ollama is unavailable.',
            safeToAutoExecute: true,
            requiresApproval: false,
            ...overrides,
        };
    }

    it('auto_execute safe provider restart in safe_auto_recovery mode', () => {
        const issue = makeIssue();
        const ctx = { cooldowns: {}, suppressedCategories: {}, mode: 'safe_auto_recovery' as MaintenanceMode };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('auto_execute');
        expect(decisions[0].proposal?.autoSafe).toBe(true);
        expect(decisions[0].proposal?.actionType).toMatch(/restart_provider|reprobe_providers/);
    });

    it('recommend_action in recommend_only mode (not auto_execute)', () => {
        const issue = makeIssue();
        const ctx = { cooldowns: {}, suppressedCategories: {}, mode: 'recommend_only' as MaintenanceMode };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('recommend_action');
        expect(decisions[0].proposal?.autoSafe).toBe(false);
    });

    it('monitor only in observation_only mode', () => {
        const issue = makeIssue();
        const ctx = { cooldowns: {}, suppressedCategories: {}, mode: 'observation_only' as MaintenanceMode };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('monitor');
        expect(decisions[0].proposal).toBeUndefined();
    });

    it('request_user_approval for flapping MCP service', () => {
        const issue = makeIssue({ category: 'mcp_service_flapping', safeToAutoExecute: false, requiresApproval: true });
        const ctx = { cooldowns: {}, suppressedCategories: {}, mode: 'safe_auto_recovery' as MaintenanceMode };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('request_user_approval');
    });

    it('suppress_temporarily when entity is under cooldown', () => {
        const issue = makeIssue();
        const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const ctx = {
            cooldowns: { ollama: future },
            suppressedCategories: {},
            mode: 'safe_auto_recovery' as MaintenanceMode,
        };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('suppress_temporarily');
    });

    it('suppress_temporarily when category is suppressed', () => {
        const issue = makeIssue();
        const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const ctx = {
            cooldowns: {},
            suppressedCategories: { provider_unavailable: future },
            mode: 'safe_auto_recovery' as MaintenanceMode,
        };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('suppress_temporarily');
    });

    it('monitor low-confidence issues regardless of mode', () => {
        const issue = makeIssue({ confidence: 0.3 });
        const ctx = { cooldowns: {}, suppressedCategories: {}, mode: 'safe_auto_recovery' as MaintenanceMode };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('monitor');
    });

    it('request_user_approval for memory_health_issue', () => {
        const issue = makeIssue({ category: 'memory_health_issue', safeToAutoExecute: false, requiresApproval: true });
        const ctx = { cooldowns: {}, suppressedCategories: {}, mode: 'safe_auto_recovery' as MaintenanceMode };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('request_user_approval');
    });

    it('sets cooldownUntil on auto_execute proposal', () => {
        const issue = makeIssue();
        const ctx = { cooldowns: {}, suppressedCategories: {}, mode: 'safe_auto_recovery' as MaintenanceMode };
        const decisions = engine.evaluate([issue], ctx);
        expect(decisions[0].outcome).toBe('auto_execute');
        expect(decisions[0].proposal?.cooldownUntil).toBeDefined();
    });

    it('handles empty issue list without error', () => {
        const ctx = { cooldowns: {}, suppressedCategories: {}, mode: 'recommend_only' as MaintenanceMode };
        expect(() => engine.evaluate([], ctx)).not.toThrow();
        expect(engine.evaluate([], ctx)).toEqual([]);
    });
});

// ─── 3. Action Execution ──────────────────────────────────────────────────────

describe('MaintenanceActionExecutor', () => {
    let executor: MaintenanceActionExecutor;
    let mockRuntimeControl: ReturnType<typeof makeMockRuntimeControl>;

    beforeEach(() => {
        mockRuntimeControl = makeMockRuntimeControl();
        executor = new MaintenanceActionExecutor(mockRuntimeControl, () => []);
        vi.clearAllMocks();
    });

    function makeProposal(overrides: any = {}) {
        return {
            id: 'proposal-1',
            issueId: 'issue-1',
            actionType: 'reprobe_providers',
            proposedAt: new Date().toISOString(),
            policyOutcome: 'auto_execute',
            autoSafe: true,
            rationale: 'Test reprobe',
            ...overrides,
        } as any;
    }

    it('executes reprobe_providers successfully', async () => {
        const proposal = makeProposal({ actionType: 'reprobe_providers' });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('success');
        expect(mockRuntimeControl.probeProviders).toHaveBeenCalled();
    });

    it('executes restart_provider with targetEntityId', async () => {
        const proposal = makeProposal({ actionType: 'restart_provider', targetEntityId: 'ollama' });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('success');
        expect(mockRuntimeControl.restartProvider).toHaveBeenCalledWith('ollama');
    });

    it('skips restart_provider when targetEntityId missing', async () => {
        const proposal = makeProposal({ actionType: 'restart_provider', targetEntityId: undefined });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('skipped');
    });

    it('executes restart_mcp_service with targetEntityId', async () => {
        const proposal = makeProposal({ actionType: 'restart_mcp_service', targetEntityId: 'test-mcp' });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('success');
        expect(mockRuntimeControl.restartMcpService).toHaveBeenCalledWith('test-mcp', []);
    });

    it('returns blocked_by_policy for non-auto-safe proposal', async () => {
        const proposal = makeProposal({ autoSafe: false, policyOutcome: 'recommend_action' });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('blocked_by_policy');
    });

    it('returns requires_user_approval for approval-pending proposal', async () => {
        const proposal = makeProposal({ autoSafe: false, policyOutcome: 'request_user_approval' });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('requires_user_approval');
    });

    it('returns blocked_by_policy for disable_provider_temporarily', async () => {
        const proposal = makeProposal({ actionType: 'disable_provider_temporarily', autoSafe: true });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('blocked_by_policy');
    });

    it('surfaces failed execution correctly', async () => {
        mockRuntimeControl.restartProvider.mockRejectedValue(new Error('restart failed'));
        const proposal = makeProposal({ actionType: 'restart_provider', targetEntityId: 'ollama' });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('failed');
        expect(result.error).toContain('restart failed');
    });

    it('skips escalate_to_user action', async () => {
        const proposal = makeProposal({ actionType: 'escalate_to_user', autoSafe: true });
        const result = await executor.execute(proposal);
        expect(result.status).toBe('skipped');
    });
});

// ─── 4. Maintenance Loop (MaintenanceLoopService) ─────────────────────────────

describe('MaintenanceLoopService', () => {
    let mockRuntimeControl: ReturnType<typeof makeMockRuntimeControl>;

    beforeEach(() => {
        mockRuntimeControl = makeMockRuntimeControl();
        vi.clearAllMocks();
    });

    it('observation_only mode: detects issues but does not execute', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        const snapshot = makeUnavailableProviderSnapshot();
        const summary = await svc.runCycle(snapshot);
        // Should detect issues
        expect(summary.activeIssues.length).toBeGreaterThanOrEqual(1);
        // Should NOT have executed any action
        expect(mockRuntimeControl.probeProviders).not.toHaveBeenCalled();
        expect(mockRuntimeControl.restartProvider).not.toHaveBeenCalled();
    });

    it('recommend_only mode: recommends actions but does not execute', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'recommend_only');
        const snapshot = makeUnavailableProviderSnapshot();
        const summary = await svc.runCycle(snapshot);
        expect(summary.activeIssues.length).toBeGreaterThanOrEqual(1);
        // Should have recommendations but no executions
        expect(mockRuntimeControl.probeProviders).not.toHaveBeenCalled();
        expect(mockRuntimeControl.restartProvider).not.toHaveBeenCalled();
    });

    it('safe_auto_recovery mode: executes safe actions for critical issues', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'safe_auto_recovery');
        const snapshot = makeUnavailableProviderSnapshot();
        await svc.runCycle(snapshot);
        // Should have executed a probe or restart
        const executed = mockRuntimeControl.probeProviders.mock.calls.length +
            mockRuntimeControl.restartProvider.mock.calls.length;
        expect(executed).toBeGreaterThanOrEqual(1);
    });

    it('healthy snapshot produces no active issues', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'recommend_only');
        const snapshot = makeMinimalSnapshot();
        const summary = await svc.runCycle(snapshot);
        expect(summary.activeIssues.length).toBe(0);
    });

    it('returns correct issue counts by severity', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        const snapshot = makeUnavailableProviderSnapshot();
        const summary = await svc.runCycle(snapshot);
        const total = Object.values(summary.issueCounts).reduce((a, b) => a + b, 0);
        expect(total).toBe(summary.activeIssues.length);
    });

    it('setMode changes mode and emits telemetry', () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        svc.setMode('safe_auto_recovery');
        expect(svc.getMode()).toBe('safe_auto_recovery');
        expect(telemetry.operational).toHaveBeenCalled();
    });

    it('getDiagnosticsSummary returns structured summary', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        const snapshot = makeUnavailableProviderSnapshot();
        await svc.runCycle(snapshot);
        const summary = svc.getDiagnosticsSummary();
        expect(summary.mode).toBe('observation_only');
        expect(summary.lastCheckedAt).not.toBeNull();
        expect(Array.isArray(summary.activeIssues)).toBe(true);
        expect(Array.isArray(summary.recentDecisions)).toBe(true);
        expect(Array.isArray(summary.recentExecutions)).toBe(true);
    });

    it('cooldown prevents repeated auto-execution on next cycle', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'safe_auto_recovery');
        const snapshot = makeUnavailableProviderSnapshot();
        // First cycle — executes
        await svc.runCycle(snapshot);
        const firstExecutions = mockRuntimeControl.probeProviders.mock.calls.length +
            mockRuntimeControl.restartProvider.mock.calls.length;
        // Second cycle — should be suppressed by cooldown
        await svc.runCycle(snapshot);
        const secondExecutions = mockRuntimeControl.probeProviders.mock.calls.length +
            mockRuntimeControl.restartProvider.mock.calls.length;
        expect(secondExecutions).toBe(firstExecutions); // no new executions
    });
});

// ─── 5. World / Cognitive Integration ────────────────────────────────────────

describe('MaintenanceLoopService — getCognitiveSummary', () => {
    let mockRuntimeControl: ReturnType<typeof makeMockRuntimeControl>;

    beforeEach(() => {
        mockRuntimeControl = makeMockRuntimeControl();
        vi.clearAllMocks();
    });

    it('returns null highestSeverity when no active issues', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        await svc.runCycle(makeMinimalSnapshot());
        const cogSummary = svc.getCognitiveSummary();
        expect(cogSummary.highestSeverity).toBeNull();
        expect(cogSummary.activeIssueCount).toBe(0);
        expect(cogSummary.topIssueDescription).toBeNull();
    });

    it('returns top issue description for critical issues', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        const cogSummary = svc.getCognitiveSummary();
        expect(cogSummary.highestSeverity).toBe('critical');
        expect(cogSummary.topIssueDescription).toContain('not ready');
    });

    it('hasActionableIssues returns true for critical issues', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        expect(svc.hasActionableIssues()).toBe(true);
    });

    it('hasActionableIssues returns false for healthy snapshot', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        await svc.runCycle(makeMinimalSnapshot());
        expect(svc.hasActionableIssues()).toBe(false);
    });
});

// ─── 6. Diagnostics / IPC read model ─────────────────────────────────────────

describe('MaintenanceLoopService — getDiagnosticsSummary IPC safety', () => {
    let mockRuntimeControl: ReturnType<typeof makeMockRuntimeControl>;

    beforeEach(() => {
        mockRuntimeControl = makeMockRuntimeControl();
        vi.clearAllMocks();
    });

    it('active issues are present in summary after detection', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'recommend_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        const summary = svc.getDiagnosticsSummary();
        expect(summary.activeIssues.length).toBeGreaterThan(0);
        expect(summary.activeIssues[0].category).toBeDefined();
        expect(summary.activeIssues[0].severity).toBeDefined();
        expect(summary.activeIssues[0].description).toBeDefined();
    });

    it('recent decisions populated after cycle', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'recommend_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        const summary = svc.getDiagnosticsSummary();
        expect(summary.recentDecisions.length).toBeGreaterThan(0);
    });

    it('hasApprovalNeededAction is true for flapping MCP', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'recommend_only');
        await svc.runCycle(makeFlappingMcpSnapshot());
        const summary = svc.getDiagnosticsSummary();
        expect(summary.hasApprovalNeededAction).toBe(true);
    });

    it('summary does not contain raw internal data', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        const summary = svc.getDiagnosticsSummary();
        // Issues should have bounded fields only (no function references)
        for (const issue of summary.activeIssues) {
            expect(typeof issue.id).toBe('string');
            expect(typeof issue.category).toBe('string');
            expect(typeof issue.description).toBe('string');
            expect(typeof issue.severity).toBe('string');
            expect(typeof issue.confidence).toBe('number');
        }
    });
});

// ─── 7. Telemetry ─────────────────────────────────────────────────────────────

describe('MaintenanceLoopService — telemetry emission', () => {
    let mockRuntimeControl: ReturnType<typeof makeMockRuntimeControl>;

    beforeEach(() => {
        mockRuntimeControl = makeMockRuntimeControl();
        vi.clearAllMocks();
    });

    it('emits maintenance_issue_detected telemetry on new issue', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        const calls = (telemetry.operational as ReturnType<typeof vi.fn>).mock.calls;
        const detectionCalls = calls.filter((c: any[]) => c[1] === 'maintenance_issue_detected');
        expect(detectionCalls.length).toBeGreaterThan(0);
    });

    it('emits maintenance_policy_evaluated telemetry each cycle', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'recommend_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        const calls = (telemetry.operational as ReturnType<typeof vi.fn>).mock.calls;
        const policyCalls = calls.filter((c: any[]) => c[1] === 'maintenance_policy_evaluated');
        expect(policyCalls.length).toBeGreaterThan(0);
    });

    it('emits maintenance_action_recommended for recommend_only mode', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'recommend_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        const calls = (telemetry.operational as ReturnType<typeof vi.fn>).mock.calls;
        const recoCalls = calls.filter((c: any[]) => c[1] === 'maintenance_action_recommended');
        expect(recoCalls.length).toBeGreaterThan(0);
    });

    it('emits maintenance_mode_changed when mode changes', () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        svc.setMode('recommend_only');
        const calls = (telemetry.operational as ReturnType<typeof vi.fn>).mock.calls;
        const modeCalls = calls.filter((c: any[]) => c[1] === 'maintenance_mode_changed');
        expect(modeCalls.length).toBeGreaterThan(0);
    });

    it('telemetry payloads do not contain sensitive raw data', async () => {
        const svc = new MaintenanceLoopService(mockRuntimeControl, () => [], 'observation_only');
        await svc.runCycle(makeUnavailableProviderSnapshot());
        const calls = (telemetry.operational as ReturnType<typeof vi.fn>).mock.calls;
        for (const call of calls) {
            const payloadArg = call[2];
            if (payloadArg && typeof payloadArg === 'object' && payloadArg.payload) {
                // Should not contain any property named 'password', 'secret', 'token', 'raw'
                const payloadKeys = Object.keys(payloadArg.payload);
                expect(payloadKeys).not.toContain('password');
                expect(payloadKeys).not.toContain('secret');
                expect(payloadKeys).not.toContain('token');
            }
        }
    });
});
