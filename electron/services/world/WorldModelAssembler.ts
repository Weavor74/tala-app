/**
 * WorldModelAssembler — Phase 4A: World Model Foundation
 *
 * The single authoritative builder for TalaWorldModel.
 *
 * Responsibilities:
 *   - Orchestrate WorkspaceStateBuilder, RepoStateBuilder,
 *     RuntimeWorldStateProjector, and UserGoalStateBuilder.
 *   - Support partial builds: if one section is unavailable, others still populate.
 *   - Enforce a freshness cache so the model is not rebuilt on every minor event.
 *   - Build a WorldModelSummary (degradation flags, active alerts, task focus).
 *   - Emit structured telemetry for every assembly: started, completed, partial, failed.
 *   - Expose a diagnostics-friendly read model (WorldModelDiagnosticsSummary).
 *
 * Design rules:
 *   - This is the single assembly point — callers never build TalaWorldModel directly.
 *   - Partial builds succeed when individual sections fail.
 *   - Telemetry events never carry raw user content or full file paths.
 *   - The assembled model is IPC-safe and serialization-safe.
 *   - Small-model path should receive compact world-state summary, not raw state.
 */

import { telemetry } from '../TelemetryService';
import { workspaceStateBuilder } from './WorkspaceStateBuilder';
import type { WorkspaceStateInput } from './WorkspaceStateBuilder';
import { repoStateBuilder } from './RepoStateBuilder';
import { runtimeWorldStateProjector } from './RuntimeWorldStateProjector';
import { userGoalStateBuilder } from './UserGoalStateBuilder';
import type { UserGoalAssemblyInput } from '../../../shared/worldModelTypes';
import type { RuntimeDiagnosticsSnapshot } from '../../../shared/runtimeDiagnosticsTypes';
import type { GitService } from '../GitService';
import type { A2UISurfaceCoordinator } from '../coordination/A2UISurfaceCoordinator';
import type {
    TalaWorldModel,
    WorldModelDiagnosticsSummary,
    WorldModelSummary,
    WorldModelAlert,
    WorldModelAssemblerOptions,
    WorldModelAvailability,
} from '../../../shared/worldModelTypes';

// ─── Default options ──────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: WorldModelAssemblerOptions = {
    maxAgeMs: 30_000,
    includeRepoState: true,
};

// ─── Cached model ─────────────────────────────────────────────────────────────

interface CachedWorldModel {
    model: TalaWorldModel;
    builtAt: number;
}

// ─── Assembler ────────────────────────────────────────────────────────────────

/**
 * WorldModelAssembler
 *
 * Builds TalaWorldModel from all available environment sources.
 * Supports partial builds, freshness caching, and telemetry emission.
 */
export class WorldModelAssembler {
    private _cache: CachedWorldModel | null = null;
    private readonly _options: WorldModelAssemblerOptions;
    /** Phase 4D: Optional surface coordinator for world-event-driven surface updates. */
    private _surfaceCoordinator: A2UISurfaceCoordinator | null = null;

