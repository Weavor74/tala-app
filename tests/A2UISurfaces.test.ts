/**
 * A2UISurfaces.test.ts — Phase 4C: A2UI Workspace Surfaces
 *
 * Validates:
 *   1. Surface mappers — cognition, world, and maintenance mappers produce
 *      correct, bounded A2UI component trees from typed data sources.
 *   2. Routing — A2UIWorkspaceRouter assembles payloads and emits agent-events;
 *      stable tab IDs prevent duplicate tabs.
 *   3. Action bridge — allowlisted actions execute; invalid actions are rejected.
 *   4. Telemetry — open/update/action events are emitted with correct payloads.
 *   5. Workspace UX — a2ui surfaces target the document/editor pane (tabId prefix);
 *      no inline chat content.
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

import type { CognitiveDiagnosticsSnapshot } from '../shared/cognitiveTurnTypes';
import type { TalaWorldModel } from '../shared/worldModelTypes';
import type { MaintenanceDiagnosticsSummary } from '../shared/maintenance/maintenanceTypes';
import type { A2UISurfacePayload } from '../shared/a2uiTypes';
import { mapCognitionSurface } from '../electron/services/cognitive/CognitionSurfaceMapper';
import { mapWorldSurface } from '../electron/services/world/WorldSurfaceMapper';
import { mapMaintenanceSurface } from '../electron/services/maintenance/MaintenanceSurfaceMapper';
import { A2UIWorkspaceRouter } from '../electron/services/A2UIWorkspaceRouter';
import { A2UIActionBridge } from '../electron/services/A2UIActionBridge';
import { telemetry } from '../electron/services/TelemetryService';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCognitionSnapshot(overrides: Partial<CognitiveDiagnosticsSnapshot> = {}): CognitiveDiagnosticsSnapshot {
    const now = new Date().toISOString();
    return {
        timestamp: now,
        activeMode: 'assistant',
        memoryContributionSummary: {
            totalApplied: 3,
            byCategory: { identity: 1, task_relevant: 2 },
            retrievalSuppressed: false,
        },
        docContributionSummary: {
            applied: true,
            sourceCount: 2,
        },
        emotionalModulationStatus: {
            applied: true,
            strength: 'low',
            astroUnavailable: false,
        },
        reflectionNoteStatus: {
            activeNoteCount: 1,
            suppressedNoteCount: 0,
            applied: true,
        },
        lastPolicyAppliedAt: now,
        ...overrides,
    };
}

function makeWorldModel(overrides: Partial<TalaWorldModel> = {}): TalaWorldModel {
    const now = new Date().toISOString();
    const meta = {
        assembledAt: now,
        freshness: 'fresh' as const,
        availability: 'available' as const,
    };
    return {
        timestamp: now,
        assemblyMode: 'full' as const,
        workspace: {
            meta,
            workspaceRoot: '/home/user/workspace',
            classification: 'repo' as const,
            rootResolved: true,
            knownDirectories: ['src', 'electron', 'shared', 'docs'],
            recentFiles: [],
            activeFiles: [],
            openArtifactCount: 0,
        },
        repo: {
            meta,
            repoRoot: '/home/user/workspace',
            isRepo: true,
            branch: 'main',
            isDirty: false,
            changedFileCount: 0,
            projectType: 'electron_app' as const,
            detectedDirectories: ['src', 'electron'],
            hasArchitectureDocs: true,
            hasIndexedDocs: false,
        },
        runtime: {
            meta,
            inferenceReady: true,
            selectedProviderId: 'ollama',
            selectedProviderName: 'Ollama',
            totalProviders: 1,
            readyProviders: 1,
            degradedSubsystems: [],
            hasActiveDegradation: false,
            streamActive: false,
        },
        tools: {
            meta,
            enabledTools: [],
            blockedTools: [],
            degradedTools: [],
            mcpServices: [],
            totalMcpServices: 2,
            readyMcpServices: 2,
        },
        providers: {
            meta,
            preferredProviderId: 'ollama',
            preferredProviderName: 'Ollama',
            availableProviders: ['ollama'],
            suppressedProviders: [],
            degradedProviders: [],
            totalProviders: 1,
            lastFallbackApplied: false,
        },
        goals: {
            meta,
            immediateTask: 'Test A2UI surfaces',
            immediateTaskConfidence: 'high' as const,
            currentProjectFocus: 'tala-app',
            projectFocusConfidence: 'high' as const,
            stableDirection: undefined,
            hasExplicitGoal: false,
            isStale: false,
        },
        summary: {
            hasDegradedSections: false,
            hasUnavailableSections: false,
            degradedSections: [],
            unavailableSections: [],
            activeAlerts: [],
            taskFocus: 'Test A2UI surfaces',
        },
        ...overrides,
    } as TalaWorldModel;
}

function makeMaintenanceSummary(overrides: Partial<MaintenanceDiagnosticsSummary> = {}): MaintenanceDiagnosticsSummary {
    const now = new Date().toISOString();
    return {
        lastCheckedAt: now,
        mode: 'safe_auto_recovery',
        activeIssues: [],
        recentDecisions: [],
        recentExecutions: [],
        hasPendingAutoAction: false,
        hasApprovalNeededAction: false,
        issueCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        cooldownEntities: [],
        ...overrides,
    };
}

// ─── Mock aggregator / services ───────────────────────────────────────────────

function makeMockAggregator(cogSnapshot?: CognitiveDiagnosticsSnapshot | null) {
    return {
        getSnapshot: vi.fn().mockReturnValue({
            timestamp: new Date().toISOString(),
            cognitive: cogSnapshot ?? null,
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
    } as any;
}

function makeMockWorldAssembler(model?: TalaWorldModel | null) {
    return {
        getCachedModel: vi.fn().mockReturnValue(model ?? null),
    } as any;
}

function makeMockMaintenanceService(summary?: MaintenanceDiagnosticsSummary | null) {
    return {
        getDiagnosticsSummary: vi.fn().mockReturnValue(summary ?? null),
        runCycle: vi.fn().mockResolvedValue(undefined),
        setMode: vi.fn(),
    } as any;
}

function makeMockWindow() {
    const sentEvents: Array<{ channel: string; args: any[] }> = [];
    const win = {
        isDestroyed: vi.fn().mockReturnValue(false),
        webContents: {
            send: vi.fn((channel: string, ...args: any[]) => {
                sentEvents.push({ channel, args });
            }),
        },
        _sentEvents: sentEvents,
    };
    return win as any;
}

// ─── 1. Surface mappers ────────────────────────────────────────────────────────

describe('CognitionSurfaceMapper', () => {
    it('maps a full snapshot to a valid surface payload', () => {
        const snapshot = makeCognitionSnapshot();
        const payload = mapCognitionSurface(snapshot);

        expect(payload.surfaceId).toBe('cognition');
        expect(payload.tabId).toBe('a2ui:cognition');
        expect(payload.title).toBe('Cognition');
        expect(payload.dataSource).toBe('cognition:diagnostics_snapshot');
        expect(Array.isArray(payload.components)).toBe(true);
        expect(payload.components.length).toBeGreaterThan(0);
    });

    it('produces a fallback payload when snapshot is null', () => {
        const payload = mapCognitionSurface(null);
        expect(payload.surfaceId).toBe('cognition');
        expect(payload.dataSource).toBe('cognition:no_data');
        expect(payload.components).toHaveLength(1);
        expect(payload.components[0].type).toBe('Card');
    });

    it('includes mode badge with correct label', () => {
        const snapshot = makeCognitionSnapshot({ activeMode: 'rp' });
        const payload = mapCognitionSurface(snapshot);

        // Find the mode section
        const modeSection = payload.components.find(c => c.id === 'cog-mode-section');
        expect(modeSection).toBeDefined();
        const badge = modeSection?.children?.find(c => c.type === 'Badge');
        expect(badge?.props?.label).toBe('RP');
    });

    it('shows memory suppression when retrieval is suppressed', () => {
        const snapshot = makeCognitionSnapshot({
            memoryContributionSummary: { totalApplied: 0, byCategory: {}, retrievalSuppressed: true },
        });
        const payload = mapCognitionSurface(snapshot);
        const memSection = payload.components.find(c => c.id === 'cog-memory-section');
        const textNode = memSection?.children?.find(c => c.type === 'Text');
        expect(textNode?.props?.content).toContain('suppressed');
    });

    it('shows astro unavailable notice when astro is down', () => {
        const snapshot = makeCognitionSnapshot({
            emotionalModulationStatus: { applied: false, strength: 'none', astroUnavailable: true },
        });
        const payload = mapCognitionSurface(snapshot);
        const emoSection = payload.components.find(c => c.id === 'cog-emo-section');
        const unavailNode = emoSection?.children?.find(c => c.id === 'cog-emo-unavail');
        expect(unavailNode).toBeDefined();
    });
});

describe('WorldSurfaceMapper', () => {
    it('maps a full world model to a valid surface payload', () => {
        const model = makeWorldModel();
        const payload = mapWorldSurface(model);

        expect(payload.surfaceId).toBe('world');
        expect(payload.tabId).toBe('a2ui:world');
        expect(payload.title).toBe('World Model');
        expect(payload.dataSource).toBe('world:world_model_assembler');
        expect(payload.components.length).toBeGreaterThan(0);
    });

    it('produces a fallback payload when world model is null', () => {
        const payload = mapWorldSurface(null);
        expect(payload.surfaceId).toBe('world');
        expect(payload.dataSource).toBe('world:no_data');
        expect(payload.components[0].type).toBe('Card');
    });

    it('shows workspace root when resolved', () => {
        const model = makeWorldModel();
        const payload = mapWorldSurface(model);
        const wsSection = payload.components.find(c => c.id === 'world-workspace');
        const rootNode = wsSection?.children?.find(c => c.id === 'world-ws-root');
        expect(rootNode?.props?.content).toContain('/home/user/workspace');
    });

    it('shows no-git notice when git unavailable', () => {
        const model = makeWorldModel();
        (model.repo as any).isRepo = false;
        const payload = mapWorldSurface(model);
        const rsSection = payload.components.find(c => c.id === 'world-repo');
        const noGitNode = rsSection?.children?.find(c => c.id === 'world-rs-nogit');
        expect(noGitNode).toBeDefined();
    });

    it('shows immediate task in user goal section', () => {
        const model = makeWorldModel();
        const payload = mapWorldSurface(model);
        const ugSection = payload.components.find(c => c.id === 'world-usergoal');
        const taskNode = ugSection?.children?.find(c => c.id === 'world-ug-immediate');
        expect(taskNode?.props?.content).toContain('Test A2UI surfaces');
    });
});

describe('MaintenanceSurfaceMapper', () => {
    it('maps a full maintenance summary to a valid surface payload', () => {
        const summary = makeMaintenanceSummary();
        const payload = mapMaintenanceSurface(summary);

        expect(payload.surfaceId).toBe('maintenance');
        expect(payload.tabId).toBe('a2ui:maintenance');
        expect(payload.title).toBe('Maintenance');
        expect(payload.dataSource).toBe('maintenance:maintenance_loop_service');
        expect(payload.components.length).toBeGreaterThan(0);
    });

    it('produces a fallback payload when summary is null', () => {
        const payload = mapMaintenanceSurface(null);
        expect(payload.surfaceId).toBe('maintenance');
        expect(payload.dataSource).toBe('maintenance:no_data');
        expect(payload.components[0].type).toBe('Card');
    });

    it('shows maintenance mode badge', () => {
        const summary = makeMaintenanceSummary({ mode: 'recommend_only' });
        const payload = mapMaintenanceSurface(summary);
        const header = payload.components.find(c => c.id === 'maint-header');
        const badge = header?.children?.find(c => c.type === 'Badge');
        expect(badge?.props?.label).toBe('Recommend Only');
    });

    it('shows no issues text when no active issues', () => {
        const payload = mapMaintenanceSurface(makeMaintenanceSummary({ activeIssues: [] }));
        const issueSection = payload.components.find(c => c.id === 'maint-active-issues');
        const noIssues = issueSection?.children?.find(c => c.id === 'maint-no-active');
        expect(noIssues).toBeDefined();
    });

    it('includes run_maintenance_check button action', () => {
        const payload = mapMaintenanceSurface(makeMaintenanceSummary());
        const actionsSection = payload.components.find(c => c.id === 'maint-actions');
        const runBtn = actionsSection?.children?.find(c => c.id === 'maint-run-check');
        expect(runBtn?.props?.['data-action']).toBe('run_maintenance_check');
    });

    it('shows active issues table when issues exist', () => {
        const summary = makeMaintenanceSummary({
            activeIssues: [
                {
                    id: 'issue-1',
                    category: 'provider_unavailable',
                    severity: 'high',
                    confidence: 0.9,
                    detectedAt: new Date().toISOString(),
                    sourceSubsystem: 'inference',
                    description: 'Provider down',
                    recommendedAction: 'Restart provider',
                    autoSafe: true,
                },
            ],
            issueCounts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        });
        const payload = mapMaintenanceSurface(summary);
        const issueSection = payload.components.find(c => c.id === 'maint-active-issues');
        const table = issueSection?.children?.find(c => c.type === 'Table');
        expect(table).toBeDefined();
        expect((table?.props?.rows as any[]).length).toBe(1);
    });
});

// ─── 2. A2UIWorkspaceRouter ───────────────────────────────────────────────────

describe('A2UIWorkspaceRouter', () => {
    let mockWin: ReturnType<typeof makeMockWindow>;
    let router: A2UIWorkspaceRouter;

    beforeEach(() => {
        vi.clearAllMocks();
        mockWin = makeMockWindow();
        router = new A2UIWorkspaceRouter({
            getMainWindow: () => mockWin,
            diagnosticsAggregator: makeMockAggregator(makeCognitionSnapshot()),
            worldModelAssembler: makeMockWorldAssembler(makeWorldModel()),
            maintenanceLoopService: makeMockMaintenanceService(makeMaintenanceSummary()),
        });
    });

    it('emits agent-event with a2ui-surface-open type for cognition', async () => {
        const payload = await router.openSurface('cognition');
        expect(payload).not.toBeNull();
        expect(mockWin.webContents.send).toHaveBeenCalledWith('agent-event', {
            type: 'a2ui-surface-open',
            data: expect.objectContaining({ surfaceId: 'cognition', tabId: 'a2ui:cognition' }),
        });
    });

    it('emits agent-event for world surface', async () => {
        await router.openSurface('world');
        expect(mockWin.webContents.send).toHaveBeenCalledWith('agent-event', {
            type: 'a2ui-surface-open',
            data: expect.objectContaining({ surfaceId: 'world', tabId: 'a2ui:world' }),
        });
    });

    it('emits agent-event for maintenance surface', async () => {
        await router.openSurface('maintenance');
        expect(mockWin.webContents.send).toHaveBeenCalledWith('agent-event', {
            type: 'a2ui-surface-open',
            data: expect.objectContaining({ surfaceId: 'maintenance', tabId: 'a2ui:maintenance' }),
        });
    });

    it('emits a2ui_surface_open_requested telemetry', async () => {
        await router.openSurface('cognition');
        expect(telemetry.event).toHaveBeenCalledWith('a2ui_surface_open_requested', expect.objectContaining({
            surfaceId: 'cognition',
            targetPane: 'document_editor',
        }));
    });

    it('emits a2ui_surface_opened telemetry on success', async () => {
        await router.openSurface('cognition');
        expect(telemetry.event).toHaveBeenCalledWith(
            expect.stringMatching(/a2ui_surface_(opened|updated)/),
            expect.objectContaining({ outcome: 'success' })
        );
    });

    it('returns null and emits failure telemetry when window is destroyed', async () => {
        mockWin.isDestroyed.mockReturnValue(true);
        const payload = await router.openSurface('cognition');
        expect(payload).toBeNull();
        expect(telemetry.event).toHaveBeenCalledWith('a2ui_surface_failed', expect.objectContaining({
            surfaceId: 'cognition',
            outcome: 'failure',
        }));
    });

    it('uses stable tab ID for cognition surface', async () => {
        const p1 = await router.openSurface('cognition');
        const p2 = await router.openSurface('cognition');
        expect(p1?.tabId).toBe(p2?.tabId);
        expect(p1?.tabId).toBe('a2ui:cognition');
    });

    it('isSurfaceOpen returns true after opening', async () => {
        expect(router.isSurfaceOpen('cognition')).toBe(false);
        await router.openSurface('cognition');
        expect(router.isSurfaceOpen('cognition')).toBe(true);
    });

    it('getDiagnosticsSummary reflects open surfaces', async () => {
        await router.openSurface('world');
        const diag = router.getDiagnosticsSummary();
        expect(diag.openSurfaces.length).toBe(1);
        expect(diag.openSurfaces[0].surfaceId).toBe('world');
        expect(diag.surfaceUpdateCount).toBe(1);
    });

    it('falls back gracefully when world model is unavailable', async () => {
        const routerNoWorld = new A2UIWorkspaceRouter({
            getMainWindow: () => mockWin,
            diagnosticsAggregator: makeMockAggregator(),
            worldModelAssembler: makeMockWorldAssembler(null),
            maintenanceLoopService: makeMockMaintenanceService(),
        });
        const payload = await routerNoWorld.openSurface('world');
        expect(payload).not.toBeNull();
        expect(payload?.dataSource).toBe('world:no_data');
    });
});

// ─── 3. A2UIActionBridge ──────────────────────────────────────────────────────

describe('A2UIActionBridge', () => {
    let mockWin: ReturnType<typeof makeMockWindow>;
    let router: A2UIWorkspaceRouter;
    let bridge: A2UIActionBridge;
    let mockMaintSvc: ReturnType<typeof makeMockMaintenanceService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockWin = makeMockWindow();
        router = new A2UIWorkspaceRouter({
            getMainWindow: () => mockWin,
            diagnosticsAggregator: makeMockAggregator(makeCognitionSnapshot()),
            worldModelAssembler: makeMockWorldAssembler(makeWorldModel()),
            maintenanceLoopService: makeMockMaintenanceService(makeMaintenanceSummary()),
        });
        mockMaintSvc = makeMockMaintenanceService(makeMaintenanceSummary());
        bridge = new A2UIActionBridge({
            router,
            maintenanceLoopService: mockMaintSvc,
        });
    });

    it('rejects actions not in the allowlist', async () => {
        const result = await bridge.dispatch({
            surfaceId: 'cognition',
            actionName: 'delete_all_memories' as any,
            payload: {},
        });
        expect(result.success).toBe(false);
        expect(result.error).toBe('not_in_allowlist');
        expect(telemetry.event).toHaveBeenCalledWith('a2ui_action_failed', expect.objectContaining({
            outcome: 'rejected',
        }));
    });

    it('dispatches open_cognition_surface successfully', async () => {
        const result = await bridge.dispatch({
            surfaceId: 'cognition',
            actionName: 'open_cognition_surface',
        });
        expect(result.success).toBe(true);
        expect(result.updatedSurface?.surfaceId).toBe('cognition');
    });

    it('dispatches open_world_surface successfully', async () => {
        const result = await bridge.dispatch({
            surfaceId: 'world',
            actionName: 'open_world_surface',
        });
        expect(result.success).toBe(true);
        expect(result.updatedSurface?.surfaceId).toBe('world');
    });

    it('dispatches run_maintenance_check and refreshes surface', async () => {
        const result = await bridge.dispatch({
            surfaceId: 'maintenance',
            actionName: 'run_maintenance_check',
        });
        expect(result.success).toBe(true);
        expect(mockMaintSvc.runCycle).toHaveBeenCalled();
        expect(result.updatedSurface?.surfaceId).toBe('maintenance');
    });

    it('dispatches switch_maintenance_mode with valid mode', async () => {
        const result = await bridge.dispatch({
            surfaceId: 'maintenance',
            actionName: 'switch_maintenance_mode',
            payload: { mode: 'observation_only' },
        });
        expect(result.success).toBe(true);
        expect(mockMaintSvc.setMode).toHaveBeenCalledWith('observation_only');
    });

    it('rejects switch_maintenance_mode with invalid mode', async () => {
        const result = await bridge.dispatch({
            surfaceId: 'maintenance',
            actionName: 'switch_maintenance_mode',
            payload: { mode: 'destroy_everything' },
        });
        expect(result.success).toBe(false);
        expect(result.error).toBe('invalid_mode');
    });

    it('emits a2ui_action_received telemetry on dispatch', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'refresh_cognition' });
        expect(telemetry.event).toHaveBeenCalledWith('a2ui_action_received', expect.objectContaining({
            actionName: 'refresh_cognition',
        }));
    });

    it('emits a2ui_action_validated telemetry for allowlisted action', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'refresh_cognition' });
        expect(telemetry.event).toHaveBeenCalledWith('a2ui_action_validated', expect.objectContaining({
            actionName: 'refresh_cognition',
        }));
    });

    it('emits a2ui_action_executed telemetry on success', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'refresh_cognition' });
        expect(telemetry.event).toHaveBeenCalledWith('a2ui_action_executed', expect.objectContaining({
            outcome: 'success',
        }));
    });

    it('returns service_unavailable when maintenance service missing', async () => {
        const bridgeNoSvc = new A2UIActionBridge({ router });
        const result = await bridgeNoSvc.dispatch({
            surfaceId: 'maintenance',
            actionName: 'run_maintenance_check',
        });
        expect(result.success).toBe(false);
        expect(result.error).toBe('service_unavailable');
    });

    it('getActionCounts increments dispatched count', async () => {
        await bridge.dispatch({ surfaceId: 'cognition', actionName: 'refresh_cognition' });
        await bridge.dispatch({ surfaceId: 'world', actionName: 'refresh_world' });
        const counts = bridge.getActionCounts();
        expect(counts.dispatched).toBe(2);
    });
});

// ─── 4. Workspace UX rules ────────────────────────────────────────────────────

describe('Workspace UX Rules', () => {
    it('all surface tabIds start with a2ui: prefix (editor-pane-first)', () => {
        const cognition = mapCognitionSurface(makeCognitionSnapshot());
        const world = mapWorldSurface(makeWorldModel());
        const maint = mapMaintenanceSurface(makeMaintenanceSummary());

        expect(cognition.tabId).toMatch(/^a2ui:/);
        expect(world.tabId).toMatch(/^a2ui:/);
        expect(maint.tabId).toMatch(/^a2ui:/);
    });

    it('surface payloads carry assembledAt timestamp', () => {
        const cognition = mapCognitionSurface(makeCognitionSnapshot());
        expect(cognition.assembledAt).toBeTruthy();
        expect(() => new Date(cognition.assembledAt)).not.toThrow();
    });

    it('surface payloads are JSON-serializable (IPC-safe)', () => {
        const payload = mapCognitionSurface(makeCognitionSnapshot()) as A2UISurfacePayload;
        expect(() => JSON.stringify(payload)).not.toThrow();
        const parsed = JSON.parse(JSON.stringify(payload));
        expect(parsed.surfaceId).toBe('cognition');
        expect(Array.isArray(parsed.components)).toBe(true);
    });

    it('router does not emit webContents.send to chat channel', async () => {
        const mockWin = makeMockWindow();
        const router = new A2UIWorkspaceRouter({
            getMainWindow: () => mockWin,
            diagnosticsAggregator: makeMockAggregator(makeCognitionSnapshot()),
            worldModelAssembler: makeMockWorldAssembler(makeWorldModel()),
            maintenanceLoopService: makeMockMaintenanceService(makeMaintenanceSummary()),
        });
        await router.openSurface('cognition');

        // All sends must be via agent-event, not direct chat channels
        for (const evt of mockWin._sentEvents) {
            expect(evt.channel).toBe('agent-event');
            expect(evt.args[0]?.type).toBe('a2ui-surface-open');
        }
    });
});
