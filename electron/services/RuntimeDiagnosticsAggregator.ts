import type {
    RuntimeDiagnosticsSnapshot,
    RuntimeFailureSummary,
    InferenceDiagnosticsState,
    McpInventoryDiagnostics,
    CognitiveDiagnosticsSnapshot,
} from '../../shared/runtimeDiagnosticsTypes';
import type {
    SystemCapability,
    SystemDegradationFlag,
    SystemModeContract,
    SystemHealthOverallStatus,
    SystemHealthSnapshot,
    SystemHealthSubsystemSnapshot,
} from '../../shared/system-health-types';
import { SystemModeManager, type SystemModeSnapshot } from './SystemModeManager';
import type { InferenceDiagnosticsService } from './InferenceDiagnosticsService';
import type { McpLifecycleManager } from './McpLifecycleManager';
import { providerHealthScorer } from './inference/ProviderHealthScorer';
import type { RuntimeControlService } from './RuntimeControlService';
import type { TalaCognitiveContext, MemoryContributionCategory } from '../../shared/cognitiveTurnTypes';
import type { CompactionDiagnosticsSummary } from '../../shared/modelCapabilityTypes';
import { getLastDbHealth } from './db/initMemoryStore';
import { policyGate } from './policy/PolicyGate';
import { TelemetryBus } from './telemetry/TelemetryBus';

export interface CognitiveTurnMeta {
    context: TalaCognitiveContext;
    compactionSummary?: CompactionDiagnosticsSummary;
    preinferenceDurationMs?: number;
    cognitiveAssemblyDurationMs?: number;
    compactionDurationMs?: number;
    mcpServicesRequested?: number;
    mcpServicesUsed?: number;
    mcpServicesFailed?: number;
    mcpServicesSuppressed?: number;
    docsRetrieved?: number;
    docsUsed?: number;
    docsCompacted?: number;
    docsSuppressed?: number;
}

interface StartupStatusSignal {
    rag?: boolean;
    memory?: boolean;
    astro?: boolean;
    world?: boolean;
    memoryGraph?: boolean;
    soulReady?: boolean;
}

interface AutonomyStateSignal {
    globalAutonomyEnabled?: boolean;
    kpis?: {
        pendingGoals?: number;
        activeRuns?: number;
        totalPolicyBlocked?: number;
        totalGovernanceBlocked?: number;
    };
    blockedGoals?: unknown[];
    campaignState?: {
        activeCampaigns?: unknown[];
        pendingCampaigns?: unknown[];
    };
}

export interface SystemHealthAdapterDeps {
    getStartupStatus?: () => StartupStatusSignal;
    getCurrentMode?: () => string;
    getAutonomyState?: () => AutonomyStateSignal | null;
    getReflectionSummary?: () => string;
}

export class RuntimeDiagnosticsAggregator {
    private lastCognitiveMeta?: CognitiveTurnMeta;
    private readonly subsystemLastChange = new Map<string, { status: SystemHealthOverallStatus; changedAt: string }>();
    private readonly systemModeManager = new SystemModeManager();

    constructor(
        private readonly inferenceDiagnostics: InferenceDiagnosticsService,
        private readonly mcpLifecycle: McpLifecycleManager,
        private readonly runtimeControl?: RuntimeControlService,
        private readonly healthDeps?: SystemHealthAdapterDeps,
    ) {}

    public recordCognitiveContext(context: TalaCognitiveContext): void {
        this.lastCognitiveMeta = { ...this.lastCognitiveMeta, context };
    }

    public recordCognitiveMeta(meta: Partial<Omit<CognitiveTurnMeta, 'context'>>): void {
        if (this.lastCognitiveMeta) {
            this.lastCognitiveMeta = { ...this.lastCognitiveMeta, ...meta };
        }
    }

