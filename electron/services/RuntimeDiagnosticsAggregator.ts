import type {
    RuntimeDiagnosticsSnapshot,
    RuntimeFailureSummary,
    InferenceDiagnosticsState,
    McpInventoryDiagnostics,
    CognitiveDiagnosticsSnapshot,
    AuthorityLaneDiagnosticsSnapshot,
    HandoffExecutionRecord,
    HandoffDiagnosticsSnapshot,
    PlanningMemoryDiagnosticsSnapshot,
    KernelTurnDiagnosticsView,
} from '../../shared/runtimeDiagnosticsTypes';
import type {
    SystemCapability,
    SystemDegradationFlag,
    SystemModeContract,
    SystemHealthSnapshot,
    SystemOperatingMode,
} from '../../shared/system-health-types';
import type { InferenceDiagnosticsService } from './InferenceDiagnosticsService';
import { providerHealthScorer } from './inference/ProviderHealthScorer';
import type { RuntimeControlService } from './RuntimeControlService';
import type { TalaCognitiveContext, MemoryContributionCategory } from '../../shared/cognitiveTurnTypes';
import type { CompactionDiagnosticsSummary } from '../../shared/modelCapabilityTypes';
import { SystemHealthService, type SystemHealthAdapterDeps } from './SystemHealthService';
import { TelemetryBus } from './telemetry/TelemetryBus';
import type { AuthorityLaneDiagnosticsRecord } from '../../shared/planning/executionAuthorityTypes';

export interface McpDiagnosticsSource {
    getDiagnosticsInventory(): McpInventoryDiagnostics;
}

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

export class RuntimeDiagnosticsAggregator {
    private lastCognitiveMeta?: CognitiveTurnMeta;
    private readonly systemHealthService: SystemHealthService;
    private _lastAuthorityRecord?: AuthorityLaneDiagnosticsRecord;
    private _authorityLaneResolutionCounts: Partial<Record<string, number>> = {};
    private _authorityDegradedDirectCount = 0;
    private readonly _unsubscribeAuthority: (() => void);

    // ─── Handoff diagnostics state ─────────────────────────────────────────────
    private _lastWorkflowHandoff?: HandoffExecutionRecord;
    private _lastAgentHandoff?: HandoffExecutionRecord;
    private _workflowDispatchCount = 0;
    private _agentDispatchCount = 0;
    private _workflowFailureCount = 0;
    private _agentFailureCount = 0;
    private _handoffLastUpdated?: string;
    private readonly _unsubscribeHandoff: (() => void);
    private _planningMemorySnapshot?: PlanningMemoryDiagnosticsSnapshot;
    private _kernelTurnSnapshot?: KernelTurnDiagnosticsView;

    constructor(
        private readonly inferenceDiagnostics: InferenceDiagnosticsService,
        private readonly mcpLifecycle: McpDiagnosticsSource,
        private readonly runtimeControl?: RuntimeControlService,
        private readonly healthDeps?: SystemHealthAdapterDeps,
    ) {
        this.systemHealthService = new SystemHealthService(healthDeps);
        this._unsubscribeAuthority = TelemetryBus.getInstance().subscribe((evt) => {
            if (evt.event === 'planning.authority_lane_resolved' && evt.payload) {
                const record = evt.payload as unknown as AuthorityLaneDiagnosticsRecord;
                this._lastAuthorityRecord = record;
                const lane = record.authorityLane;
                this._authorityLaneResolutionCounts[lane] =
                    (this._authorityLaneResolutionCounts[lane] ?? 0) + 1;
                if (lane === 'chat_continuity_degraded_direct') {
                    this._authorityDegradedDirectCount++;
                }
            }
        });
        this._unsubscribeHandoff = TelemetryBus.getInstance().subscribe((evt) => {
            this._handleHandoffEvent(evt.event, evt.payload as Record<string, unknown> | undefined);
            this._handlePlanningMemoryEvent(evt.event, evt.payload as Record<string, unknown> | undefined);
            this._handleKernelTurnEvent(evt.event, evt.payload as Record<string, unknown> | undefined);
        });
    }

