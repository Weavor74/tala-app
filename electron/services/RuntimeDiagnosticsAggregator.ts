/**
 * RuntimeDiagnosticsAggregator — Unified Runtime Diagnostics Snapshot Producer
 *
 * Assembles a RuntimeDiagnosticsSnapshot from:
 * - InferenceDiagnosticsService (inference provider + stream state)
 * - McpLifecycleManager (MCP service inventory + lifecycle state)
 * - RuntimeControlService (operator actions, health scores) — Phase 2B
 *
 * This is the single point of truth for app-facing runtime diagnostics.
 * IPC handlers call getSnapshot() to retrieve the current operational picture.
 *
 * Design rules:
 * - All returned data is safe for IPC serialization.
 * - No probing or live service calls — reads from already-maintained state.
 * - Snapshot is assembled on demand; no background aggregation loop needed.
 * - Degraded subsystem list is derived from normalized status, not raw booleans.
 */

import type {
    RuntimeDiagnosticsSnapshot,
    RuntimeFailureSummary,
    InferenceDiagnosticsState,
    McpInventoryDiagnostics,
    CognitiveDiagnosticsSnapshot,
} from '../../shared/runtimeDiagnosticsTypes';
import type { InferenceDiagnosticsService } from './InferenceDiagnosticsService';
import type { McpLifecycleManager } from './McpLifecycleManager';
import { providerHealthScorer } from './inference/ProviderHealthScorer';
import type { RuntimeControlService } from './RuntimeControlService';
import type { TalaCognitiveContext, MemoryContributionCategory } from '../../shared/cognitiveTurnTypes';
import type { CompactionDiagnosticsSummary } from '../../shared/modelCapabilityTypes';

// ─── Phase 3C: Extended cognitive metadata ────────────────────────────────────

/** Extended cognitive metadata recorded per turn for Phase 3C diagnostics. */
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

    constructor(
        private readonly inferenceDiagnostics: InferenceDiagnosticsService,
        private readonly mcpLifecycle: McpLifecycleManager,
        private readonly runtimeControl?: RuntimeControlService,
    ) {}

    /**
     * Records the most recent cognitive context for inclusion in diagnostics snapshots.
     * Called by CognitiveTurnAssembler (or AgentService) after assembling each turn.
     */
    public recordCognitiveContext(context: TalaCognitiveContext): void {
        this.lastCognitiveMeta = { ...this.lastCognitiveMeta, context };
    }

    /**
     * Records extended cognitive metadata for Phase 3C diagnostics.
     * Call after compaction, orchestration, and assembly to capture performance data.
     */
    public recordCognitiveMeta(meta: Partial<Omit<CognitiveTurnMeta, 'context'>>): void {
        if (this.lastCognitiveMeta) {
            this.lastCognitiveMeta = { ...this.lastCognitiveMeta, ...meta };
        }
    }
    /**
     * Returns the current normalized runtime diagnostics snapshot.
     * Safe to call from IPC handlers.
     *
     * @param sessionId - Optional session ID to include in the snapshot.
     */
    public getSnapshot(sessionId?: string): RuntimeDiagnosticsSnapshot {
        const now = new Date().toISOString();
        const inferenceState = this.inferenceDiagnostics.getState();
        const mcpInventory = this.mcpLifecycle.getDiagnosticsInventory();

        const degradedSubsystems = this._computeDegradedSubsystems(inferenceState, mcpInventory);
        const recentFailures = this._computeRecentFailures(inferenceState, mcpInventory);

        // Phase 2B extensions
        const providerHealthScores = providerHealthScorer.getAllScores();
        const suppressedProviders = providerHealthScorer.getSuppressedProviderIds();
        const operatorActions = this.runtimeControl?.getOperatorActions() ?? [];
        const recentProviderRecoveries = this.runtimeControl?.getRecentProviderRecoveries() ?? [];
        const recentMcpRestarts = this.runtimeControl?.getRecentMcpRestarts() ?? [];

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
            // Phase 2B
            operatorActions,
            providerHealthScores,
            suppressedProviders,
            recentProviderRecoveries,
            recentMcpRestarts,
            // Phase 3: Cognitive diagnostics
            cognitive: this._buildCognitiveDiagnostics(now),
        };
    }

    /**
     * Returns only the normalized inference diagnostics state.
     * Used by the diagnostics:getInferenceStatus IPC handler.
     */
    public getInferenceStatus(): InferenceDiagnosticsState {
        return this.inferenceDiagnostics.getState();
    }

    /**
     * Returns only the normalized MCP inventory diagnostics.
     * Used by the diagnostics:getMcpStatus IPC handler.
     */
    public getMcpStatus(): McpInventoryDiagnostics {
        return this.mcpLifecycle.getDiagnosticsInventory();
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Builds a normalized cognitive diagnostics snapshot from the last recorded
     * cognitive context. Returns undefined if no cognitive context has been recorded.
     */
    private _buildCognitiveDiagnostics(now: string): CognitiveDiagnosticsSnapshot | undefined {
        const meta = this.lastCognitiveMeta;
        if (!meta) return undefined;
        const ctx = meta.context;

        const byCategory: Partial<Record<MemoryContributionCategory, number>> = {};
        for (const c of ctx.memoryContributions.contributions) {
            byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
        }

        // ── Phase 3C: extended fields ─────────────────────────────────────────
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

            // Phase 3C extensions
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

    private _computeDegradedSubsystems(
        inference: InferenceDiagnosticsState,
        mcp: McpInventoryDiagnostics,
    ): string[] {
        const degraded: string[] = [];

        // Inference: degraded if selected provider is not ready and stream is not idle
        if (!inference.selectedProviderReady && inference.streamStatus !== 'idle') {
            degraded.push('inference');
        }

        // Inference: degraded if last stream failed/timed-out
        if (inference.lastStreamStatus === 'failed' || inference.lastStreamStatus === 'timed_out') {
            if (!degraded.includes('inference')) degraded.push('inference');
        }

        // MCP: degraded if any service is degraded or unavailable
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

        // Inference failures
        if (inference.lastFailureTime) {
            count++;
            failedEntityIds.push(inference.lastUsedProviderId ?? 'inference');
            if (!lastFailureTime || inference.lastFailureTime > lastFailureTime) {
                lastFailureTime = inference.lastFailureTime;
                lastFailureReason = inference.lastFailureReason;
            }
        }

        // MCP failures
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