    public getSnapshot(sessionId?: string): RuntimeDiagnosticsSnapshot {
        const now = new Date().toISOString();
        const inferenceState = this.inferenceDiagnostics.getState();
        const mcpInventory = this.mcpLifecycle.getDiagnosticsInventory();

        const degradedSubsystems = this._computeDegradedSubsystems(inferenceState, mcpInventory);
        const recentFailures = this._computeRecentFailures(inferenceState, mcpInventory);

        const providerHealthScores = providerHealthScorer.getAllScores();
        const suppressedProviders = providerHealthScorer.getSuppressedProviderIds();
        const operatorActions = this.runtimeControl?.getOperatorActions() ?? [];
        const recentProviderRecoveries = this.runtimeControl?.getRecentProviderRecoveries() ?? [];
        const recentMcpRestarts = this.runtimeControl?.getRecentMcpRestarts() ?? [];

        const systemHealth = this._buildSystemHealthSnapshot(now, inferenceState, mcpInventory, recentFailures, suppressedProviders);

        return {
            timestamp: now,
            sessionId,
            inference: inferenceState,
            mcp: mcpInventory,
            degradedSubsystems,
            recentFailures,
            lastUpdatedPerSubsystem: {
                inference: inferenceState.lastUpdated,
                mcp: mcpInventory.lastUpdated,
            },
            operatorActions,
            providerHealthScores,
            suppressedProviders,
            recentProviderRecoveries,
            recentMcpRestarts,
            systemHealth,
            cognitive: this._buildCognitiveDiagnostics(now),
        };
    }

    public getSystemHealthSnapshot(sessionId?: string): SystemHealthSnapshot {
        return this.getSnapshot(sessionId).systemHealth;
    }

    public getSystemModeSnapshot(sessionId?: string): {
        effective_mode: string;
        active_degradation_flags: SystemDegradationFlag[];
        mode_contract: SystemModeContract;
        recent_mode_transitions: import('../../shared/system-health-types').SystemModeTransition[];
    } {
        const health = this.getSystemHealthSnapshot(sessionId);
        return {
            effective_mode: health.effective_mode,
            active_degradation_flags: health.active_degradation_flags,
            mode_contract: health.mode_contract,
            recent_mode_transitions: health.recent_mode_transitions,
        };
    }

    public isCapabilityAllowed(
        capability: SystemCapability,
        sessionId?: string,
    ): { allowed: boolean; effective_mode: string; reason: string } {
        const modeSnapshot = this.getSystemModeSnapshot(sessionId);
        const allowed = modeSnapshot.mode_contract.allowed_capabilities.includes(capability)
            && !modeSnapshot.mode_contract.blocked_capabilities.includes(capability);
        return {
            allowed,
            effective_mode: modeSnapshot.effective_mode,
            reason: allowed
                ? 'allowed_by_mode_contract'
                : `blocked_by_mode_contract:${modeSnapshot.effective_mode}`,
        };
    }

    public getInferenceStatus(): InferenceDiagnosticsState {
        return this.inferenceDiagnostics.getState();
    }

    public getMcpStatus(): McpInventoryDiagnostics {
        return this.mcpLifecycle.getDiagnosticsInventory();
    }

