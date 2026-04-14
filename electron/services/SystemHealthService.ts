import type { RuntimeFailureSummary, InferenceDiagnosticsState, McpInventoryDiagnostics } from '../../shared/runtimeDiagnosticsTypes';
import type {
    SystemCapability,
    SystemCapabilityAvailability,
    SystemDegradationFlag,
    SystemHealthIncidentEntry,
    SystemModeContract,
    SystemHealthOverallStatus,
    SystemHealthSnapshot,
    SystemHealthSubsystemSnapshot,
    SystemOperatingMode,
    SystemTrustExplanation,
    SystemTrustScoreInputs,
} from '../../shared/system-health-types';
import { SystemModeManager, type SystemModeSnapshot } from './SystemModeManager';
import { getLastDbHealth } from './db/initMemoryStore';
import { policyGate } from './policy/PolicyGate';
import { TelemetryBus } from './telemetry/TelemetryBus';

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

interface TrustModel {
    score: number;
    inputs: SystemTrustScoreInputs;
    explanation: SystemTrustExplanation;
}

export interface SystemHealthAdapterDeps {
    getStartupStatus?: () => StartupStatusSignal;
    getCurrentMode?: () => string;
    getAutonomyState?: () => AutonomyStateSignal | null;
    getReflectionSummary?: () => string;
}

export interface BuildSystemHealthSnapshotInput {
    now: string;
    inference: InferenceDiagnosticsState;
    mcp: McpInventoryDiagnostics;
    recentFailures: RuntimeFailureSummary;
    suppressedProviders: string[];
}

/**
 * Deterministic system-health reduction service.
 *
 * Invariant: the same normalized inputs always produce the same health/status snapshot.
 */
export class SystemHealthService {
    private readonly subsystemLastChange = new Map<string, { status: SystemHealthOverallStatus; changedAt: string }>();
    private readonly systemModeManager = new SystemModeManager();

    constructor(private readonly healthDeps?: SystemHealthAdapterDeps) {}

