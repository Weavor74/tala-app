/**
 * WorldModel.test.ts — Phase 4A: World Model Foundation
 *
 * Validates:
 *   1. World model types — snapshot shape stable, partial sections supported, degraded markers preserved.
 *   2. WorkspaceStateBuilder — correct build, missing workspace handled safely.
 *   3. RepoStateBuilder — correct build, unavailable git state handled safely.
 *   4. RuntimeWorldStateProjector — diagnostics projected correctly, provider/tool states summarized.
 *   5. UserGoalStateBuilder — explicit goal outranks inferred, recent focus represented, stale marked.
 *   6. WorldModelAssembler — full build, partial build, telemetry emitted.
 *   7. Diagnostics summary — read model retrievable, no unsafe data leakage.
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

// Mock fs so tests don't depend on real filesystem layout
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: vi.fn((p: string) => {
            // Simulate a TALA-like workspace with specific directories present.
            if (typeof p !== 'string') return false;
            const normalized = p.replace(/\\/g, '/');
            const simulated = [
                '/workspace',
                '/workspace/.git',
                '/workspace/src',
                '/workspace/electron',
                '/workspace/shared',
                '/workspace/docs',
                '/workspace/tests',
                '/workspace/scripts',
            ];
            return simulated.some((s) => normalized === s || normalized.startsWith(s + '/'));
        }),
    };
});

import type { TalaWorldModel, WorkspaceState, RepoState, UserGoalState } from '../shared/worldModelTypes';
import { WorkspaceStateBuilder } from '../electron/services/world/WorkspaceStateBuilder';
import { RepoStateBuilder } from '../electron/services/world/RepoStateBuilder';
import { RuntimeWorldStateProjector } from '../electron/services/world/RuntimeWorldStateProjector';
import { UserGoalStateBuilder } from '../electron/services/world/UserGoalStateBuilder';
import { WorldModelAssembler } from '../electron/services/world/WorldModelAssembler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMinimalDiagnosticsSnapshot() {
    const now = new Date().toISOString();
    return {
        timestamp: now,
        inference: {
            selectedProviderId: 'ollama',
            selectedProviderName: 'Ollama',
            selectedProviderType: 'ollama',
            selectedProviderReady: true,
            lastUsedProviderId: 'ollama',
            attemptedProviders: ['ollama'],
            fallbackApplied: false,
            streamStatus: 'idle' as const,
            lastStreamStatus: 'completed' as const,
            providerInventorySummary: {
                total: 2,
                ready: 1,
                unavailable: 0,
                degraded: 1,
            },
            lastUpdated: now,
        },
        mcp: {
            services: [
                {
                    serviceId: 'mcp-docs',
                    displayName: 'Docs MCP',
                    kind: 'stdio' as const,
                    enabled: true,
                    status: 'ready' as const,
                    degraded: false,
                    ready: true,
                    restartCount: 0,
                    lastHealthCheck: now,
                    lastTransitionTime: now,
                },
            ],
            totalConfigured: 1,
            totalReady: 1,
            totalDegraded: 0,
            totalUnavailable: 0,
            criticalUnavailable: false,
            lastUpdated: now,
        },
        degradedSubsystems: [],
        recentFailures: { count: 0, failedEntityIds: [] },
        lastUpdatedPerSubsystem: { inference: now, mcp: now },
        operatorActions: [],
        providerHealthScores: [
            {
                providerId: 'ollama',
                failureStreak: 0,
                timeoutCount: 0,
                fallbackCount: 0,
                suppressed: false,
                effectivePriority: 1,
            },
        ],
        suppressedProviders: [],
        recentProviderRecoveries: [],
        recentMcpRestarts: [],
    };
}

// ─── 1. World model types ──────────────────────────────────────────────────────

describe('WorldModel types', () => {
    it('TalaWorldModel has all required top-level sections', () => {
        const model: TalaWorldModel = {
            timestamp: new Date().toISOString(),
            workspace: new WorkspaceStateBuilder().buildUnavailable('test'),
            repo: new RepoStateBuilder().buildUnavailable('/workspace', 'test'),
            runtime: new RuntimeWorldStateProjector().buildRuntimeUnavailable('test'),
            tools: new RuntimeWorldStateProjector().buildToolsUnavailable('test'),
            providers: new RuntimeWorldStateProjector().buildProvidersUnavailable('test'),
            goals: new UserGoalStateBuilder().buildUnavailable('test'),
            summary: {
                sectionsAvailable: 0,
                sectionsDegraded: 0,
                sectionsUnavailable: 6,
                hasActiveDegradation: false,
                repoDirty: false,
                alerts: [],
            },
            assemblyMode: 'degraded',
        };

        expect(model.workspace).toBeDefined();
        expect(model.repo).toBeDefined();
        expect(model.runtime).toBeDefined();
        expect(model.tools).toBeDefined();
        expect(model.providers).toBeDefined();
        expect(model.goals).toBeDefined();
        expect(model.summary).toBeDefined();
        expect(model.assemblyMode).toBe('degraded');
    });

    it('partial sections are supported — unavailable sections carry degradedReason', () => {
        const workspace = new WorkspaceStateBuilder().buildUnavailable('root not found');
        expect(workspace.meta.availability).toBe('unavailable');
        expect(workspace.meta.degradedReason).toContain('root not found');
        expect(workspace.rootResolved).toBe(false);
    });

    it('degraded markers are preserved on all section types', () => {
        const projector = new RuntimeWorldStateProjector();
        const runtime = projector.buildRuntimeUnavailable('no diagnostics');
        const tools = projector.buildToolsUnavailable('no diagnostics');
        const providers = projector.buildProvidersUnavailable('no diagnostics');

        expect(runtime.meta.availability).toBe('unavailable');
        expect(tools.meta.availability).toBe('unavailable');
        expect(providers.meta.availability).toBe('unavailable');
        expect(runtime.meta.degradedReason).toContain('no diagnostics');
    });
});

// ─── 2. WorkspaceStateBuilder ─────────────────────────────────────────────────

describe('WorkspaceStateBuilder', () => {
    it('builds workspace state for an existing workspace root', () => {
        const builder = new WorkspaceStateBuilder();
        const state = builder.build({ workspaceRoot: '/workspace' });

        expect(state.rootResolved).toBe(true);
        expect(state.workspaceRoot).toBe('/workspace');
        expect(state.meta.availability).toBe('available');
        expect(state.meta.freshness).toBe('fresh');
        expect(state.knownDirectories).toContain('src');
        expect(state.knownDirectories).toContain('electron');
        expect(state.knownDirectories).toContain('docs');
    });

    it('classifies workspace as mixed when both src/electron and docs are present', () => {
        const builder = new WorkspaceStateBuilder();
        const state = builder.build({ workspaceRoot: '/workspace' });
        expect(state.classification).toBe('mixed');
    });

    it('builds unavailable state when workspace root is missing', () => {
        const builder = new WorkspaceStateBuilder();
        const state = builder.buildUnavailable('root not found');

        expect(state.rootResolved).toBe(false);
        expect(state.meta.availability).toBe('unavailable');
        expect(state.meta.freshness).toBe('unknown');
        expect(state.knownDirectories).toHaveLength(0);
    });

    it('limits recentFiles to 20 entries', () => {
        const builder = new WorkspaceStateBuilder();
        const manyFiles = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
        const state = builder.build({ workspaceRoot: '/workspace', recentFiles: manyFiles });
        expect(state.recentFiles.length).toBeLessThanOrEqual(20);
    });

    it('active files are included in workspace state', () => {
        const builder = new WorkspaceStateBuilder();
        const state = builder.build({
            workspaceRoot: '/workspace',
            activeFiles: ['src/index.ts', 'electron/main.ts'],
        });
        expect(state.activeFiles).toContain('src/index.ts');
    });
});

// ─── 3. RepoStateBuilder ──────────────────────────────────────────────────────

describe('RepoStateBuilder', () => {
    it('builds repo state as a git repo when .git is present', async () => {
        const builder = new RepoStateBuilder();
        // /workspace/.git is mocked to exist
        const state = await builder.build('/workspace');

        expect(state.isRepo).toBe(true);
        expect(state.repoRoot).toBe('/workspace');
    });

    it('detects key directories correctly', async () => {
        const builder = new RepoStateBuilder();
        const state = await builder.build('/workspace');

        expect(state.detectedDirectories).toContain('src');
        expect(state.detectedDirectories).toContain('electron');
        expect(state.detectedDirectories).toContain('docs');
        expect(state.detectedDirectories).toContain('tests');
    });

    it('classifies project as electron_app when both electron and src are present', async () => {
        const builder = new RepoStateBuilder();
        const state = await builder.build('/workspace');
        expect(state.projectType).toBe('electron_app');
    });

    it('marks hasArchitectureDocs when docs directory is present', async () => {
        const builder = new RepoStateBuilder();
        const state = await builder.build('/workspace');
        expect(state.hasArchitectureDocs).toBe(true);
    });

    it('builds unavailable repo state when no workspace root is provided', () => {
        const builder = new RepoStateBuilder();
        const state = builder.buildUnavailable('', 'no root provided');

        expect(state.isRepo).toBe(false);
        expect(state.meta.availability).toBe('unavailable');
        expect(state.meta.degradedReason).toContain('no root provided');
    });

    it('marks state as partial when no GitService provided but .git exists', async () => {
        const builder = new RepoStateBuilder();
        const state = await builder.build('/workspace'); // no GitService
        expect(state.meta.availability).toBe('partial');
        expect(state.meta.degradedReason).toBeDefined();
    });

    it('uses cached state on subsequent calls within cache window', async () => {
        const builder = new RepoStateBuilder(30_000);
        const state1 = await builder.build('/workspace');
        const state2 = await builder.build('/workspace');
        expect(state1).toBe(state2); // same object reference — cache hit
    });

    it('invalidateCache forces a fresh build', async () => {
        const builder = new RepoStateBuilder(30_000);
        const state1 = await builder.build('/workspace');
        builder.invalidateCache();
        const state2 = await builder.build('/workspace');
        expect(state1).not.toBe(state2); // different object — rebuilt
    });
});

// ─── 4. RuntimeWorldStateProjector ───────────────────────────────────────────

describe('RuntimeWorldStateProjector', () => {
    it('projects inference state correctly from diagnostics snapshot', () => {
        const projector = new RuntimeWorldStateProjector();
        const snapshot = makeMinimalDiagnosticsSnapshot();
        const { runtime } = projector.project(snapshot as any);

        expect(runtime.inferenceReady).toBe(true);
        expect(runtime.selectedProviderId).toBe('ollama');
        expect(runtime.selectedProviderName).toBe('Ollama');
        expect(runtime.totalProviders).toBe(2);
        expect(runtime.readyProviders).toBe(1);
        expect(runtime.meta.availability).toBe('available');
    });

    it('projects MCP services into tool world state', () => {
        const projector = new RuntimeWorldStateProjector();
        const snapshot = makeMinimalDiagnosticsSnapshot();
        const { tools } = projector.project(snapshot as any);

        expect(tools.totalMcpServices).toBe(1);
        expect(tools.readyMcpServices).toBe(1);
        expect(tools.enabledTools).toContain('mcp-docs');
        expect(tools.degradedTools).toHaveLength(0);
        expect(tools.meta.availability).toBe('available');
    });

    it('projects provider health scores into provider world state', () => {
        const projector = new RuntimeWorldStateProjector();
        const snapshot = makeMinimalDiagnosticsSnapshot();
        const { providers } = projector.project(snapshot as any);

        expect(providers.preferredProviderId).toBe('ollama');
        expect(providers.suppressedProviders).toHaveLength(0);
        expect(providers.lastFallbackApplied).toBe(false);
    });

    it('marks degraded subsystems in runtime world state', () => {
        const projector = new RuntimeWorldStateProjector();
        const snapshot = {
            ...makeMinimalDiagnosticsSnapshot(),
            degradedSubsystems: ['mcp', 'docs_intel'],
        };
        const { runtime } = projector.project(snapshot as any);

        expect(runtime.hasActiveDegradation).toBe(true);
        expect(runtime.degradedSubsystems).toContain('mcp');
        expect(runtime.degradedSubsystems).toContain('docs_intel');
    });

    it('produces unavailable states gracefully when called directly', () => {
        const projector = new RuntimeWorldStateProjector();
        const r = projector.buildRuntimeUnavailable('test');
        const t = projector.buildToolsUnavailable('test');
        const p = projector.buildProvidersUnavailable('test');

        expect(r.inferenceReady).toBe(false);
        expect(t.enabledTools).toHaveLength(0);
        expect(p.availableProviders).toHaveLength(0);
    });
});

// ─── 5. UserGoalStateBuilder ──────────────────────────────────────────────────

describe('UserGoalStateBuilder', () => {
    it('extracts immediate task from current turn text', () => {
        const builder = new UserGoalStateBuilder();
        const state = builder.build({ currentTurnText: 'Help me refactor the inference service.' });

        expect(state.immediateTask).toBeDefined();
        expect(state.immediateTask).toContain('refactor');
        expect(state.meta.availability).not.toBe('unavailable');
    });

    it('explicit goal statement outranks inferred confidence — sets high confidence', () => {
        const builder = new UserGoalStateBuilder();
        const state = builder.build({
            currentTurnText: 'I want to implement the world model builder.',
        });

        expect(state.hasExplicitGoal).toBe(true);
        expect(state.immediateTaskConfidence).toBe('high');
    });

    it('non-explicit turn text results in medium confidence', () => {
        const builder = new UserGoalStateBuilder();
        const state = builder.build({ currentTurnText: 'Show me the diagnostics panel.' });

        expect(state.hasExplicitGoal).toBe(false);
        expect(state.immediateTaskConfidence).toBe('medium');
    });

    it('recent turn summaries contribute project focus', () => {
        const builder = new UserGoalStateBuilder();
        const state = builder.build({
            currentTurnText: 'Now fix the tests.',
            recentTurnSummaries: ['Working on Phase 4A world model for TALA.'],
        });

        expect(state.currentProjectFocus).toBeDefined();
        expect(state.currentProjectFocus).toContain('Phase 4A');
        expect(state.projectFocusConfidence).toBe('medium');
    });

    it('stable direction from profile is preserved', () => {
        const builder = new UserGoalStateBuilder();
        const state = builder.build({
            profileDirection: 'Focused on building robust AI tooling.',
        });

        expect(state.stableDirection).toContain('AI tooling');
    });

    it('stale goal state is marked when no input is provided', () => {
        const builder = new UserGoalStateBuilder();
        const state = builder.build({});

        expect(state.isStale).toBe(true);
        expect(state.meta.availability).toBe('unavailable');
    });

    it('builds unavailable state with reason', () => {
        const builder = new UserGoalStateBuilder();
        const state = builder.buildUnavailable('no user context');

        expect(state.isStale).toBe(true);
        expect(state.meta.availability).toBe('unavailable');
        expect(state.meta.degradedReason).toContain('no user context');
    });

    it('truncates immediate task to MAX_IMMEDIATE_TASK_LENGTH', () => {
        const builder = new UserGoalStateBuilder();
        const longText = 'A'.repeat(200) + ' end.';
        const state = builder.build({ currentTurnText: longText });
        expect((state.immediateTask ?? '').length).toBeLessThanOrEqual(120);
    });
});

// ─── 6. WorldModelAssembler ───────────────────────────────────────────────────

describe('WorldModelAssembler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('full build succeeds and returns TalaWorldModel with all sections', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 0 }); // disable cache
        const model = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'I want to add tests for the world model.' },
        );

        expect(model.timestamp).toBeTruthy();
        expect(model.workspace).toBeDefined();
        expect(model.repo).toBeDefined();
        expect(model.runtime).toBeDefined();
        expect(model.tools).toBeDefined();
        expect(model.providers).toBeDefined();
        expect(model.goals).toBeDefined();
        expect(model.summary).toBeDefined();
    });

    it('partial build succeeds when diagnostics snapshot is unavailable', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 0 });
        const model = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            undefined, // no diagnostics
            { currentTurnText: 'Help me understand the workspace structure.' },
        );

        expect(model.assemblyMode).toBe('partial');
        expect(model.workspace.meta.availability).toBe('available');
        expect(model.runtime.meta.availability).toBe('unavailable');
        expect(model.tools.meta.availability).toBe('unavailable');
    });

    it('assembly mode is full when all sections are available', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 0 });
        const model = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'I need to fix the inference service.' },
        );

        // Workspace and diagnostics sections should be available.
        // Repo will be partial (no GitService), goals available from turn text.
        expect(model.assemblyMode).not.toBe('degraded');
    });

    it('cache is returned on subsequent calls within freshness window', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 60_000 });
        const model1 = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'first turn' },
        );
        const model2 = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'second turn' },
        );
        expect(model1).toBe(model2); // same reference — cache hit
    });

    it('invalidateCache forces a rebuild on next call', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 60_000 });
        const model1 = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'first' },
        );
        assembler.invalidateCache();
        const model2 = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'after invalidate' },
        );
        expect(model1).not.toBe(model2);
    });

    it('getCachedModel returns null before first assembly', () => {
        const assembler = new WorldModelAssembler();
        expect(assembler.getCachedModel()).toBeNull();
    });

    it('telemetry is emitted on world model assembly', async () => {
        const { telemetry } = await import('../electron/services/TelemetryService');
        const assembler = new WorldModelAssembler({ maxAgeMs: 0 });
        await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            {},
        );
        expect(telemetry.operational).toHaveBeenCalledWith(
            'system',
            'world_model_build_started',
            expect.any(String),
            expect.any(String),
            expect.any(String),
            'success',
            expect.any(Object),
        );
    });
});

// ─── 7. Diagnostics summary ───────────────────────────────────────────────────

describe('WorldModelAssembler diagnostics summary', () => {
    it('buildDiagnosticsSummary returns IPC-safe read model', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 0 });
        const model = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'I want to review the diagnostics.' },
        );

        const summary = assembler.buildDiagnosticsSummary(model);

        expect(summary.timestamp).toBeTruthy();
        expect(summary.workspace).toBeDefined();
        expect(summary.repo).toBeDefined();
        expect(summary.runtime).toBeDefined();
        expect(summary.tools).toBeDefined();
        expect(summary.providers).toBeDefined();
        expect(summary.goals).toBeDefined();
        expect(summary.summary).toBeDefined();
        expect(Array.isArray(summary.alerts)).toBe(true);
    });

    it('diagnostics summary does not leak raw file paths beyond workspace root', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 0 });
        const model = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            {},
        );
        const summary = assembler.buildDiagnosticsSummary(model);

        // The workspace root is acceptable to expose; no deep file paths should appear
        const summaryStr = JSON.stringify(summary);
        expect(summaryStr).not.toContain('/workspace/src/');
        expect(summaryStr).not.toContain('/workspace/electron/');
    });

    it('diagnostics summary counts match model sections', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 0 });
        const model = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'Fix the world model test.' },
        );
        const summary = assembler.buildDiagnosticsSummary(model);

        expect(summary.tools.totalMcpServices).toBe(model.tools.totalMcpServices);
        expect(summary.providers.availableCount).toBe(model.providers.availableProviders.length);
        expect(summary.goals.immediateTask).toBe(model.goals.immediateTask);
    });

    it('goals in summary reflect explicit goal when set', async () => {
        const assembler = new WorldModelAssembler({ maxAgeMs: 0 });
        const model = await assembler.assemble(
            { workspaceRoot: '/workspace' },
            makeMinimalDiagnosticsSnapshot() as any,
            { currentTurnText: 'I want to finish the world model phase.' },
        );
        const summary = assembler.buildDiagnosticsSummary(model);

        expect(summary.goals.hasExplicitGoal).toBe(true);
        expect(summary.goals.immediateTask).toBeDefined();
    });
});