    private _buildCognitiveDiagnostics(now: string): CognitiveDiagnosticsSnapshot | undefined {
        const meta = this.lastCognitiveMeta;
        if (!meta) return undefined;
        const ctx = meta.context;

        const byCategory: Partial<Record<MemoryContributionCategory, number>> = {};
        for (const c of ctx.memoryContributions.contributions) {
            byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
        }

        const totalMemoryUsed = ctx.memoryContributions.contributions.length;
        const totalCandidates = ctx.memoryContributions.candidateCount;
        const totalExcluded = ctx.memoryContributions.excludedCount;
        const totalDropped = Math.max(0, totalCandidates - totalMemoryUsed - totalExcluded);

        const compSummary = meta.compactionSummary;

        return {
            timestamp: now,
            activeMode: ctx.modePolicy.mode,
            memoryContributionSummary: {
                totalApplied: totalMemoryUsed,
                byCategory,
                retrievalSuppressed: ctx.memoryContributions.retrievalSuppressed,
            },
            docContributionSummary: {
                applied: ctx.docContributions.applied,
                sourceCount: ctx.docContributions.sourceIds.length,
            },
            emotionalModulationStatus: {
                applied: ctx.emotionalModulation.applied,
                strength: ctx.emotionalModulation.strength,
                astroUnavailable: ctx.emotionalModulation.astroUnavailable,
            },
            reflectionNoteStatus: {
                activeNoteCount: ctx.reflectionContributions.activeNotes.length,
                suppressedNoteCount: ctx.reflectionContributions.suppressedNotes.length,
                applied: ctx.reflectionContributions.applied,
            },
            lastPolicyAppliedAt: ctx.modePolicy.appliedAt,
            promptProfile: compSummary?.profileClass,
            compactionSummary: compSummary
                ? {
                      profileClass: compSummary.profileClass,
                      compactionPolicy: compSummary.compactionPolicy,
                      memoriesKept: compSummary.memoriesKept,
                      memoriesDropped: compSummary.memoriesDropped,
                      docsIncluded: compSummary.docsIncluded,
                      reflectionNotesKept: compSummary.reflectionNotesKept,
                      reflectionNotesDropped: compSummary.reflectionNotesDropped,
                      sectionsDropped: compSummary.sectionsDropped,
                  }
                : undefined,
            memoryContributionCounts: {
                candidatesFound: totalCandidates,
                candidatesUsed: totalMemoryUsed,
                candidatesDropped: totalDropped + totalExcluded,
                byCategoryUsed: byCategory,
            },
            docContributionCounts: {
                retrieved: meta.docsRetrieved ?? (ctx.docContributions.applied ? 1 : 0),
                used: meta.docsUsed ?? (ctx.docContributions.applied ? 1 : 0),
                compacted: meta.docsCompacted ?? 0,
                suppressed: meta.docsSuppressed ?? (ctx.docContributions.applied ? 0 : 1),
            },
            mcpContributionCounts: {
                servicesRequested: meta.mcpServicesRequested ?? 0,
                servicesUsed: meta.mcpServicesUsed ?? 0,
                servicesFailed: meta.mcpServicesFailed ?? 0,
                servicesSuppressed: meta.mcpServicesSuppressed ?? 0,
            },
            reflectionContributionCounts: {
                notesAvailable:
                    ctx.reflectionContributions.activeNotes.length +
                    ctx.reflectionContributions.suppressedNotes.length,
                notesApplied: ctx.reflectionContributions.activeNotes.length,
                notesSuppressed: ctx.reflectionContributions.suppressedNotes.length,
            },
            emotionalBiasSummary: {
                strength: ctx.emotionalModulation.strength,
                dimensions: ctx.emotionalModulation.influencedDimensions,
                modulationApplied: ctx.emotionalModulation.applied,
            },
            performanceSummary: {
                preinferenceDurationMs: meta.preinferenceDurationMs,
                cognitiveAssemblyDurationMs: meta.cognitiveAssemblyDurationMs,
                compactionDurationMs: meta.compactionDurationMs,
            },
        };
    }

