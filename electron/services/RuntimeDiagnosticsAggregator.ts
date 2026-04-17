import type {
    RuntimeDiagnosticsSnapshot,
    RuntimeFailureSummary,
    InferenceDiagnosticsState,
    McpInventoryDiagnostics,
    CognitiveDiagnosticsSnapshot,
    AuthorityLaneDiagnosticsSnapshot,
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
    }

    /**
     * Stops the internal TelemetryBus subscription.
     * Call during teardown if the aggregator instance is being discarded.
     */
    public dispose(): void {
        this._unsubscribeAuthority();
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