    /**
     * Stops the internal TelemetryBus subscription.
     * Call during teardown if the aggregator instance is being discarded.
     */
    public dispose(): void {
        this._unsubscribeAuthority();
        this._unsubscribeHandoff();
    }

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

        const systemHealth = this.systemHealthService.buildSnapshot({
            now,
            inference: inferenceState,
            mcp: mcpInventory,
            recentFailures,
            suppressedProviders,
        });

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
            executionAuthority: this._buildAuthorityLaneDiagnostics(now),
            handoffDiagnostics: this._buildHandoffDiagnostics(now),
            planningMemory: this._buildPlanningMemoryDiagnostics(now),
            kernelTurn: this._buildKernelTurnDiagnostics(now),
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

    public setOperatorModeOverride(
        mode: Exclude<SystemOperatingMode, 'NORMAL'> | null,
        meta?: { reason?: string; requestedBy?: string; timestamp?: string },
    ): void {
        this.systemHealthService.setOperatorModeOverride(mode, meta);
    }

    public getOperatorModeOverride(): {
        mode: Exclude<SystemOperatingMode, 'NORMAL'>;
        setAt: string;
        reason?: string;
        requestedBy?: string;
    } | null {
        return this.systemHealthService.getOperatorModeOverride();
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

    private _buildHandoffDiagnostics(now: string): HandoffDiagnosticsSnapshot | undefined {
        if (
            !this._lastWorkflowHandoff &&
            !this._lastAgentHandoff &&
            this._workflowDispatchCount === 0 &&
            this._agentDispatchCount === 0
        ) {
            return undefined;
        }
        return {
            lastWorkflowRecord: this._lastWorkflowHandoff,
            lastAgentRecord: this._lastAgentHandoff,
            workflowDispatchCount: this._workflowDispatchCount,
            agentDispatchCount: this._agentDispatchCount,
            workflowFailureCount: this._workflowFailureCount,
            agentFailureCount: this._agentFailureCount,
            lastUpdated: this._handoffLastUpdated ?? now,
        };
    }

    private _buildPlanningMemoryDiagnostics(now: string): PlanningMemoryDiagnosticsSnapshot | undefined {
        if (!this._planningMemorySnapshot) return undefined;
        return {
            ...this._planningMemorySnapshot,
            lastUpdated: this._planningMemorySnapshot.lastUpdated || now,
        };
    }

    private _buildKernelTurnDiagnostics(now: string): KernelTurnDiagnosticsView | undefined {
        if (!this._kernelTurnSnapshot) return undefined;
        return {
            ...this._kernelTurnSnapshot,
            updatedAt: this._kernelTurnSnapshot.updatedAt || now,
        };
    }

    private _handlePlanningMemoryEvent(event: string, payload?: Record<string, unknown>): void {
        if (!payload) return;
        const now = new Date().toISOString();
        if (event === 'planning.memory_context_built') {
            this._planningMemorySnapshot = {
                consulted: true,
                similarEpisodeCount: Number(payload.similarEpisodeCount ?? 0),
                topReasonCodes: Array.isArray(payload.reasonCodes)
                    ? (payload.reasonCodes as PlanningMemoryDiagnosticsSnapshot['topReasonCodes'])
                    : [],
                dominantFailurePattern: Array.isArray(payload.knownFailurePatterns) &&
                    payload.knownFailurePatterns.length > 0
                    ? String(payload.knownFailurePatterns[0])
                    : undefined,
                dominantRecoveryPattern: Array.isArray(payload.knownRecoveryPatterns) &&
                    payload.knownRecoveryPatterns.length > 0
                    ? String(payload.knownRecoveryPatterns[0])
                    : undefined,
                lastUpdated: now,
            };
            return;
        }
        if (event === 'planning.strategy_selected') {
            const existing = this._planningMemorySnapshot ?? {
                consulted: true,
                similarEpisodeCount: 0,
                topReasonCodes: [],
                lastUpdated: now,
            };
            this._planningMemorySnapshot = {
                ...existing,
                selectedLane: payload.selectedLane as PlanningMemoryDiagnosticsSnapshot['selectedLane'],
                selectedStrategyFamily: payload.strategyFamily as PlanningMemoryDiagnosticsSnapshot['selectedStrategyFamily'],
                selectedVerificationDepth: payload.verificationDepth as PlanningMemoryDiagnosticsSnapshot['selectedVerificationDepth'],
                confidence: typeof payload.confidence === 'number' ? payload.confidence : existing.confidence,
                topReasonCodes: Array.isArray(payload.reasonCodes)
                    ? (payload.reasonCodes as PlanningMemoryDiagnosticsSnapshot['topReasonCodes'])
                    : existing.topReasonCodes,
                lastUpdated: now,
            };
        }
    }

    private _handleKernelTurnEvent(event: string, payload?: Record<string, unknown>): void {
        if (!payload) return;
        const now = new Date().toISOString();
        if (event === 'kernel.turn_arbitrated') {
            this._kernelTurnSnapshot = {
                turnId: String(payload.turnId ?? ''),
                mode: payload.mode as KernelTurnDiagnosticsView['mode'],
                arbitrationSource: payload.source as KernelTurnDiagnosticsView['arbitrationSource'],
                confidence: Number(payload.confidence ?? 0),
                reasonCodes: Array.isArray(payload.reasonCodes)
                    ? payload.reasonCodes.map(String)
                    : [],
                planningInvoked: Boolean(payload.requiresPlan),
                executionInvoked: Boolean(payload.requiresExecutionLoop),
                authorityLevel: payload.authorityLevel as KernelTurnDiagnosticsView['authorityLevel'],
                activeGoalId: payload.activeGoalId as string | undefined,
                createdGoalId: payload.createdGoalId as string | undefined,
                updatedAt: now,
            };
            return;
        }
        if (!this._kernelTurnSnapshot) return;
        if (event === 'kernel.turn_mode_conversational') {
            this._kernelTurnSnapshot = {
                ...this._kernelTurnSnapshot,
                planningInvoked: false,
                executionInvoked: false,
                updatedAt: now,
            };
            return;
        }
        if (event === 'kernel.turn_mode_hybrid') {
            this._kernelTurnSnapshot = {
                ...this._kernelTurnSnapshot,
                executionInvoked: true,
                updatedAt: now,
            };
            return;
        }
        if (event === 'kernel.turn_mode_goal_execution') {
            this._kernelTurnSnapshot = {
                ...this._kernelTurnSnapshot,
                planningInvoked: true,
                executionInvoked: true,
                updatedAt: now,
            };
            return;
        }
        if (event === 'kernel.goal_created') {
            this._kernelTurnSnapshot = {
                ...this._kernelTurnSnapshot,
                createdGoalId: payload.createdGoalId as string | undefined,
                updatedAt: now,
            };
            return;
        }
        if (event === 'kernel.goal_resumed') {
            this._kernelTurnSnapshot = {
                ...this._kernelTurnSnapshot,
                activeGoalId: payload.activeGoalId as string | undefined,
                updatedAt: now,
            };
        }
    }

    private _handleHandoffEvent(event: string, payload?: Record<string, unknown>): void {
        if (!payload) return;
        const now = new Date().toISOString();
        this._handoffLastUpdated = now;

        const planId = (payload.planId as string) ?? '';
        const goalId = (payload.goalId as string) ?? '';
        const executionBoundaryId = (payload.executionBoundaryId as string) ?? '';

        switch (event) {
            case 'planning.workflow_handoff_dispatched': {
                this._workflowDispatchCount++;
                this._lastWorkflowHandoff = {
                    handoffType: 'workflow',
                    executionBoundaryId,
                    targetId: '',
                    readiness: 'dispatching',
                    policyStatus: 'clear',
                    outcome: 'pending',
                    startedAt: now,
                    planId,
                    goalId,
                };
                break;
            }
            case 'planning.workflow_handoff_preflight_failed': {
                this._workflowFailureCount++;
                const wfPreflightCode = payload.failureCode as string | undefined;
                const wfPreflightReplan = payload.replanAdvised as boolean | undefined;
                this._lastWorkflowHandoff = {
                    handoffType: 'workflow',
                    executionBoundaryId,
                    targetId: (payload.workflowId as string) ?? '',
                    readiness: 'preflight_failed',
                    policyStatus: 'clear',
                    outcome: 'failure',
                    reasonCode: wfPreflightCode,
                    replanAdvised: wfPreflightReplan,
                    replanTrigger: wfPreflightReplan ? 'capability_loss' : undefined,
                    startedAt: now,
                    completedAt: now,
                    planId,
                    goalId,
                    error: payload.details as string | undefined,
                };
                break;
            }
            case 'planning.workflow_handoff_dispatch_failed': {
                if (this._lastWorkflowHandoff && this._lastWorkflowHandoff.outcome === 'pending') {
                    this._workflowFailureCount++;
                }
                const wfFailCode = payload.failureCode as string | undefined;
                const wfFailReplan = payload.replanAdvised as boolean | undefined;
                const wfPolicyStatus: HandoffExecutionRecord['policyStatus'] =
                    wfFailCode === 'policy:escalation_required' ? 'escalation_required' : 'clear';
                this._lastWorkflowHandoff = {
                    ...(this._lastWorkflowHandoff ?? {
                        handoffType: 'workflow' as const,
                        targetId: '',
                        startedAt: now,
                        planId,
                        goalId,
                    }),
                    executionBoundaryId,
                    readiness: 'failed',
                    policyStatus: wfPolicyStatus,
                    outcome: 'failure',
                    reasonCode: wfFailCode,
                    replanAdvised: wfFailReplan,
                    replanTrigger: payload.replanTrigger as HandoffExecutionRecord['replanTrigger'],
                    failureClass: payload.failureClass as HandoffExecutionRecord['failureClass'],
                    recoveryOutcome: payload.recoveryOutcome as HandoffExecutionRecord['recoveryOutcome'],
                    recoveryAttempts: payload.recoveryAttempts as HandoffExecutionRecord['recoveryAttempts'],
                    antiThrashSuppressed: payload.antiThrashSuppressed as HandoffExecutionRecord['antiThrashSuppressed'],
                    degradedCompletion: payload.recoveryOutcome === 'degraded_but_completed',
                    completedAt: now,
                    error: payload.error as string | undefined,
                };
                break;
            }
            case 'planning.workflow_handoff_completed': {
                const wfStartedAt = this._lastWorkflowHandoff?.startedAt ?? now;
                const wfStartMs = new Date(wfStartedAt).getTime();
                const wfEndMs = new Date(now).getTime();
                const wfDegraded = payload.degradedCompletion === true;
                this._lastWorkflowHandoff = {
                    ...(this._lastWorkflowHandoff ?? {
                        handoffType: 'workflow' as const,
                        targetId: '',
                        planId,
                        goalId,
                    }),
                    executionBoundaryId,
                    readiness: 'completed',
                    policyStatus: 'clear',
                    outcome: 'success',
                    startedAt: wfStartedAt,
                    completedAt: now,
                    durationMs: wfEndMs - wfStartMs,
                    degradedCompletion: wfDegraded,
                    recoveryOutcome: wfDegraded ? 'degraded_but_completed' : this._lastWorkflowHandoff?.recoveryOutcome,
                };
                break;
            }
            case 'planning.agent_handoff_dispatched': {
                this._agentDispatchCount++;
                this._lastAgentHandoff = {
                    handoffType: 'agent',
                    executionBoundaryId,
                    targetId: (payload.agentId as string) ?? '',
                    readiness: 'dispatching',
                    policyStatus: 'clear',
                    outcome: 'pending',
                    startedAt: now,
                    planId,
                    goalId,
                };
                break;
            }
            case 'planning.agent_handoff_preflight_failed': {
                this._agentFailureCount++;
                const agPreflightCode = payload.failureCode as string | undefined;
                const agPreflightReplan = payload.replanAdvised as boolean | undefined;
                this._lastAgentHandoff = {
                    handoffType: 'agent',
                    executionBoundaryId,
                    targetId: (payload.agentId as string) ?? '',
                    readiness: 'preflight_failed',
                    policyStatus: 'clear',
                    outcome: 'failure',
                    reasonCode: agPreflightCode,
                    replanAdvised: agPreflightReplan,
                    replanTrigger: agPreflightReplan ? 'capability_loss' : undefined,
                    startedAt: now,
                    completedAt: now,
                    planId,
                    goalId,
                    error: payload.details as string | undefined,
                };
                break;
            }
            case 'planning.agent_handoff_dispatch_failed': {
                if (this._lastAgentHandoff && this._lastAgentHandoff.outcome === 'pending') {
                    this._agentFailureCount++;
                }
                const agFailCode = payload.failureCode as string | undefined;
                const agFailReplan = payload.replanAdvised as boolean | undefined;
                const agPolicyStatus: HandoffExecutionRecord['policyStatus'] =
                    agFailCode === 'policy:escalation_required' ? 'escalation_required' : 'clear';
                this._lastAgentHandoff = {
                    ...(this._lastAgentHandoff ?? {
                        handoffType: 'agent' as const,
                        targetId: (payload.agentId as string) ?? '',
                        startedAt: now,
                        planId,
                        goalId,
                    }),
                    executionBoundaryId,
                    readiness: 'failed',
                    policyStatus: agPolicyStatus,
                    outcome: 'failure',
                    reasonCode: agFailCode,
                    replanAdvised: agFailReplan,
                    replanTrigger: payload.replanTrigger as HandoffExecutionRecord['replanTrigger'],
                    failureClass: payload.failureClass as HandoffExecutionRecord['failureClass'],
                    recoveryOutcome: payload.recoveryOutcome as HandoffExecutionRecord['recoveryOutcome'],
                    recoveryAttempts: payload.recoveryAttempts as HandoffExecutionRecord['recoveryAttempts'],
                    antiThrashSuppressed: payload.antiThrashSuppressed as HandoffExecutionRecord['antiThrashSuppressed'],
                    degradedCompletion: payload.recoveryOutcome === 'degraded_but_completed',
                    completedAt: now,
                    error: payload.error as string | undefined,
                };
                break;
            }
            case 'planning.agent_handoff_completed': {
                const agStartedAt = this._lastAgentHandoff?.startedAt ?? now;
                const agStartMs = new Date(agStartedAt).getTime();
                const agEndMs = new Date(now).getTime();
                const agDegraded = payload.degradedCompletion === true;
                this._lastAgentHandoff = {
                    ...(this._lastAgentHandoff ?? {
                        handoffType: 'agent' as const,
                        targetId: (payload.agentId as string) ?? '',
                        planId,
                        goalId,
                    }),
                    executionBoundaryId,
                    readiness: 'completed',
                    policyStatus: 'clear',
                    outcome: 'success',
                    startedAt: agStartedAt,
                    completedAt: now,
                    durationMs: agEndMs - agStartMs,
                    degradedCompletion: agDegraded,
                    recoveryOutcome: agDegraded ? 'degraded_but_completed' : this._lastAgentHandoff?.recoveryOutcome,
                };
                break;
            }
        }
    }

    private _buildAuthorityLaneDiagnostics(now: string): AuthorityLaneDiagnosticsSnapshot | undefined {
        if (!this._lastAuthorityRecord) return undefined;
        return {
            lastRecord: this._lastAuthorityRecord,
            lastUpdated: now,
            laneResolutionCounts: { ...this._authorityLaneResolutionCounts },
            degradedDirectCount: this._authorityDegradedDirectCount,
        };
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