    private _buildSystemHealthSnapshot(
        now: string,
        inference: InferenceDiagnosticsState,
        mcp: McpInventoryDiagnostics,
        recentFailures: RuntimeFailureSummary,
        suppressedProviders: string[],
    ): SystemHealthSnapshot {
        const startup = this.healthDeps?.getStartupStatus?.() ?? {};
        const autonomy = this.healthDeps?.getAutonomyState?.() ?? null;
        const reflectionSummary = (this.healthDeps?.getReflectionSummary?.() ?? '').trim();
        const currentMode = this.healthDeps?.getCurrentMode?.() ?? this.lastCognitiveMeta?.context.modePolicy.mode ?? 'assistant';
        const db = getLastDbHealth();
        const events = [...TelemetryBus.getInstance().getRecentEvents()];

        const toolFailed = events.filter(e => e.event === 'tool.failed').length;
        const toolCompleted = events.filter(e => e.event === 'tool.completed').length;
        const policyDenied = events.filter(e => e.event === 'policy.rule_denied' || e.event === 'execution.blocked').length;
        const memoryRepairPending = Math.max(
            0,
            events.filter(e => e.event === 'memory.repair_trigger').length
                - events.filter(e => e.event === 'memory.repair_completed').length,
        );

        const activeFallbacks: string[] = [];
        if (inference.fallbackApplied) activeFallbacks.push('inference_provider_fallback');
        if (suppressedProviders.length > 0) activeFallbacks.push('provider_suppression_routing');

        const subsystemEntries: SystemHealthSubsystemSnapshot[] = [];

        const addSubsystem = (entry: Omit<SystemHealthSubsystemSnapshot, 'last_changed_at'>) => {
            const prev = this.subsystemLastChange.get(entry.name);
            const changedAt = prev && prev.status === entry.status ? prev.changedAt : now;
            this.subsystemLastChange.set(entry.name, { status: entry.status, changedAt });
            subsystemEntries.push({ ...entry, last_changed_at: changedAt });
        };

        const dbStatus: SystemHealthOverallStatus = !db
            ? 'maintenance'
            : (!db.reachable || !db.authenticated)
                ? 'failed'
                : (!db.databaseExists || !db.pgvectorInstalled || !db.migrationsApplied)
                    ? 'degraded'
                    : 'healthy';
        addSubsystem({
            name: 'db_health_service',
            status: dbStatus,
            severity: dbStatus === 'failed' ? 'critical' : dbStatus === 'degraded' ? 'warning' : 'info',
            last_checked_at: now,
            reason_codes: !db
                ? ['db_health_unavailable']
                : dbStatus === 'failed'
                    ? ['canonical_db_unreachable']
                    : dbStatus === 'degraded'
                        ? ['canonical_db_capability_gap']
                        : ['db_ok'],
            evidence: !db
                ? ['No DB preflight result has been recorded yet.']
                : [
                    `reachable=${db.reachable}`,
                    `authenticated=${db.authenticated}`,
                    `databaseExists=${db.databaseExists}`,
                    `pgvectorInstalled=${db.pgvectorInstalled}`,
                    `migrationsApplied=${db.migrationsApplied}`,
                  ],
            operator_impact: dbStatus === 'healthy'
                ? 'Canonical memory authority path is available.'
                : dbStatus === 'failed'
                    ? 'Canonical memory authority is unavailable; durable memory truth cannot be trusted.'
                    : 'Canonical DB is reachable but missing required capabilities.',
            auto_action_state: dbStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: dbStatus === 'healthy'
                ? []
                : ['Verify Postgres runtime and apply missing schema/pgvector setup.'],
        });

        const memoryAuthorityStatus: SystemHealthOverallStatus = dbStatus === 'failed'
            ? 'failed'
            : dbStatus === 'degraded'
                ? 'impaired'
                : 'healthy';
        addSubsystem({
            name: 'memory_authority_service',
            status: memoryAuthorityStatus,
            severity: memoryAuthorityStatus === 'failed' ? 'critical' : memoryAuthorityStatus === 'impaired' ? 'error' : 'info',
            last_checked_at: now,
            reason_codes: memoryAuthorityStatus === 'healthy'
                ? ['canonical_memory_authority_ok']
                : ['canonical_memory_authority_unavailable'],
            evidence: [
                `db_status=${dbStatus}`,
                'Canonical authority must resolve to PostgreSQL-backed IDs.',
            ],
            operator_impact: memoryAuthorityStatus === 'healthy'
                ? 'Memory authority integrity invariant is currently satisfied.'
                : 'Memory authority integrity is compromised; canonical truth operations are constrained.',
            auto_action_state: memoryAuthorityStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: memoryAuthorityStatus === 'healthy'
                ? []
                : ['Restore canonical DB authority before resuming normal memory operations.'],
        });

        const inferenceStatus: SystemHealthOverallStatus = (!inference.selectedProviderReady && !inference.fallbackApplied)
            ? (inference.lastStreamStatus === 'failed' ? 'impaired' : 'degraded')
            : (inference.fallbackApplied ? 'degraded' : 'healthy');
        addSubsystem({
            name: 'inference_service',
            status: inferenceStatus,
            severity: inferenceStatus === 'impaired' ? 'error' : inferenceStatus === 'degraded' ? 'warning' : 'info',
            last_checked_at: now,
            reason_codes: inferenceStatus === 'healthy'
                ? ['inference_primary_ready']
                : inference.fallbackApplied
                    ? ['inference_fallback_active']
                    : ['inference_primary_unavailable'],
            evidence: [
                `selectedProviderReady=${inference.selectedProviderReady}`,
                `fallbackApplied=${inference.fallbackApplied}`,
                `streamStatus=${inference.streamStatus}`,
                `lastStreamStatus=${inference.lastStreamStatus ?? 'none'}`,
            ],
            operator_impact: inferenceStatus === 'healthy'
                ? 'Primary inference path is healthy.'
                : inference.fallbackApplied
                    ? 'Inference remains available through fallback routing with reduced resilience.'
                    : 'Inference availability is impaired for normal operation.',
            auto_action_state: inference.fallbackApplied ? 'fallback_active' : (inferenceStatus === 'healthy' ? 'monitoring' : 'repair_pending'),
            recommended_actions: inferenceStatus === 'healthy'
                ? []
                : ['Probe providers and restore a ready primary model endpoint.'],
        });

        const mcpStatus: SystemHealthOverallStatus = mcp.totalUnavailable > 0
            ? (mcp.criticalUnavailable ? 'impaired' : 'degraded')
            : (mcp.totalDegraded > 0 ? 'degraded' : 'healthy');
        addSubsystem({
            name: 'mcp_tool_availability',
            status: mcpStatus,
            severity: mcpStatus === 'impaired' ? 'error' : mcpStatus === 'degraded' ? 'warning' : 'info',
            last_checked_at: now,
            reason_codes: mcpStatus === 'healthy'
                ? ['mcp_inventory_ready']
                : mcp.criticalUnavailable
                    ? ['mcp_critical_service_unavailable']
                    : ['mcp_partial_unavailable'],
            evidence: [
                `totalConfigured=${mcp.totalConfigured}`,
                `totalReady=${mcp.totalReady}`,
                `totalDegraded=${mcp.totalDegraded}`,
                `totalUnavailable=${mcp.totalUnavailable}`,
                `criticalUnavailable=${mcp.criticalUnavailable}`,
            ],
            operator_impact: mcpStatus === 'healthy'
                ? 'MCP tooling surface is available.'
                : 'Tool capabilities are reduced due to MCP service availability issues.',
            auto_action_state: mcpStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: mcpStatus === 'healthy'
                ? []
                : ['Restart affected MCP services and verify service credentials/runtime health.'],
        });

        const toolFailureRatio = toolCompleted > 0 ? toolFailed / toolCompleted : (toolFailed > 0 ? 1 : 0);
        const toolStatus: SystemHealthOverallStatus = toolFailureRatio >= 0.4 && toolFailed >= 3
            ? 'impaired'
            : (toolFailureRatio > 0.1 ? 'degraded' : 'healthy');
        addSubsystem({
            name: 'tool_execution_coordinator',
            status: toolStatus,
            severity: toolStatus === 'impaired' ? 'error' : toolStatus === 'degraded' ? 'warning' : 'info',
            last_checked_at: now,
            reason_codes: toolStatus === 'healthy' ? ['tool_execution_nominal'] : ['tool_execution_error_rate_elevated'],
            evidence: [
                `toolFailed=${toolFailed}`,
                `toolCompleted=${toolCompleted}`,
                `failureRatio=${toolFailureRatio.toFixed(3)}`,
            ],
            operator_impact: toolStatus === 'healthy'
                ? 'Tool execution path is stable.'
                : 'Tool execution reliability is reduced; some requested actions may fail.',
            auto_action_state: toolStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: toolStatus === 'healthy'
                ? []
                : ['Inspect recent tool.failed telemetry and retry with validated tool inputs.'],
        });

        const policyProfileId = policyGate.getActiveProfileId();
        const guardrailPolicyStatus: SystemHealthOverallStatus = policyProfileId ? 'healthy' : 'maintenance';
        addSubsystem({
            name: 'policy_gate',
            status: guardrailPolicyStatus,
            severity: guardrailPolicyStatus === 'healthy' ? 'info' : 'warning',
            last_checked_at: now,
            reason_codes: [policyProfileId ? 'policy_profile_active' : 'policy_profile_not_loaded'],
            evidence: [
                `activeProfileId=${policyProfileId ?? 'none'}`,
                `policyDeniedEvents=${policyDenied}`,
            ],
            operator_impact: policyProfileId
                ? 'Policy gate is actively enforcing guardrail rules.'
                : 'Policy profile is not loaded; runtime is in guardrail maintenance posture.',
            auto_action_state: guardrailPolicyStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: policyProfileId
                ? []
                : ['Load and validate the active guardrail policy profile.'],
        });

        const reflectionInRecovery = memoryRepairPending > 0
            && (reflectionSummary.length > 0 || recentFailures.count > 0 || dbStatus !== 'healthy');
        const reflectionStatus: SystemHealthOverallStatus = reflectionInRecovery
            ? 'recovery'
            : (reflectionSummary.length > 0 ? 'degraded' : 'healthy');
        addSubsystem({
            name: 'reflection_service',
            status: reflectionStatus,
            severity: reflectionStatus === 'healthy' ? 'info' : 'warning',
            last_checked_at: now,
            reason_codes: reflectionStatus === 'recovery'
                ? ['memory_repair_in_progress']
                : reflectionSummary.length > 0
                    ? ['reflection_actions_pending']
                    : ['reflection_queue_clear'],
            evidence: [
                `memoryRepairPendingApprox=${Math.max(0, memoryRepairPending)}`,
                `reflectionSummaryPresent=${reflectionSummary.length > 0}`,
            ],
            operator_impact: reflectionStatus === 'healthy'
                ? 'Reflection/repair loop is idle and stable.'
                : 'Reflection/repair flow has pending work and may require operator follow-up.',
            auto_action_state: reflectionStatus === 'healthy' ? 'monitoring' : 'repair_active',
            recommended_actions: reflectionStatus === 'healthy'
                ? []
                : ['Review reflection queue and resolve pending repair proposals.'],
        });

        const autonomyPending = autonomy?.kpis?.pendingGoals ?? 0;
        const autonomyBlocked = (autonomy?.blockedGoals?.length ?? 0) + (autonomy?.kpis?.totalPolicyBlocked ?? 0) + (autonomy?.kpis?.totalGovernanceBlocked ?? 0);
        const autonomyStatus: SystemHealthOverallStatus = autonomy?.globalAutonomyEnabled === false
            ? 'maintenance'
            : autonomyBlocked > 0
                ? 'degraded'
                : (autonomyPending > 10 ? 'degraded' : 'healthy');
        addSubsystem({
            name: 'autonomy_orchestrator',
            status: autonomyStatus,
            severity: autonomyStatus === 'healthy' ? 'info' : autonomyStatus === 'maintenance' ? 'warning' : 'warning',
            last_checked_at: now,
            reason_codes: autonomy?.globalAutonomyEnabled === false
                ? ['autonomy_disabled_by_policy']
                : autonomyBlocked > 0
                    ? ['autonomy_blocked_goals_present']
                    : autonomyPending > 10
                        ? ['autonomy_backlog_high']
                        : ['autonomy_nominal'],
            evidence: [
                `globalAutonomyEnabled=${autonomy?.globalAutonomyEnabled ?? 'unknown'}`,
                `pendingGoals=${autonomyPending}`,
                `blockedGoals=${autonomyBlocked}`,
                `activeRuns=${autonomy?.kpis?.activeRuns ?? 0}`,
            ],
            operator_impact: autonomyStatus === 'healthy'
                ? 'Autonomy orchestration is within expected bounds.'
                : autonomyStatus === 'maintenance'
                    ? 'Autonomy is intentionally disabled and operating in maintenance posture.'
                    : 'Autonomy has blocked/backlogged work and may require intervention.',
            auto_action_state: autonomyStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: autonomyStatus === 'healthy'
                ? []
                : ['Review blocked goals and campaign queue before widening autonomy scope.'],
        });

        const startupFailures = ['rag', 'memory', 'astro', 'world', 'memoryGraph']
            .filter((k) => startup[k as keyof StartupStatusSignal] === false);
        const bootstrapStatus: SystemHealthOverallStatus = startupFailures.length === 0
            ? (startup.soulReady === false ? 'degraded' : 'healthy')
            : (startup.soulReady === false ? 'impaired' : 'degraded');
        addSubsystem({
            name: 'bootstrap_runtime_services',
            status: bootstrapStatus,
            severity: bootstrapStatus === 'impaired' ? 'error' : bootstrapStatus === 'degraded' ? 'warning' : 'info',
            last_checked_at: now,
            reason_codes: startupFailures.length === 0
                ? (startup.soulReady === false ? ['startup_partial_ready'] : ['startup_ready'])
                : ['startup_dependency_unready'],
            evidence: [
                `soulReady=${startup.soulReady ?? 'unknown'}`,
                `unready=${startupFailures.join(',') || 'none'}`,
            ],
            operator_impact: bootstrapStatus === 'healthy'
                ? 'Core startup/runtime dependencies are available.'
                : 'One or more core startup/runtime dependencies are not fully ready.',
            auto_action_state: bootstrapStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: bootstrapStatus === 'healthy'
                ? []
                : ['Run startup diagnostics and recover unready runtime dependencies.'],
        });

        const queuePressure = autonomyPending + autonomyBlocked + Math.max(0, memoryRepairPending);
        const queueStatus: SystemHealthOverallStatus = queuePressure > 25
            ? 'impaired'
            : (queuePressure > 10 ? 'degraded' : 'healthy');
        addSubsystem({
            name: 'queue_backlog_pressure',
            status: queueStatus,
            severity: queueStatus === 'impaired' ? 'error' : queueStatus === 'degraded' ? 'warning' : 'info',
            last_checked_at: now,
            reason_codes: queueStatus === 'healthy' ? ['queue_pressure_normal'] : ['queue_pressure_elevated'],
            evidence: [
                `queuePressure=${queuePressure}`,
                `autonomyPending=${autonomyPending}`,
                `autonomyBlocked=${autonomyBlocked}`,
                `memoryRepairPendingApprox=${Math.max(0, memoryRepairPending)}`,
            ],
            operator_impact: queueStatus === 'healthy'
                ? 'Backlog pressure is within expected operational limits.'
                : 'Backlog pressure is elevated and may delay repairs or autonomy execution.',
            auto_action_state: queueStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: queueStatus === 'healthy'
                ? []
                : ['Prioritize blocked/pending items and drain repair queues.'],
        });

        const degradedCapabilities = subsystemEntries
            .filter((s) => s.status === 'degraded' || s.status === 'maintenance')
            .map((s) => s.name);
        const blockedCapabilities = subsystemEntries
            .filter((s) => s.status === 'failed' || s.status === 'impaired')
            .map((s) => s.name);

        const activeIncidents = subsystemEntries
            .filter((s) => s.status !== 'healthy')
            .flatMap((s) => s.reason_codes.map((code) => `${s.name}:${code}`));

        const pendingRepairs = subsystemEntries
            .filter((s) => s.auto_action_state === 'repair_pending' || s.auto_action_state === 'repair_active')
            .map((s) => s.name);

        const trustScore = this._computeTrustScore(now, inference, mcp, Boolean(db), events.length > 0);

        const overallStatus = this._reduceOverallStatus(subsystemEntries);
        const operatorAttentionRequired = overallStatus === 'failed'
            || overallStatus === 'impaired'
            || blockedCapabilities.length > 0
            || queueStatus === 'impaired'
            || trustScore < 0.6;

        const modeSnapshotWithAttention: SystemModeSnapshot = this.systemModeManager.evaluate({
            timestamp: now,
            overallStatus,
            degradedCapabilities,
            blockedCapabilities,
            pendingRepairs,
            activeFallbacks,
            operatorAttentionRequired,
            trustScore,
        });

        return {
            timestamp: now,
            overall_status: overallStatus,
            subsystem_entries: subsystemEntries,
            trust_score: trustScore,
            degraded_capabilities: degradedCapabilities,
            blocked_capabilities: blockedCapabilities,
            active_fallbacks: activeFallbacks,
            active_incidents: activeIncidents,
            pending_repairs: pendingRepairs,
            current_mode: modeSnapshotWithAttention.effectiveMode,
            effective_mode: modeSnapshotWithAttention.effectiveMode,
            active_degradation_flags: modeSnapshotWithAttention.activeFlags,
            mode_contract: modeSnapshotWithAttention.modeContract,
            recent_mode_transitions: modeSnapshotWithAttention.recentTransitions,
            operator_attention_required: operatorAttentionRequired,
        };
    }