    public buildSnapshot(input: BuildSystemHealthSnapshotInput): SystemHealthSnapshot {
        const { now, inference, mcp, recentFailures, suppressedProviders } = input;

        const startup = this.healthDeps?.getStartupStatus?.() ?? {};
        const autonomy = this.healthDeps?.getAutonomyState?.() ?? null;
        const reflectionSummary = (this.healthDeps?.getReflectionSummary?.() ?? '').trim();
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

        const retrievalStatus: SystemHealthOverallStatus = startup.rag === false
            ? 'impaired'
            : toolStatus === 'impaired'
                ? 'degraded'
                : (toolStatus === 'degraded' ? 'degraded' : 'healthy');
        addSubsystem({
            name: 'search_retrieval_service',
            status: retrievalStatus,
            severity: retrievalStatus === 'impaired' ? 'error' : retrievalStatus === 'degraded' ? 'warning' : 'info',
            last_checked_at: now,
            reason_codes: retrievalStatus === 'healthy'
                ? ['retrieval_paths_ready']
                : startup.rag === false
                    ? ['retrieval_layer_unavailable']
                    : ['retrieval_tooling_degraded'],
            evidence: [
                `startup.rag=${startup.rag ?? 'unknown'}`,
                `toolFailureRatio=${toolFailureRatio.toFixed(3)}`,
            ],
            operator_impact: retrievalStatus === 'healthy'
                ? 'Search and retrieval pathways are available.'
                : 'Search/retrieval quality or availability is reduced.',
            auto_action_state: retrievalStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: retrievalStatus === 'healthy'
                ? []
                : ['Run retrieval diagnostics and validate local/connector-backed search providers.'],
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
            severity: autonomyStatus === 'healthy' ? 'info' : 'warning',
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

        const trustModel = this.computeTrustModel(now, inference, mcp, Boolean(db), events.length > 0, subsystemEntries);
        const trustScore = trustModel.score;

        const telemetryStatus: SystemHealthOverallStatus = trustScore < 0.6
            ? 'impaired'
            : (trustModel.explanation.stale_components.length > 0 || trustModel.explanation.missing_evidence.length > 0)
                ? 'degraded'
                : 'healthy';
        addSubsystem({
            name: 'dashboard_telemetry',
            status: telemetryStatus,
            severity: telemetryStatus === 'impaired' ? 'error' : telemetryStatus === 'degraded' ? 'warning' : 'info',
            last_checked_at: now,
            reason_codes: telemetryStatus === 'healthy'
                ? ['telemetry_fresh']
                : trustModel.explanation.stale_components.length > 0
                    ? ['telemetry_stale_components_present']
                    : ['telemetry_missing_evidence'],
            evidence: [
                `inferenceAgeMs=${trustModel.explanation.telemetry_freshness.inference_age_ms}`,
                `mcpAgeMs=${trustModel.explanation.telemetry_freshness.mcp_age_ms}`,
                `staleComponents=${trustModel.explanation.stale_components.join(',') || 'none'}`,
            ],
            operator_impact: telemetryStatus === 'healthy'
                ? 'Dashboard claims are backed by fresh telemetry.'
                : 'Dashboard confidence is reduced by stale or missing telemetry evidence.',
            auto_action_state: telemetryStatus === 'healthy' ? 'monitoring' : 'repair_pending',
            recommended_actions: telemetryStatus === 'healthy'
                ? []
                : ['Refresh subsystem health checks and inspect telemetry ingestion/runtime paths.'],
        });

        const overallStatus = this.reduceOverallStatus(subsystemEntries);
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

        const capabilityMatrix = this.buildCapabilityMatrix(subsystemEntries, modeSnapshotWithAttention.modeContract);
        const incidentEntries = this.buildIncidentEntries(subsystemEntries);

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
            capability_matrix: capabilityMatrix,
            active_incident_entries: incidentEntries,
            trust_explanation: trustModel.explanation,
            trust_score_inputs: trustModel.inputs,
            operator_attention_required: operatorAttentionRequired,
        };
    }

    public setOperatorModeOverride(
        mode: Exclude<SystemOperatingMode, 'NORMAL'> | null,
        meta?: { reason?: string; requestedBy?: string; timestamp?: string },
    ): void {
        this.systemModeManager.setOperatorModeOverride(mode, meta);
    }

    public getOperatorModeOverride(): {
        mode: Exclude<SystemOperatingMode, 'NORMAL'>;
        setAt: string;
        reason?: string;
        requestedBy?: string;
    } | null {
        return this.systemModeManager.getOperatorModeOverride();
    }

    private reduceOverallStatus(entries: SystemHealthSubsystemSnapshot[]): SystemHealthOverallStatus {
        const statuses = entries.map((e) => e.status);
        if (statuses.includes('failed')) return 'failed';
        if (statuses.includes('impaired')) return 'impaired';
        if (statuses.includes('recovery')) return 'recovery';
        if (statuses.includes('degraded')) return 'degraded';
        if (statuses.includes('maintenance')) return 'maintenance';
        return 'healthy';
    }

    private computeTrustModel(
        nowIso: string,
        inference: InferenceDiagnosticsState,
        mcp: McpInventoryDiagnostics,
        dbObserved: boolean,
        telemetryStreamObserved: boolean,
        subsystemEntries: SystemHealthSubsystemSnapshot[],
    ): TrustModel {
        let trust = 1;
        const nowMs = new Date(nowIso).getTime();
        const inferenceAgeMs = Math.max(0, nowMs - new Date(inference.lastUpdated).getTime());
        const mcpAgeMs = Math.max(0, nowMs - new Date(mcp.lastUpdated).getTime());
        const penalties: Array<{ reason: string; penalty: number }> = [];
        const staleComponents: string[] = [];
        const missingEvidence: string[] = [];
        const expectedMaxAgeMs = 90_000;

        if (inferenceAgeMs > expectedMaxAgeMs) {
            trust -= 0.2;
            penalties.push({ reason: 'inference_telemetry_stale', penalty: 0.2 });
            staleComponents.push('inference');
        }
        if (mcpAgeMs > expectedMaxAgeMs) {
            trust -= 0.2;
            penalties.push({ reason: 'mcp_telemetry_stale', penalty: 0.2 });
            staleComponents.push('mcp');
        }
        if (!dbObserved) {
            trust -= 0.1;
            penalties.push({ reason: 'db_evidence_missing', penalty: 0.1 });
            missingEvidence.push('db_health_preflight');
        }
        if (!telemetryStreamObserved) {
            trust -= 0.1;
            penalties.push({ reason: 'telemetry_stream_missing', penalty: 0.1 });
            missingEvidence.push('runtime_events');
        }

        const clamped = Math.max(0, Math.min(1, trust));
        const score = Math.round(clamped * 100) / 100;
        const lastHealthy = subsystemEntries
            .filter((s) => s.status === 'healthy')
            .sort((a, b) => new Date(b.last_checked_at).getTime() - new Date(a.last_checked_at).getTime())[0];

        const inputs: SystemTrustScoreInputs = {
            inference_age_ms: inferenceAgeMs,
            mcp_age_ms: mcpAgeMs,
            expected_max_age_ms: expectedMaxAgeMs,
            db_evidence_observed: dbObserved,
            telemetry_stream_observed: telemetryStreamObserved,
        };

        return {
            score,
            inputs,
            explanation: {
                telemetry_freshness: {
                    inference_age_ms: inferenceAgeMs,
                    mcp_age_ms: mcpAgeMs,
                    expected_max_age_ms: expectedMaxAgeMs,
                },
                last_successful_subsystem_check: lastHealthy?.last_checked_at ?? null,
                stale_components: staleComponents,
                missing_evidence: missingEvidence,
                suppressed_assumptions: [
                    'assume_no_event_implies_healthy',
                    'assume_partial_snapshots_equal_full_consistency',
                ],
                confidence_penalties: penalties,
            },
        };
    }

    private buildCapabilityMatrix(
        subsystemEntries: SystemHealthSubsystemSnapshot[],
        modeContract: SystemModeContract,
    ): SystemCapabilityAvailability[] {
        const bySubsystem = new Map(subsystemEntries.map((s) => [s.name, s]));
        const blockedCapabilities = new Set(modeContract.blocked_capabilities);
        const approvalRequired = new Set(modeContract.operator_approval_required_for);
        const degradedSubsystems = subsystemEntries
            .filter((s) => s.status === 'degraded' || s.status === 'maintenance' || s.status === 'recovery')
            .map((s) => s.name);

        const make = (
            capability: string,
            contractCapability: SystemCapability | null,
            impactedBy: string[],
        ): SystemCapabilityAvailability => {
            const blockedByMode = contractCapability ? blockedCapabilities.has(contractCapability) : false;
            const approvalNeeded = contractCapability
                ? approvalRequired.has(contractCapability) || approvalRequired.has(capability)
                : approvalRequired.has(capability);
            const degradedBySubsystem = impactedBy.some((n) => degradedSubsystems.includes(n));
            const impairedBySubsystem = impactedBy.some((n) => {
                const status = bySubsystem.get(n)?.status;
                return status === 'impaired' || status === 'failed';
            });

            if (blockedByMode || impairedBySubsystem) {
                return {
                    capability,
                    status: 'blocked',
                    reason: blockedByMode ? 'blocked_by_mode_contract' : 'blocked_by_subsystem_impairment',
                    approval_required: approvalNeeded,
                    impacted_by: impactedBy,
                };
            }
            if (approvalNeeded) {
                return {
                    capability,
                    status: 'approval_required',
                    reason: 'requires_operator_approval',
                    approval_required: true,
                    impacted_by: impactedBy,
                };
            }
            if (degradedBySubsystem) {
                return {
                    capability,
                    status: 'degraded',
                    reason: 'degraded_by_subsystem_state',
                    approval_required: false,
                    impacted_by: impactedBy,
                };
            }
            return {
                capability,
                status: 'available',
                reason: 'available',
                approval_required: false,
                impacted_by: impactedBy,
            };
        };

        return [
            make('chat', 'chat_inference', ['inference_service']),
            make('retrieve_local_memory', 'memory_canonical_read', ['memory_authority_service', 'db_health_service']),
            make('write_canonical_memory', 'memory_canonical_write', ['memory_authority_service', 'db_health_service']),
            make('run_tools', 'tool_execute_write', ['tool_execution_coordinator', 'mcp_tool_availability']),
            make('web_retrieval', 'tool_execute_read', ['search_retrieval_service', 'mcp_tool_availability']),
            make('autonomy', 'autonomy_execute', ['autonomy_orchestrator', 'queue_backlog_pressure']),
            make('reflection', 'repair_execute', ['reflection_service']),
            make('safe_auto_fix', 'repair_promotion', ['reflection_service', 'policy_gate']),
            make('notebook_search', 'memory_canonical_read', ['search_retrieval_service']),
            make('external_connectors', 'tool_execute_diagnostic', ['mcp_tool_availability']),
        ];
    }

    private buildIncidentEntries(subsystemEntries: SystemHealthSubsystemSnapshot[]): SystemHealthIncidentEntry[] {
        return subsystemEntries
            .filter((s) => s.status !== 'healthy')
            .map((s, idx) => ({
                incident_id: `inc-${s.name}-${s.reason_codes[0] ?? idx}`,
                title: `${s.name.replace(/_/g, ' ')} ${s.status}`,
                severity: s.severity,
                start_time: s.last_changed_at,
                dedup_family: s.reason_codes[0] ?? s.name,
                current_state: s.status,
                evidence_links: [`logs:getHealthSnapshot#${s.name}`, ...s.evidence.slice(0, 2)],
                automated_actions_attempted: s.auto_action_state === 'monitoring'
                    ? []
                    : [s.auto_action_state],
                recommended_operator_actions: s.recommended_actions,
            }));
    }
}