    constructor(options: Partial<WorldModelAssemblerOptions> = {}) {
        this._options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Phase 4D: Attach a surface coordinator to receive automatic surface
     * updates when the world model is rebuilt.
     */
    public setSurfaceCoordinator(coordinator: A2UISurfaceCoordinator): void {
        this._surfaceCoordinator = coordinator;
    }

    /**
     * Assembles or returns a cached TalaWorldModel.
     *
     * @param workspaceInput - Workspace root and optional app-supplied state.
     * @param diagnosticsSnapshot - Current RuntimeDiagnosticsSnapshot (may be undefined).
     * @param goalInput - Current turn and recent turn summaries for goal inference.
     * @param gitService - Optional GitService for repo state queries.
     * @param forceRefresh - Bypass the freshness cache and rebuild from scratch.
     * @returns TalaWorldModel with all available sections populated.
     */
    public async assemble(
        workspaceInput: WorkspaceStateInput,
        diagnosticsSnapshot: RuntimeDiagnosticsSnapshot | undefined,
        goalInput: UserGoalAssemblyInput,
        gitService?: GitService,
        forceRefresh = false,
    ): Promise<TalaWorldModel> {
        if (!forceRefresh && this._isCacheValid()) {
            return this._cache!.model;
        }

        const now = new Date().toISOString();
        const sessionId = this._options.sessionId;
        const turnId = `world_model:${Date.now()}`;

        telemetry.operational(
            'system',
            'world_model_build_started',
            'info',
            turnId,
            'World model assembly started',
            'success',
            { payload: { sessionId, forceRefresh, includeRepo: this._options.includeRepoState } },
        );

        let sectionErrors = 0;

        // ── 1. Workspace state ────────────────────────────────────────────────
        let workspace = workspaceStateBuilder.buildUnavailable('Assembly error');
        try {
            workspace = workspaceStateBuilder.build(workspaceInput);
        } catch (e) {
            sectionErrors++;
            workspace = workspaceStateBuilder.buildUnavailable(`Workspace build error: ${String(e).slice(0, 80)}`);
        }

        // ── 2. Repo state ─────────────────────────────────────────────────────
        let repo = repoStateBuilder.buildUnavailable(workspaceInput.workspaceRoot, 'Repo section skipped or error');
        if (this._options.includeRepoState) {
            try {
                repo = await repoStateBuilder.build(workspaceInput.workspaceRoot, gitService);
            } catch (e) {
                sectionErrors++;
                repo = repoStateBuilder.buildUnavailable(
                    workspaceInput.workspaceRoot,
                    `Repo build error: ${String(e).slice(0, 80)}`,
                );
            }
        }

        // ── 3. Runtime / tool / provider state ────────────────────────────────
        let runtime = runtimeWorldStateProjector.buildRuntimeUnavailable('No diagnostics snapshot available');
        let tools = runtimeWorldStateProjector.buildToolsUnavailable('No diagnostics snapshot available');
        let providers = runtimeWorldStateProjector.buildProvidersUnavailable('No diagnostics snapshot available');

        if (diagnosticsSnapshot) {
            try {
                const projected = runtimeWorldStateProjector.project(diagnosticsSnapshot);
                runtime = projected.runtime;
                tools = projected.tools;
                providers = projected.providers;
            } catch (e) {
                sectionErrors++;
                runtime = runtimeWorldStateProjector.buildRuntimeUnavailable(
                    `Projection error: ${String(e).slice(0, 80)}`,
                );
                tools = runtimeWorldStateProjector.buildToolsUnavailable(
                    `Projection error: ${String(e).slice(0, 80)}`,
                );
                providers = runtimeWorldStateProjector.buildProvidersUnavailable(
                    `Projection error: ${String(e).slice(0, 80)}`,
                );
            }
        }

        // ── 4. User goal state ────────────────────────────────────────────────
        let goals = userGoalStateBuilder.buildUnavailable('Goal build error');
        try {
            goals = userGoalStateBuilder.build(goalInput);
        } catch (e) {
            sectionErrors++;
            goals = userGoalStateBuilder.buildUnavailable(`Goal build error: ${String(e).slice(0, 80)}`);
        }

        // ── 5. Build summary / alerts ─────────────────────────────────────────
        const allSections: Array<{ name: WorldModelAlert['section']; availability: WorldModelAvailability }> = [
            { name: 'workspace', availability: workspace.meta.availability },
            { name: 'repo', availability: repo.meta.availability },
            { name: 'runtime', availability: runtime.meta.availability },
            { name: 'tools', availability: tools.meta.availability },
            { name: 'providers', availability: providers.meta.availability },
            { name: 'goals', availability: goals.meta.availability },
        ];

        const alerts: WorldModelAlert[] = [];

        for (const s of allSections) {
            if (s.availability === 'unavailable') {
                alerts.push({ severity: 'warn', section: s.name, message: `${s.name} section unavailable` });
            } else if (s.availability === 'degraded') {
                alerts.push({ severity: 'warn', section: s.name, message: `${s.name} section degraded` });
            }
        }

        if (runtime.hasActiveDegradation) {
            alerts.push({
                severity: 'error',
                section: 'runtime',
                message: `Degraded subsystems: ${runtime.degradedSubsystems.join(', ')}`,
            });
        }

        if (repo.isDirty) {
            alerts.push({ severity: 'info', section: 'repo', message: `Repo has ${repo.changedFileCount} uncommitted change(s) on ${repo.branch ?? 'unknown branch'}` });
        }

        if (providers.suppressedProviders.length > 0) {
            alerts.push({
                severity: 'warn',
                section: 'providers',
                message: `${providers.suppressedProviders.length} provider(s) suppressed`,
            });
        }

        const sectionsAvailable = allSections.filter(
            (s) => s.availability === 'available' || s.availability === 'partial',
        ).length;
        const sectionsDegraded = allSections.filter(
            (s) => s.availability === 'degraded' || s.availability === 'partial',
        ).length;
        const sectionsUnavailable = allSections.filter((s) => s.availability === 'unavailable').length;

        const summary: WorldModelSummary = {
            sectionsAvailable,
            sectionsDegraded,
            sectionsUnavailable,
            hasActiveDegradation: runtime.hasActiveDegradation,
            repoDirty: repo.isDirty,
            activeTaskFocus: goals.immediateTask ?? goals.currentProjectFocus,
            alerts,
        };

        // ── 6. Determine assembly mode ─────────────────────────────────────────
        const assemblyMode: TalaWorldModel['assemblyMode'] =
            sectionsUnavailable === 0 && sectionErrors === 0
                ? 'full'
                : sectionsUnavailable >= 5
                ? 'degraded'
                : 'partial';

        const model: TalaWorldModel = {
            timestamp: now,
            sessionId,
            workspace,
            repo,
            runtime,
            tools,
            providers,
            goals,
            summary,
            assemblyMode,
        };

        this._cache = { model, builtAt: Date.now() };

        // ── Phase 4D: Notify surface coordinator of world model rebuild ────────
        if (this._surfaceCoordinator) {
            void this._surfaceCoordinator.coordinate({
                intentClass: 'workspace',
                isGreeting: false,
                mode: 'assistant',
                triggerType: 'world_event',
                world: {
                    hasActiveDegradation: runtime.hasActiveDegradation,
                    inferenceReady: runtime.inferenceReady,
                    repoDetected: repo.isRepo,
                    workspaceResolved: workspace.rootResolved,
                    justRebuilt: true,
                },
            }).catch(() => { /* non-fatal */ });
        }

        // ── Telemetry ─────────────────────────────────────────────────────────
        const telemetryEvent =
            assemblyMode === 'full'
                ? 'world_model_build_completed'
                : assemblyMode === 'partial'
                ? 'world_model_build_partial'
                : 'world_model_build_failed';

        telemetry.operational(
            'system',
            telemetryEvent as any,
            assemblyMode === 'degraded' ? 'warn' : 'info',
            turnId,
            `World model assembly ${assemblyMode}: sections=${sectionsAvailable}/${allSections.length} errors=${sectionErrors}`,
            assemblyMode === 'degraded' ? 'partial' : 'success',
            {
                payload: {
                    sessionId,
                    assemblyMode,
                    sectionsAvailable,
                    sectionsDegraded,
                    sectionsUnavailable,
                    sectionErrors,
                    alertCount: alerts.length,
                    hasActiveDegradation: runtime.hasActiveDegradation,
                    repoDirty: repo.isDirty,
                },
            },
        );

        return model;
    }

    /**
     * Returns a WorldModelDiagnosticsSummary from a TalaWorldModel.
     * Safe to expose over IPC. Does not include raw file contents.
     */
    public buildDiagnosticsSummary(model: TalaWorldModel): WorldModelDiagnosticsSummary {
        return {
            timestamp: model.timestamp,
            assemblyMode: model.assemblyMode,
            workspace: {
                availability: model.workspace.meta.availability,
                classification: model.workspace.classification,
                workspaceRoot: model.workspace.workspaceRoot,
                freshness: model.workspace.meta.freshness,
            },
            repo: {
                availability: model.repo.meta.availability,
                isRepo: model.repo.isRepo,
                branch: model.repo.branch,
                isDirty: model.repo.isDirty,
                projectType: model.repo.projectType,
                freshness: model.repo.meta.freshness,
            },
            runtime: {
                availability: model.runtime.meta.availability,
                inferenceReady: model.runtime.inferenceReady,
                selectedProviderId: model.runtime.selectedProviderId,
                selectedProviderName: model.runtime.selectedProviderName,
                degradedSubsystems: model.runtime.degradedSubsystems,
                hasActiveDegradation: model.runtime.hasActiveDegradation,
                freshness: model.runtime.meta.freshness,
            },
            tools: {
                availability: model.tools.meta.availability,
                enabledToolCount: model.tools.enabledTools.length,
                blockedToolCount: model.tools.blockedTools.length,
                degradedToolCount: model.tools.degradedTools.length,
                readyMcpServices: model.tools.readyMcpServices,
                totalMcpServices: model.tools.totalMcpServices,
                freshness: model.tools.meta.freshness,
            },
            providers: {
                availability: model.providers.meta.availability,
                preferredProviderId: model.providers.preferredProviderId,
                preferredProviderName: model.providers.preferredProviderName,
                availableCount: model.providers.availableProviders.length,
                suppressedCount: model.providers.suppressedProviders.length,
                degradedCount: model.providers.degradedProviders.length,
                freshness: model.providers.meta.freshness,
            },
            goals: {
                availability: model.goals.meta.availability,
                hasExplicitGoal: model.goals.hasExplicitGoal,
                immediateTask: model.goals.immediateTask,
                currentProjectFocus: model.goals.currentProjectFocus,
                isStale: model.goals.isStale,
                freshness: model.goals.meta.freshness,
            },
            alerts: model.summary.alerts,
            summary: model.summary,
        };
    }

    /**
     * Returns the last assembled world model from cache, or null if not yet built.
     */
    public getCachedModel(): TalaWorldModel | null {
        return this._cache?.model ?? null;
    }

    /**
     * Invalidates the internal cache — forces a full rebuild on the next assemble() call.
     */
    public invalidateCache(): void {
        this._cache = null;
        repoStateBuilder.invalidateCache();
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _isCacheValid(): boolean {
        if (!this._cache) return false;
        return Date.now() - this._cache.builtAt < this._options.maxAgeMs;
    }
}

/** Module-level singleton with default options. */
export const worldModelAssembler = new WorldModelAssembler();