    private _reduceOverallStatus(entries: SystemHealthSubsystemSnapshot[]): SystemHealthOverallStatus {
        const statuses = entries.map((e) => e.status);
        if (statuses.includes('failed')) return 'failed';
        if (statuses.includes('impaired')) return 'impaired';
        if (statuses.includes('recovery')) return 'recovery';
        if (statuses.includes('degraded')) return 'degraded';
        if (statuses.includes('maintenance')) return 'maintenance';
        return 'healthy';
    }

    private _computeTrustScore(
        nowIso: string,
        inference: InferenceDiagnosticsState,
        mcp: McpInventoryDiagnostics,
        dbObserved: boolean,
        hasTelemetry: boolean,
    ): number {
        let trust = 1;
        const nowMs = new Date(nowIso).getTime();
        const inferenceAgeMs = Math.max(0, nowMs - new Date(inference.lastUpdated).getTime());
        const mcpAgeMs = Math.max(0, nowMs - new Date(mcp.lastUpdated).getTime());

        if (inferenceAgeMs > 90_000) trust -= 0.2;
        if (mcpAgeMs > 90_000) trust -= 0.2;
        if (!dbObserved) trust -= 0.1;
        if (!hasTelemetry) trust -= 0.1;

        const clamped = Math.max(0, Math.min(1, trust));
        return Math.round(clamped * 100) / 100;
    }

