import type {
    RuntimeDiagnosticsSnapshot,
    RuntimeFailureSummary,
    InferenceDiagnosticsState,
    McpInventoryDiagnostics,
    CognitiveDiagnosticsSnapshot,
    AuthorityLaneDiagnosticsSnapshot,
    HandoffExecutionRecord,
    HandoffDiagnosticsSnapshot,
    PlanExecutionDiagnosticsSnapshot,
    PlanStageExecutionDiagnosticsRecord,
    PlanningMemoryDiagnosticsSnapshot,
    RuntimeMemoryAuthorityDiagnosticsView,
    RecoveryDiagnosticsSnapshot,
} from '../../shared/runtimeDiagnosticsTypes';
import type { KernelTurnDiagnosticsView } from '../../shared/turnArbitrationTypes';
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
import { RecoveryHistoryRepositoryService } from './runtime/recovery/RecoveryHistoryRepository';

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
    private _planExecutionDiagnostics: PlanExecutionDiagnosticsSnapshot = {
        stageCounts: {
            completed: 0,
            failed: 0,
            degraded: 0,
            skipped: 0,
            blocked: 0,
        },
        expectedOutputsSatisfied: true,
        recentStages: [],
        lastUpdated: new Date(0).toISOString(),
    };
    private readonly _unsubscribeHandoff: (() => void);
    private _planningMemorySnapshot?: PlanningMemoryDiagnosticsSnapshot;
    private _kernelTurnSnapshot?: KernelTurnDiagnosticsView;
    private _memoryAuthorityDiagnostics: RuntimeMemoryAuthorityDiagnosticsView = {
        lastDeniedReasonCodes: [],
        allowCount: 0,
        denyCount: 0,
        countsByCategory: {},
        countsByWriteMode: {},
        lastUpdated: new Date(0).toISOString(),
    };
    private _recoveryDiagnostics: RecoveryDiagnosticsSnapshot = {
        counters: {
            retriesAttempted: 0,
            replansRequested: 0,
            escalationsRaised: 0,
            degradedContinuesApplied: 0,
            stopsIssued: 0,
            loopsDetected: 0,
            overridesApplied: 0,
            approvalsRequired: 0,
            approvalsDenied: 0,
        },
        recentHistory: [],
        analytics: {
            totals: {
                retries: 0,
                replans: 0,
                escalations: 0,
                degradedContinues: 0,
                stops: 0,
                overrides: 0,
                loopDetections: 0,
            },
            topReasonCodes: [],
            byDecisionType: [],
            byFailureFamily: [],
        },
        lastReasonCodes: [],
        lastUpdated: new Date(0).toISOString(),
    };
    private readonly _recoveryHistoryRepository = RecoveryHistoryRepositoryService.getInstance();

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
            this._handlePlanExecutionEvent(evt.event, evt.payload as Record<string, unknown> | undefined);
            this._handlePlanningMemoryEvent(evt.event, evt.payload as Record<string, unknown> | undefined);
            this._handleKernelTurnEvent(evt.event, evt.payload as Record<string, unknown> | undefined);
            this._handleMemoryAuthorityEvent(evt.event, evt.payload as Record<string, unknown> | undefined);
            this._handleRecoveryEvent(evt.event, evt.executionId, evt.payload as Record<string, unknown> | undefined);
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
            planExecution: this._buildPlanExecutionDiagnostics(now),
            planningMemory: this._buildPlanningMemoryDiagnostics(now),
            kernelTurn: this._buildKernelTurnDiagnostics(now),
            memoryAuthority: this._buildMemoryAuthorityDiagnostics(now),
            recovery: this._buildRecoveryDiagnostics(now),
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

    private _buildMemoryAuthorityDiagnostics(now: string): RuntimeMemoryAuthorityDiagnosticsView | undefined {
        if (
            this._memoryAuthorityDiagnostics.allowCount === 0 &&
            this._memoryAuthorityDiagnostics.denyCount === 0 &&
            !this._memoryAuthorityDiagnostics.lastDecision
        ) {
            return undefined;
        }
        return {
            ...this._memoryAuthorityDiagnostics,
            lastUpdated: this._memoryAuthorityDiagnostics.lastUpdated || now,
        };
    }

    private _buildPlanExecutionDiagnostics(now: string): PlanExecutionDiagnosticsSnapshot | undefined {
        const snapshot = this._planExecutionDiagnostics;
        const hasSignal = Boolean(
            snapshot.planId ||
            snapshot.executionBoundaryId ||
            snapshot.status ||
            snapshot.currentStageId ||
            snapshot.lastStageId ||
            snapshot.recentStages.length > 0 ||
            snapshot.stageCounts.completed > 0 ||
            snapshot.stageCounts.failed > 0 ||
            snapshot.stageCounts.degraded > 0 ||
            snapshot.stageCounts.skipped > 0 ||
            snapshot.stageCounts.blocked > 0,
        );
        if (!hasSignal) return undefined;
        return {
            ...snapshot,
            recentStages: [...snapshot.recentStages],
            lastUpdated: snapshot.lastUpdated || now,
        };
    }

    private _buildRecoveryDiagnostics(now: string): RecoveryDiagnosticsSnapshot | undefined {
        this._recoveryDiagnostics.recentHistory = this._recoveryHistoryRepository.listRecentSync(30).map((entry) => ({
            historyId: entry.historyId,
            timestamp: entry.timestamp,
            executionId: entry.executionId,
            executionBoundaryId: entry.executionBoundaryId,
            triggerType: entry.triggerType,
            decisionType: entry.decisionType,
            reasonCode: entry.reasonCode,
            scope: entry.scope,
            failureFamily: entry.failureFamily,
            origin: entry.origin,
            operatorOverrideApplied: entry.operatorOverrideApplied,
            approvalState: entry.approvalState,
            outcome: entry.outcome,
            degradedMode: entry.degradedMode,
        }));
        const analytics = this._recoveryHistoryRepository.getAnalyticsSnapshotSync(200);
        this._recoveryDiagnostics.analytics = {
            totals: analytics.totals,
            topReasonCodes: analytics.topReasonCodes,
            byDecisionType: analytics.byDecisionType,
            byFailureFamily: analytics.byFailureFamily.map((item) => ({
                failureFamily: item.failureFamily,
                count: item.count,
            })),
        };

        if (
            this._recoveryDiagnostics.counters.retriesAttempted === 0 &&
            this._recoveryDiagnostics.counters.replansRequested === 0 &&
            this._recoveryDiagnostics.counters.escalationsRaised === 0 &&
            this._recoveryDiagnostics.counters.degradedContinuesApplied === 0 &&
            this._recoveryDiagnostics.counters.stopsIssued === 0 &&
            this._recoveryDiagnostics.counters.loopsDetected === 0 &&
            this._recoveryDiagnostics.counters.overridesApplied === 0 &&
            this._recoveryDiagnostics.counters.approvalsRequired === 0 &&
            this._recoveryDiagnostics.counters.approvalsDenied === 0 &&
            !this._recoveryDiagnostics.activeDecision
        ) {
            return undefined;
        }
        return {
            ...this._recoveryDiagnostics,
            lastUpdated: this._recoveryDiagnostics.lastUpdated || now,
        };
    }

    private _handlePlanExecutionEvent(event: string, payload?: Record<string, unknown>): void {
        if (!payload) return;
        const now = new Date().toISOString();

        if (event === 'planning.plan_execution_started') {
            this._planExecutionDiagnostics = {
                ...this._planExecutionDiagnostics,
                planId: payload.planId as string | undefined,
                executionBoundaryId: payload.executionBoundaryId as string | undefined,
                status: 'running',
                currentStageId: undefined,
                lastStageId: undefined,
                stageCounts: {
                    completed: 0,
                    failed: 0,
                    degraded: 0,
                    skipped: 0,
                    blocked: 0,
                },
                lastFailureReason: undefined,
                expectedOutputsSatisfied: true,
                responseProduced: false,
                responseQuality: 'not_produced',
                executionQuality: 'failed',
                criteriaSatisfiedCount: 0,
                criteriaUnmetCount: 0,
                unmetRequiredCriteria: [],
                requiredCriteriaSatisfied: false,
                operatorInputRequired: false,
                taskAttempted: true,
                userVisibleCompletion: false,
                outcomeVerified: false,
                recentStages: [],
                lastUpdated: now,
            };
            return;
        }

        if (event === 'planning.plan_stage_started') {
            this._planExecutionDiagnostics.currentStageId = payload.stageId as string | undefined;
            this._planExecutionDiagnostics.lastUpdated = now;
            return;
        }

        if (event === 'planning.plan_stage_completed' || event === 'planning.plan_stage_failed') {
            const status = String(payload.status ?? 'failed') as PlanStageExecutionDiagnosticsRecord['status'];
            const stageRecord: PlanStageExecutionDiagnosticsRecord = {
                stageId: String(payload.stageId ?? ''),
                handoffType: (payload.handoffType as PlanStageExecutionDiagnosticsRecord['handoffType']) ?? 'none',
                status,
                reasonCodes: Array.isArray(payload.reasonCodes) ? payload.reasonCodes.map(String) : [],
                attempts: Number(payload.attempts ?? 0),
                expectedOutputsSatisfied: payload.expectedOutputsSatisfied as boolean | undefined,
                failureReason: payload.failureReason as string | undefined,
                startedAt: now,
                completedAt: now,
            };

            this._planExecutionDiagnostics.currentStageId = undefined;
            this._planExecutionDiagnostics.lastStageId = stageRecord.stageId;
            this._planExecutionDiagnostics.recentStages = [
                stageRecord,
                ...this._planExecutionDiagnostics.recentStages,
            ].slice(0, 20);

            this._planExecutionDiagnostics.stageCounts[status] =
                (this._planExecutionDiagnostics.stageCounts[status] ?? 0) + 1;

            if (stageRecord.expectedOutputsSatisfied === false) {
                this._planExecutionDiagnostics.expectedOutputsSatisfied = false;
            }
            if (status === 'failed' || status === 'blocked') {
                this._planExecutionDiagnostics.lastFailureReason =
                    stageRecord.failureReason ?? stageRecord.reasonCodes[0];
            }
            if (payload.operatorInputRequired === true) {
                this._planExecutionDiagnostics.operatorInputRequired = true;
            }
            this._planExecutionDiagnostics.lastUpdated = now;
            return;
        }

        if (event === 'planning.plan_execution_completed' || event === 'planning.plan_execution_failed') {
            this._planExecutionDiagnostics.status = payload.status as PlanExecutionDiagnosticsSnapshot['status'] ?? (
                event === 'planning.plan_execution_failed' ? 'failed' : 'completed'
            );
            this._planExecutionDiagnostics.planId = payload.planId as string | undefined;
            this._planExecutionDiagnostics.executionBoundaryId =
                payload.executionBoundaryId as string | undefined;
            if (Array.isArray(payload.reasonCodes) && payload.reasonCodes.length > 0) {
                const reasonCodes = payload.reasonCodes.map(String);
                this._planExecutionDiagnostics.outcomeReasonCodes = reasonCodes;
                const firstFailure = reasonCodes.find((code) => code.startsWith('failure') || code.includes('failed'));
                if (firstFailure) {
                    this._planExecutionDiagnostics.lastFailureReason = firstFailure;
                }
            }
            this._planExecutionDiagnostics.executionQuality =
                payload.executionQuality as PlanExecutionDiagnosticsSnapshot['executionQuality'] | undefined;
            this._planExecutionDiagnostics.criteriaSatisfiedCount =
                typeof payload.criteriaSatisfiedCount === 'number'
                    ? payload.criteriaSatisfiedCount
                    : this._planExecutionDiagnostics.criteriaSatisfiedCount;
            this._planExecutionDiagnostics.criteriaUnmetCount =
                typeof payload.criteriaUnmetCount === 'number'
                    ? payload.criteriaUnmetCount
                    : this._planExecutionDiagnostics.criteriaUnmetCount;
            this._planExecutionDiagnostics.unmetRequiredCriteria = Array.isArray(payload.unmetRequiredCriteria)
                ? payload.unmetRequiredCriteria.map(String)
                : this._planExecutionDiagnostics.unmetRequiredCriteria;
            if (typeof payload.requiredCriteriaSatisfied === 'boolean') {
                this._planExecutionDiagnostics.requiredCriteriaSatisfied = payload.requiredCriteriaSatisfied;
            }
            if (typeof payload.operatorInputRequired === 'boolean') {
                this._planExecutionDiagnostics.operatorInputRequired = payload.operatorInputRequired;
            }
            this._planExecutionDiagnostics.taskAttempted = true;
            this._planExecutionDiagnostics.lastUpdated = now;
            return;
        }

        if (event === 'planning.turn_completion_assessed') {
            this._planExecutionDiagnostics.responseProduced = payload.responseProduced === true;
            this._planExecutionDiagnostics.responseQuality =
                payload.responseQuality as PlanExecutionDiagnosticsSnapshot['responseQuality'] | undefined;
            this._planExecutionDiagnostics.executionQuality =
                payload.executionQuality as PlanExecutionDiagnosticsSnapshot['executionQuality'] | undefined;
            this._planExecutionDiagnostics.criteriaSatisfiedCount =
                typeof payload.criteriaSatisfiedCount === 'number'
                    ? payload.criteriaSatisfiedCount
                    : this._planExecutionDiagnostics.criteriaSatisfiedCount;
            this._planExecutionDiagnostics.criteriaUnmetCount =
                typeof payload.criteriaUnmetCount === 'number'
                    ? payload.criteriaUnmetCount
                    : this._planExecutionDiagnostics.criteriaUnmetCount;
            this._planExecutionDiagnostics.unmetRequiredCriteria = Array.isArray(payload.unmetRequiredCriteria)
                ? payload.unmetRequiredCriteria.map(String)
                : this._planExecutionDiagnostics.unmetRequiredCriteria;
            if (typeof payload.taskAttempted === 'boolean') {
                this._planExecutionDiagnostics.taskAttempted = payload.taskAttempted;
            }
            if (typeof payload.userVisibleCompletion === 'boolean') {
                this._planExecutionDiagnostics.userVisibleCompletion = payload.userVisibleCompletion;
            } else {
                this._planExecutionDiagnostics.userVisibleCompletion = payload.responseProduced === true;
            }
            if (typeof payload.outcomeVerified === 'boolean') {
                this._planExecutionDiagnostics.outcomeVerified = payload.outcomeVerified;
            }
            if (Array.isArray(payload.reasonCodes)) {
                this._planExecutionDiagnostics.outcomeReasonCodes = payload.reasonCodes.map(String);
            }
            if (typeof payload.requiredCriteriaSatisfied === 'boolean') {
                this._planExecutionDiagnostics.requiredCriteriaSatisfied = payload.requiredCriteriaSatisfied;
            }
            this._planExecutionDiagnostics.lastUpdated = now;
        }
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

    private _handleMemoryAuthorityEvent(event: string, payload?: Record<string, unknown>): void {
        if (
            event !== 'memory.authority_check_allowed' &&
            event !== 'memory.authority_check_denied'
        ) {
            return;
        }
        if (!payload) return;
        const now = new Date().toISOString();
        const category = String(payload.category ?? '') as keyof RuntimeMemoryAuthorityDiagnosticsView['countsByCategory'];
        const memoryWriteMode = String(payload.memoryWriteMode ?? 'unknown') as keyof RuntimeMemoryAuthorityDiagnosticsView['countsByWriteMode'];
        if (category) {
            this._memoryAuthorityDiagnostics.countsByCategory[category] =
                (this._memoryAuthorityDiagnostics.countsByCategory[category] ?? 0) + 1;
        }
        this._memoryAuthorityDiagnostics.countsByWriteMode[memoryWriteMode] =
            (this._memoryAuthorityDiagnostics.countsByWriteMode[memoryWriteMode] ?? 0) + 1;

        const isDenied = event === 'memory.authority_check_denied';
        if (isDenied) {
            this._memoryAuthorityDiagnostics.denyCount += 1;
            this._memoryAuthorityDiagnostics.lastDeniedCategory = category;
            this._memoryAuthorityDiagnostics.lastDeniedReasonCodes = Array.isArray(payload.reasonCodes)
                ? payload.reasonCodes.map(String) as RuntimeMemoryAuthorityDiagnosticsView['lastDeniedReasonCodes']
                : [];
        } else {
            this._memoryAuthorityDiagnostics.allowCount += 1;
        }

        this._memoryAuthorityDiagnostics.lastDecision = {
            requestId: String(payload.writeId ?? payload.turnId ?? `memory-authority-${Date.now()}`),
            decision: isDenied ? 'deny' : 'allow',
            category,
            reasonCodes: Array.isArray(payload.reasonCodes)
                ? payload.reasonCodes.map(String) as RuntimeMemoryAuthorityDiagnosticsView['lastDeniedReasonCodes']
                : [],
            requiresGoalId: Boolean(payload.goalIdRequired),
            requiresTurnContext: Boolean(payload.turnContextRequired),
            requiresDurableStateAuthority: Boolean(payload.durableStateRequested),
            normalizedWriteMode: payload.memoryWriteMode as NonNullable<RuntimeMemoryAuthorityDiagnosticsView['lastDecision']>['normalizedWriteMode'],
        };
        this._memoryAuthorityDiagnostics.lastUpdated = now;
    }

    private _handleRecoveryEvent(
        event: string,
        executionId: string,
        payload?: Record<string, unknown>,
    ): void {
        if (!payload) return;
        const now = new Date().toISOString();
        const reasonCode = typeof payload.reasonCode === 'string' ? payload.reasonCode : undefined;
        if (reasonCode) {
            this._recoveryDiagnostics.lastReasonCodes = [
                reasonCode,
                ...this._recoveryDiagnostics.lastReasonCodes.filter((code) => code !== reasonCode),
            ].slice(0, 8);
        }

        if (event === 'recovery.decision_made') {
            const activeDecisionType = payload.decisionType as
                'retry' | 'replan' | 'escalate' | 'degrade_and_continue' | 'stop';
            this._recoveryDiagnostics.activeDecision = {
                triggerId: String(payload.triggerId ?? ''),
                decisionId: String(payload.decisionId ?? ''),
                decisionType: activeDecisionType,
                reasonCode: reasonCode ?? '',
                executionId,
                executionBoundaryId: payload.executionBoundaryId as string | undefined,
                scope: payload.scope as 'step' | 'handoff' | 'execution_boundary' | 'execution' | 'plan' | undefined,
                handoffType: payload.handoffType as 'tool' | 'workflow' | 'agent' | undefined,
                origin: payload.origin as 'automatic' | 'operator_override' | 'operator_approved' | undefined,
                approvalState: payload.operatorState && typeof payload.operatorState === 'object'
                    ? (payload.operatorState as { approvalState?: 'not_required' | 'pending_operator' | 'approved' | 'denied' }).approvalState
                    : undefined,
                overrideAllowed: payload.operatorState && typeof payload.operatorState === 'object'
                    ? (payload.operatorState as { overrideAllowed?: boolean }).overrideAllowed
                    : undefined,
                overrideApplied: payload.operatorState && typeof payload.operatorState === 'object'
                    ? (payload.operatorState as { overrideApplied?: boolean }).overrideApplied
                    : undefined,
                lastOperatorAction: payload.operatorState && typeof payload.operatorState === 'object'
                    ? (payload.operatorState as { lastOperatorAction?: 'approve_retry' | 'approve_replan' | 'approve_degraded_continue' | 'force_stop' | 'deny' }).lastOperatorAction
                    : undefined,
                operatorReasonCode: payload.operatorState && typeof payload.operatorState === 'object'
                    ? (payload.operatorState as { operatorReasonCode?: string }).operatorReasonCode
                    : undefined,
                degradedMode: payload.degradedMode as {
                    disabledCapabilities: string[];
                    continueMode: 'reduced_capability' | 'read_only' | 'local_only';
                } | undefined,
            };
            this._recoveryDiagnostics.budget = payload.budget as RecoveryDiagnosticsSnapshot['budget'];
            this._recoveryDiagnostics.exhausted = payload.exhausted as RecoveryDiagnosticsSnapshot['exhausted'];
        } else if (event === 'recovery.retry_requested') {
            this._recoveryDiagnostics.counters.retriesAttempted += 1;
        } else if (event === 'recovery.replan_requested') {
            this._recoveryDiagnostics.counters.replansRequested += 1;
        } else if (event === 'recovery.escalation_requested') {
            this._recoveryDiagnostics.counters.escalationsRaised += 1;
        } else if (event === 'recovery.degraded_continue_applied') {
            this._recoveryDiagnostics.counters.degradedContinuesApplied += 1;
        } else if (event === 'recovery.stop_requested') {
            this._recoveryDiagnostics.counters.stopsIssued += 1;
        } else if (event === 'recovery.loop_detected') {
            this._recoveryDiagnostics.counters.loopsDetected += 1;
        } else if (event === 'recovery.override_applied') {
            this._recoveryDiagnostics.counters.overridesApplied += 1;
        } else if (event === 'recovery.approval_required') {
            this._recoveryDiagnostics.counters.approvalsRequired += 1;
        } else if (event === 'recovery.approval_denied' || event === 'recovery.override_denied') {
            this._recoveryDiagnostics.counters.approvalsDenied += 1;
        } else {
            return;
        }

        this._recoveryDiagnostics.lastUpdated = now;
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

