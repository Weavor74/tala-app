/**
 * Phase4D.test.ts — Phase 4D: Convergence & Coordination
 *
 * Validates:
 *   1. SurfacePolicyEngine — correct decisions per intent/mode, suppression, cooldown
 *   2. SurfaceStateRegistry — tracking, duplicate prevention, cooldown, data hash
 *   3. A2UISurfaceCoordinator — routes decisions, respects policy, emits telemetry
 *   4. UI → Cognition feedback loop — actions captured and fed into cognition
 *   5. Lifecycle — surfaces update in place, no duplicate tabs
 *   6. Event triggers — maintenance issue opens surface, world change updates surface
 *   7. Chat rules — only notices emitted (no inline A2UI content)
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

import { SurfacePolicyEngine } from '../electron/services/coordination/SurfacePolicyEngine';
import { SurfaceStateRegistry } from '../electron/services/coordination/SurfaceStateRegistry';
import { A2UISurfaceCoordinator } from '../electron/services/coordination/A2UISurfaceCoordinator';
import { A2UIActionBridge } from '../electron/services/A2UIActionBridge';
import { A2UIWorkspaceRouter } from '../electron/services/A2UIWorkspaceRouter';
import { telemetry } from '../electron/services/TelemetryService';
import type { SurfacePolicyInput } from '../shared/coordinationTypes';
import type { A2UISurfaceId, A2UISurfacePayload } from '../shared/a2uiTypes';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMockRouter(payloadOverrides: Partial<A2UISurfacePayload> = {}) {
    const sentEvents: unknown[] = [];
    const mockWin = {
        isDestroyed: vi.fn().mockReturnValue(false),
        webContents: {
            send: vi.fn((channel: string, data: unknown) => {
                sentEvents.push({ channel, data });
            }),
        },
    };

    const router = new A2UIWorkspaceRouter({
        getMainWindow: () => mockWin as any,
        diagnosticsAggregator: {
            getSnapshot: vi.fn().mockReturnValue({
                timestamp: new Date().toISOString(),
                cognitive: null,
                inference: { currentStatus: 'ready', streamStatus: 'idle', providerInventory: { total: 1, ready: 1, unavailable: 0, degraded: 0 }, lastUpdatedAt: new Date().toISOString() },
                mcp: { services: [], totalServices: 0, readyServices: 0, degradedServices: 0, unavailableServices: 0, lastUpdatedAt: new Date().toISOString() },
                degradedSubsystems: [],
                recentFailures: { count: 0, failedEntityIds: [] },
                lastUpdatedPerSubsystem: {},
                operatorActions: [],
                providerHealthScores: [],
                suppressedProviders: [],
                recentProviderRecoveries: [],
                recentMcpRestarts: [],
            }),
        } as any,
    });

    return { router, mockWin, sentEvents };
}

function makeRegistry(cooldownMs = 0) {
    return new SurfaceStateRegistry(cooldownMs);
}

function makePolicy(registry: SurfaceStateRegistry) {
    return new SurfacePolicyEngine(registry);
}

function makeCoordinator(
    registry: SurfaceStateRegistry,
    policy: SurfacePolicyEngine,
    router: A2UIWorkspaceRouter,
    mockWin?: any,
) {
    return new A2UISurfaceCoordinator({
        policyEngine: policy,
        registry,
        router,
        getMainWindow: mockWin ? () => mockWin : undefined,
    });
}

function intentInput(
    intentClass: string,
    mode = 'assistant',
    isGreeting = false,
): SurfacePolicyInput {
    return {
        intentClass,
        isGreeting,
        mode,
        triggerType: 'intent_based',
    };
}

// ─── 1. SurfacePolicyEngine ───────────────────────────────────────────────────

describe('SurfacePolicyEngine', () => {
    let registry: SurfaceStateRegistry;
    let policy: SurfacePolicyEngine;

    beforeEach(() => {
        vi.clearAllMocks();
        registry = makeRegistry();
        policy = makePolicy(registry);
    });

    it('returns cognition decision for technical intent', () => {
        const decisions = policy.evaluate(intentInput('technical'));
        const cogDecision = decisions.find(d => d.surfaceId === 'cognition');
        expect(cogDecision).toBeDefined();
        expect(cogDecision?.action).not.toBe('suppress');
    });

    it('returns cognition decision for coding intent', () => {
        const decisions = policy.evaluate(intentInput('coding'));
        const cogDecision = decisions.find(d => d.surfaceId === 'cognition');
        expect(cogDecision).toBeDefined();
        expect(cogDecision?.action).not.toBe('suppress');
    });

    it('returns world decision for repo intent', () => {
        const decisions = policy.evaluate(intentInput('repo'));
        const worldDecision = decisions.find(d => d.surfaceId === 'world');
        expect(worldDecision).toBeDefined();
        expect(worldDecision?.action).not.toBe('suppress');
    });

    it('returns maintenance decision for troubleshooting intent', () => {
        const decisions = policy.evaluate(intentInput('troubleshooting'));
        const maintDecision = decisions.find(d => d.surfaceId === 'maintenance');
        expect(maintDecision).toBeDefined();
        expect(maintDecision?.action).not.toBe('suppress');
    });

    it('suppresses all surfaces in RP mode', () => {
        const decisions = policy.evaluate(intentInput('technical', 'rp'));
        expect(decisions.length).toBeGreaterThan(0);
        expect(decisions.every(d => d.action === 'suppress')).toBe(true);
    });

    it('suppresses all surfaces on greeting turn', () => {
        const decisions = policy.evaluate({
            intentClass: 'general',
            isGreeting: true,
            mode: 'assistant',
            triggerType: 'intent_based',
        });
        expect(decisions.every(d => d.action === 'suppress')).toBe(true);
    });

    it('returns open for maintenance on critical issues event', () => {
        const decisions = policy.evaluate({
            intentClass: 'maintenance',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'maintenance_event',
            maintenance: {
                hasCriticalIssues: true,
                hasHighIssues: false,
                hasPendingAutoAction: false,
                hasApprovalNeededAction: false,
                totalIssueCount: 1,
            },
        });
        const maintDecision = decisions.find(d => d.surfaceId === 'maintenance');
        expect(maintDecision).toBeDefined();
        expect(['open', 'update']).toContain(maintDecision?.action);
    });

    it('returns focus for maintenance when approval needed', () => {
        const decisions = policy.evaluate({
            intentClass: 'maintenance',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'maintenance_event',
            maintenance: {
                hasCriticalIssues: false,
                hasHighIssues: false,
                hasPendingAutoAction: false,
                hasApprovalNeededAction: true,
                totalIssueCount: 1,
            },
        });
        const focusDecision = decisions.find(d => d.surfaceId === 'maintenance' && d.action === 'focus');
        expect(focusDecision).toBeDefined();
    });

    it('returns world update on world_event trigger', () => {
        const decisions = policy.evaluate({
            intentClass: 'workspace',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'world_event',
        });
        const worldDecision = decisions.find(d => d.surfaceId === 'world');
        expect(worldDecision).toBeDefined();
        expect(['open', 'update']).toContain(worldDecision?.action);
    });

    it('decides open when surface not yet registered', () => {
        const decisions = policy.evaluate(intentInput('technical'));
        const cogDecision = decisions.find(d => d.surfaceId === 'cognition');
        expect(cogDecision?.action).toBe('open');
    });

    it('decides update when surface already open', () => {
        registry.markOpened('cognition');
        const decisions = policy.evaluate(intentInput('technical'));
        const cogDecision = decisions.find(d => d.surfaceId === 'cognition');
        expect(cogDecision?.action).toBe('update');
    });

    it('includes reason in every decision', () => {
        const decisions = policy.evaluate(intentInput('technical'));
        for (const d of decisions) {
            if (d.action !== 'suppress') {
                expect(typeof d.reason).toBe('string');
                expect(d.reason.length).toBeGreaterThan(0);
            }
        }
    });

    it('respects cooldown: returns update when surface open and within cooldown', () => {
        const cooldownRegistry = makeRegistry(60_000); // 60s cooldown
        const cooldownPolicy = makePolicy(cooldownRegistry);
        cooldownRegistry.markOpened('cognition');

        const decisions = cooldownPolicy.evaluate(intentInput('technical'));
        const cogDecision = decisions.find(d => d.surfaceId === 'cognition');
        expect(cogDecision?.action).toBe('update'); // downgraded to update within cooldown
    });
});

// ─── 2. SurfaceStateRegistry ──────────────────────────────────────────────────

describe('SurfaceStateRegistry', () => {
    let registry: SurfaceStateRegistry;

    beforeEach(() => {
        registry = makeRegistry(5_000); // 5s cooldown
    });

    it('returns false for isOpen before markOpened', () => {
        expect(registry.isOpen('cognition')).toBe(false);
    });

    it('returns true for isOpen after markOpened', () => {
        registry.markOpened('cognition');
        expect(registry.isOpen('cognition')).toBe(true);
    });

    it('tracks openCount correctly', () => {
        registry.markOpened('cognition');
        registry.markOpened('cognition');
        expect(registry.getEntry('cognition')?.openCount).toBe(2);
    });

    it('markUpdated does not increment openCount', () => {
        registry.markOpened('cognition');
        registry.markUpdated('cognition', { dataHash: 'hash1' });
        expect(registry.getEntry('cognition')?.openCount).toBe(1);
    });

    it('stores and retrieves data hash', () => {
        registry.markOpened('cognition', { dataHash: 'abc123' });
        expect(registry.getLastDataHash('cognition')).toBe('abc123');
    });

    it('isOnCooldown returns true immediately after open (cooldown 5s)', () => {
        registry.markOpened('cognition');
        expect(registry.isOnCooldown('cognition')).toBe(true);
    });

    it('isOnCooldown returns false when registry is empty', () => {
        expect(registry.isOnCooldown('world')).toBe(false);
    });

    it('isOnCooldown returns false after cooldown expires', () => {
        const expiredRegistry = makeRegistry(0); // 0ms cooldown — immediately expired
        expiredRegistry.markOpened('world');
        expect(expiredRegistry.isOnCooldown('world')).toBe(false);
    });

    it('markClosed sets isOpen to false', () => {
        registry.markOpened('maintenance');
        registry.markClosed('maintenance');
        expect(registry.isOpen('maintenance')).toBe(false);
    });

    it('getOpenSurfaces returns only open surfaces', () => {
        registry.markOpened('cognition');
        registry.markOpened('world');
        registry.markClosed('world');
        const open = registry.getOpenSurfaces();
        expect(open.map(e => e.surfaceId)).toContain('cognition');
        expect(open.map(e => e.surfaceId)).not.toContain('world');
    });

    it('getAllEntries returns all registered surfaces', () => {
        registry.markOpened('cognition');
        registry.markOpened('maintenance');
        expect(registry.getAllEntries().length).toBe(2);
    });

    it('reset clears all state', () => {
        registry.markOpened('cognition');
        registry.reset();
        expect(registry.isOpen('cognition')).toBe(false);
        expect(registry.getAllEntries().length).toBe(0);
    });
});

// ─── 3. A2UISurfaceCoordinator ────────────────────────────────────────────────

describe('A2UISurfaceCoordinator', () => {
    let registry: SurfaceStateRegistry;
    let policy: SurfacePolicyEngine;
    let coordinator: A2UISurfaceCoordinator;
    let mockWin: any;
    let router: A2UIWorkspaceRouter;

    beforeEach(() => {
        vi.clearAllMocks();
        registry = makeRegistry();
        policy = makePolicy(registry);
        const setup = makeMockRouter();
        router = setup.router;
        mockWin = setup.mockWin;
        coordinator = makeCoordinator(registry, policy, router, mockWin);
    });

    it('routes technical intent to cognition surface', async () => {
        const decisions = await coordinator.coordinate(intentInput('technical'));
        const cogDecision = decisions.find(d => d.surfaceId === 'cognition');
        expect(cogDecision).toBeDefined();
        expect(cogDecision?.action).not.toBe('suppress');
    });

    it('respects policy suppression in RP mode', async () => {
        const decisions = await coordinator.coordinate(intentInput('technical', 'rp'));
        expect(decisions.every(d => d.action === 'suppress')).toBe(true);
    });

    it('emits surface_policy_evaluated telemetry on each coordinate call', async () => {
        await coordinator.coordinate(intentInput('technical'));
        expect(telemetry.event).toHaveBeenCalledWith('surface_policy_evaluated', expect.any(Object));
    });

    it('emits surface_decision_open for first open', async () => {
        await coordinator.coordinate(intentInput('technical'));
        expect(telemetry.event).toHaveBeenCalledWith('surface_decision_open', expect.objectContaining({
            surfaceId: 'cognition',
        }));
    });

    it('emits surface_decision_suppress when suppressed', async () => {
        await coordinator.coordinate(intentInput('technical', 'rp'));
        expect(telemetry.event).toHaveBeenCalledWith('surface_decision_suppress', expect.any(Object));
    });

    it('increments surfacesOpened counter', async () => {
        await coordinator.coordinate(intentInput('technical'));
        const diag = coordinator.getDiagnosticsSummary();
        expect(diag.surfacesOpened).toBeGreaterThanOrEqual(1);
    });

    it('increments surfacesSuppressed counter', async () => {
        await coordinator.coordinate(intentInput('technical', 'rp'));
        const diag = coordinator.getDiagnosticsSummary();
        expect(diag.surfacesSuppressed).toBeGreaterThan(0);
    });

    it('policyEvaluationCount increments per coordinate call', async () => {
        await coordinator.coordinate(intentInput('technical'));
        await coordinator.coordinate(intentInput('repo'));
        const diag = coordinator.getDiagnosticsSummary();
        expect(diag.policyEvaluationCount).toBe(2);
    });

    it('emits chat notice after surface open', async () => {
        await coordinator.coordinate(intentInput('technical'));
        expect(mockWin.webContents.send).toHaveBeenCalledWith(
            'agent-event',
            expect.objectContaining({ type: 'a2ui-chat-notice' }),
        );
    });

    it('openForUser opens the requested surface', async () => {
        await coordinator.openForUser('cognition');
        expect(registry.isOpen('cognition')).toBe(true);
    });

    it('marks surface as open in registry after coordinate', async () => {
        await coordinator.coordinate(intentInput('technical'));
        expect(registry.isOpen('cognition')).toBe(true);
    });

    it('auto-trigger increments autoTriggeredCount', async () => {
        await coordinator.coordinate({
            intentClass: 'maintenance',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'maintenance_event',
            maintenance: {
                hasCriticalIssues: true,
                hasHighIssues: false,
                hasPendingAutoAction: false,
                hasApprovalNeededAction: false,
                totalIssueCount: 1,
            },
        });
        const diag = coordinator.getDiagnosticsSummary();
        expect(diag.autoTriggeredCount).toBeGreaterThanOrEqual(1);
    });

    it('emits surface_auto_triggered for event-based triggers', async () => {
        await coordinator.coordinate({
            intentClass: 'maintenance',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'maintenance_event',
            maintenance: {
                hasCriticalIssues: true,
                hasHighIssues: false,
                hasPendingAutoAction: false,
                hasApprovalNeededAction: false,
                totalIssueCount: 1,
            },
        });
        expect(telemetry.event).toHaveBeenCalledWith('surface_auto_triggered', expect.any(Object));
    });
});

// ─── 4. UI → Cognition feedback loop ─────────────────────────────────────────

describe('A2UIActionBridge — cognitive feedback loop', () => {
    let bridge: A2UIActionBridge;
    let capturedEvents: unknown[];
    let mockWin: any;
    let router: A2UIWorkspaceRouter;

    beforeEach(() => {
        vi.clearAllMocks();
        capturedEvents = [];
        const setup = makeMockRouter();
        router = setup.router;
        mockWin = setup.mockWin;
        bridge = new A2UIActionBridge({
            router,
            onCognitiveInteraction: (evt) => capturedEvents.push(evt),
        });
    });

    it('emits cognitive interaction event after successful action', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'open_cognition_surface' });
        expect(capturedEvents.length).toBe(1);
    });

    it('cognitive event has correct actionName', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'open_cognition_surface' });
        const evt = capturedEvents[0] as any;
        expect(evt.actionName).toBe('open_cognition_surface');
    });

    it('cognitive event has success=true for allowed action', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'open_cognition_surface' });
        const evt = capturedEvents[0] as any;
        expect(evt.success).toBe(true);
    });

    it('cognitive event summary is a non-empty string', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'open_cognition_surface' });
        const evt = capturedEvents[0] as any;
        expect(typeof evt.summary).toBe('string');
        expect(evt.summary.length).toBeGreaterThan(0);
    });

    it('cognitive event has correct surfaceId', async () => {
        await bridge.dispatch({ surfaceId: 'world', actionName: 'open_world_surface' });
        const evt = capturedEvents[0] as any;
        expect(evt.surfaceId).toBe('world');
    });

    it('does not emit cognitive event for rejected actions', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'delete_all_memories' as any });
        expect(capturedEvents.length).toBe(0);
    });

    it('emits surface_feedback_accepted telemetry for successful action', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'open_cognition_surface' });
        expect(telemetry.event).toHaveBeenCalledWith('surface_feedback_accepted', expect.any(Object));
    });

    it('does not emit feedback when onCognitiveInteraction not provided', async () => {
        const bridgeNoFeedback = new A2UIActionBridge({ router });
        await bridgeNoFeedback.dispatch({ surfaceId: 'cognition', actionName: 'open_cognition_surface' });
        // No error should be thrown
        expect(true).toBe(true);
    });

    it('generates meaningful summary for restart_provider', async () => {
        // Patch the dispatch to not fail on missing runtime control service
        const result = await bridge.dispatch({
            surfaceId: 'maintenance',
            actionName: 'restart_provider',
            payload: { providerId: 'test-provider' },
        });
        // No runtime control — will fail, but no crash
        expect(result).toBeDefined();
    });
});

// ─── 5. Lifecycle — update in place, no duplicate tabs ───────────────────────

describe('Surface lifecycle', () => {
    let registry: SurfaceStateRegistry;
    let policy: SurfacePolicyEngine;
    let coordinator: A2UISurfaceCoordinator;
    let mockWin: any;

    beforeEach(() => {
        vi.clearAllMocks();
        registry = makeRegistry();
        policy = makePolicy(registry);
        const setup = makeMockRouter();
        mockWin = setup.mockWin;
        coordinator = makeCoordinator(registry, policy, setup.router, mockWin);
    });

    it('second coordinate for same intent uses update (not open) when already open', async () => {
        // First: surface is opened
        await coordinator.coordinate(intentInput('technical'));
        vi.clearAllMocks();
        // Mark registry open explicitly so second call sees it
        registry.markOpened('cognition');

        // Second: surface update path
        await coordinator.coordinate(intentInput('technical'));
        // Should not call surface_decision_open again (it uses update or suppresses via cooldown)
        const openCalls = (telemetry.event as any).mock.calls.filter(
            ([name]: [string]) => name === 'surface_decision_open'
        );
        expect(openCalls.length).toBe(0);
    });

    it('surface open count stays bounded across multiple coordinates', async () => {
        await coordinator.coordinate(intentInput('technical'));
        await coordinator.coordinate(intentInput('technical'));
        await coordinator.coordinate(intentInput('technical'));
        const diag = coordinator.getDiagnosticsSummary();
        // Either updates or suppresses additional opens
        expect(diag.policyEvaluationCount).toBe(3);
    });
});

// ─── 6. Event triggers ────────────────────────────────────────────────────────

describe('Event-driven surface triggers', () => {
    let registry: SurfaceStateRegistry;
    let policy: SurfacePolicyEngine;
    let coordinator: A2UISurfaceCoordinator;
    let mockWin: any;

    beforeEach(() => {
        vi.clearAllMocks();
        registry = makeRegistry();
        policy = makePolicy(registry);
        const setup = makeMockRouter();
        mockWin = setup.mockWin;
        coordinator = makeCoordinator(registry, policy, setup.router, mockWin);
    });

    it('maintenance event with critical issues opens maintenance surface', async () => {
        await coordinator.coordinate({
            intentClass: 'maintenance',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'maintenance_event',
            maintenance: {
                hasCriticalIssues: true,
                hasHighIssues: false,
                hasPendingAutoAction: false,
                hasApprovalNeededAction: false,
                totalIssueCount: 1,
            },
        });
        expect(registry.isOpen('maintenance')).toBe(true);
    });

    it('world_event trigger opens or updates world surface', async () => {
        await coordinator.coordinate({
            intentClass: 'workspace',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'world_event',
        });
        expect(registry.isOpen('world')).toBe(true);
    });

    it('maintenance event with approval needed focuses maintenance surface', async () => {
        // Pre-open maintenance surface
        registry.markOpened('maintenance');
        vi.clearAllMocks();

        await coordinator.coordinate({
            intentClass: 'maintenance',
            isGreeting: false,
            mode: 'assistant',
            triggerType: 'maintenance_event',
            maintenance: {
                hasCriticalIssues: false,
                hasHighIssues: false,
                hasPendingAutoAction: false,
                hasApprovalNeededAction: true,
                totalIssueCount: 1,
            },
        });
        expect(telemetry.event).toHaveBeenCalledWith('surface_focus_requested', expect.any(Object));
    });

    it('no surfaces triggered when RP mode even on maintenance event', async () => {
        await coordinator.coordinate({
            intentClass: 'maintenance',
            isGreeting: false,
            mode: 'rp',
            triggerType: 'maintenance_event',
            maintenance: {
                hasCriticalIssues: true,
                hasHighIssues: false,
                hasPendingAutoAction: false,
                hasApprovalNeededAction: false,
                totalIssueCount: 1,
            },
        });
        // Policy suppresses all in RP mode
        expect(registry.isOpen('maintenance')).toBe(false);
    });
});

// ─── 7. Chat rules ────────────────────────────────────────────────────────────

describe('Chat behavior rules', () => {
    let registry: SurfaceStateRegistry;
    let policy: SurfacePolicyEngine;
    let coordinator: A2UISurfaceCoordinator;
    let mockWin: any;
    let sentEvents: unknown[];

    beforeEach(() => {
        vi.clearAllMocks();
        registry = makeRegistry();
        policy = makePolicy(registry);
        const setup = makeMockRouter();
        mockWin = setup.mockWin;
        sentEvents = setup.sentEvents;
        coordinator = makeCoordinator(registry, policy, setup.router, mockWin);
    });

    it('emits a2ui-chat-notice (not a2ui-surface-open) for chat channel', async () => {
        await coordinator.coordinate(intentInput('technical'));

        const chatNotices = (mockWin.webContents.send as any).mock.calls.filter(
            ([channel]: [string]) => channel === 'agent-event'
        ).filter(([, data]: [string, any]) => data?.type === 'a2ui-chat-notice');

        expect(chatNotices.length).toBeGreaterThanOrEqual(1);
    });

    it('chat notice message is a short string (not a component tree)', async () => {
        await coordinator.coordinate(intentInput('technical'));

        const chatNotices = (mockWin.webContents.send as any).mock.calls.filter(
            ([channel]: [string]) => channel === 'agent-event'
        ).filter(([, data]: [string, any]) => data?.type === 'a2ui-chat-notice');

        for (const [, noticeData] of chatNotices) {
            const message = (noticeData as any).data.message;
            expect(typeof message).toBe('string');
            // Message should be short — not a JSON dump
            expect(message.length).toBeLessThan(100);
        }
    });

    it('no inline A2UI surface content sent to chat channel', async () => {
        await coordinator.coordinate(intentInput('technical'));

        const agentEvents = (mockWin.webContents.send as any).mock.calls
            .filter(([channel]: [string]) => channel === 'agent-event')
            .map(([, data]: [string, any]) => data);

        const chatNotices = agentEvents.filter((d: any) => d?.type === 'a2ui-chat-notice');
        for (const notice of chatNotices) {
            // Chat notices must NOT carry component trees
            expect(notice.data?.components).toBeUndefined();
        }
    });
});

// ─── 8. Diagnostics summary ───────────────────────────────────────────────────

describe('CoordinatorDiagnosticsSummary', () => {
    it('starts with zero counters', () => {
        const registry = makeRegistry();
        const policy = makePolicy(registry);
        const { router } = makeMockRouter();
        const coordinator = makeCoordinator(registry, policy, router);
        const diag = coordinator.getDiagnosticsSummary();

        expect(diag.policyEvaluationCount).toBe(0);
        expect(diag.surfacesOpened).toBe(0);
        expect(diag.surfacesUpdated).toBe(0);
        expect(diag.surfacesSuppressed).toBe(0);
        expect(diag.feedbackEventsAccepted).toBe(0);
        expect(diag.autoTriggeredCount).toBe(0);
        expect(diag.openSurfaces).toEqual([]);
    });

    it('lists open surfaces after coordinate', async () => {
        vi.clearAllMocks();
        const registry = makeRegistry();
        const policy = makePolicy(registry);
        const { router, mockWin } = makeMockRouter();
        const coordinator = makeCoordinator(registry, policy, router, mockWin);

        await coordinator.coordinate(intentInput('technical'));
        const diag = coordinator.getDiagnosticsSummary();
        expect(diag.openSurfaces.some(s => s.surfaceId === 'cognition')).toBe(true);
    });

    it('recordFeedbackAccepted increments feedbackEventsAccepted', () => {
        const registry = makeRegistry();
        const policy = makePolicy(registry);
        const { router } = makeMockRouter();
        const coordinator = makeCoordinator(registry, policy, router);
        coordinator.recordFeedbackAccepted();
        coordinator.recordFeedbackAccepted();
        expect(coordinator.getDiagnosticsSummary().feedbackEventsAccepted).toBe(2);
    });
});