    private _computeDegradedSubsystems(
        inference: InferenceDiagnosticsState,
        mcp: McpInventoryDiagnostics,
    ): string[] {
        const degraded: string[] = [];

        if (!inference.selectedProviderReady && inference.streamStatus !== 'idle') {
            degraded.push('inference');
        }

        if (inference.lastStreamStatus === 'failed' || inference.lastStreamStatus === 'timed_out') {
            if (!degraded.includes('inference')) degraded.push('inference');
        }

        if (mcp.totalDegraded > 0 || mcp.totalUnavailable > 0) {
            degraded.push('mcp');
        }

        return degraded;
    }

    private _computeRecentFailures(
        inference: InferenceDiagnosticsState,
        mcp: McpInventoryDiagnostics,
    ): RuntimeFailureSummary {
        const failedEntityIds: string[] = [];
        let count = 0;
        let lastFailureTime: string | undefined;
        let lastFailureReason: string | undefined;

        if (inference.lastFailureTime) {
            count++;
            failedEntityIds.push(inference.lastUsedProviderId ?? 'inference');
            if (!lastFailureTime || inference.lastFailureTime > lastFailureTime) {
                lastFailureTime = inference.lastFailureTime;
                lastFailureReason = inference.lastFailureReason;
            }
        }

        for (const svc of mcp.services) {
            if (svc.status === 'failed' || svc.status === 'unavailable') {
                count++;
                failedEntityIds.push(svc.serviceId);
                if (svc.lastTransitionTime && (!lastFailureTime || svc.lastTransitionTime > lastFailureTime)) {
                    lastFailureTime = svc.lastTransitionTime;
                    lastFailureReason = svc.lastFailureReason;
                }
            }
        }

        return { count, lastFailureTime, lastFailureReason, failedEntityIds };
    }
}

