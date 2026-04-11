/**
 * Pre-Inference Context Orchestrator — Phase 3A: Live Cognitive Path Integration
 *
 * The canonical pre-inference orchestration stage. Gathers and normalises all
 * live context sources before CognitiveTurnAssembler builds TalaCognitiveContext.
 *
 * Responsibilities:
 *   - Inspect normalised user input and active mode
 *   - Decide which retrieval sources to query (intent/mode-aware gating)
 *   - Invoke relevant sources in parallel where safe
 *   - Normalise outputs into a single PreInferenceOrchestrationResult
 *   - Emit structured telemetry for every source decision
 *
 * Source categories handled:
 *   - Memory retrieval (via TalaContextRouter)
 *   - RAG / documentation retrieval (via TalaContextRouter + DocumentationIntelligenceService)
 *   - Astro / emotional state retrieval (via AstroService)
 *   - Reflection note retrieval (from reflectionContributionStore)
 *   - MCP pre-inference context (intent/mode-gated; gracefully degraded)
 *
 * Alignment rules:
 *   - AgentService must NOT perform ad hoc retrieval once this orchestrator exists.
 *   - CognitiveTurnAssembler must NOT make raw service calls directly.
 *   - Degraded or unavailable sources MUST NOT collapse a safe turn.
 *   - All outputs are normalised structured objects — no raw service payloads.
 */

import type { MemoryItem } from '../MemoryService';
import type { TurnContext } from '../router/ContextAssembler';
import type { Mode } from '../router/ModePolicyEngine';
import type { TalaContextRouter } from '../router/TalaContextRouter';
import type { DocumentationIntelligenceService } from '../DocumentationIntelligenceService';
import { reflectionContributionStore } from './ReflectionContributionModel';
import { telemetry } from '../TelemetryService';
import type { WorldModelAssembler } from '../world/WorldModelAssembler';
import type { TalaWorldModel } from '../../../shared/worldModelTypes';
import type { MaintenanceLoopService } from '../maintenance/MaintenanceLoopService';

// ─── External service interfaces ─────────────────────────────────────────────

/** Minimal AstroService interface needed by the orchestrator. */
export interface AstroServiceLike {
    getReadyStatus(): boolean;
    getEmotionalState(agentId?: string, contextPrompt?: string): Promise<string>;
}

/** Minimal MCP service interface for pre-inference queries. */
export interface McpPreInferenceServiceLike {
    callTool?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

// ─── Orchestration result ─────────────────────────────────────────────────────

/**
 * Normalised pre-inference orchestration result.
 *
 * Feeds directly into CognitiveTurnAssembler.assemble() and provides backward-
 * compatible fields for the existing prompt-assembly path.
 */
export interface PreInferenceOrchestrationResult {
    /** The fully-resolved TurnContext from TalaContextRouter (capabilities, write policy, etc.). */
    turnContext: TurnContext;

    // ─── Memory retrieval ─────────────────────────────────────────────────
    /** Approved MemoryItem[] for CognitiveTurnAssembler. */
    approvedMemories: MemoryItem[];
    /** Total candidates before filtering. */
    memoryCandidateCount: number;
    /** Memories excluded by policy. */
    memoryExcludedCount: number;
    /** Whether retrieval was suppressed (e.g. greeting). */
    memoryRetrievalSuppressed: boolean;
    /** Human-readable suppression reason. */
    memorySuppressionReason?: string;
    /** Classified intent class. */
    intentClass: string;
    /** Whether this turn is a greeting. */
    isGreeting: boolean;

    // ─── Pre-assembled memory text (backward compatibility) ───────────────
    /**
     * Pre-assembled memory context text for the existing CompactPromptBuilder path.
     * Derived from turnContext.promptBlocks.
     */
    memoryContextText: string;

    // ─── Documentation retrieval ──────────────────────────────────────────
    /** Documentation context text (from DocumentationIntelligenceService). */
    docContextText: string | null;
    /** Source IDs for retrieved documentation chunks. */
    docSourceIds: string[];
    /** Rationale for doc retrieval or suppression. */
    docRationale?: string;

    // ─── Astro / emotional state ──────────────────────────────────────────
    /** Raw emotional state string from AstroService. Null if unavailable. */
    astroStateText: string | null;

    // ─── MCP pre-inference context ────────────────────────────────────────
    /** Optional MCP context summary (normalised, not raw payload). */
    mcpContextSummary?: string;

    // ─── World model contribution (Phase 4A) ─────────────────────────────
    /**
     * Optional compact world-state summary contributed to the cognitive context.
     * Derived selectively from TalaWorldModel based on intent/mode — not the full model.
     * Undefined when world-model contribution is skipped as irrelevant for this turn.
     */
    worldStateSummary?: string;

    // ─── Maintenance summary contribution (Phase 4B) ──────────────────────
    /**
     * Optional compact maintenance summary contributed when maintenance issues
     * are relevant to the current turn (e.g. troubleshooting, technical intents).
     * Suppressed on general chat turns to avoid noise.
     */
    maintenanceSummary?: string;

    // ─── Orchestration metadata ───────────────────────────────────────────
    /** Sources that were queried this turn. */
    sourcesQueried: string[];
    /** Sources that were suppressed this turn. */
    sourcesSuppressed: string[];
    /** Total orchestration wall-clock time in ms. */
    orchestrationDurationMs: number;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * PreInferenceContextOrchestrator
 *
 * Gathers all live pre-inference context from relevant sources and returns a
 * single normalised result object that feeds CognitiveTurnAssembler.
 *
 * All sources are queried with intent/mode-aware gating. Unavailable sources
 * degrade gracefully — they never collapse a safe turn.
 */
export class PreInferenceContextOrchestrator {
    constructor(
        private readonly talaRouter: TalaContextRouter,
        private readonly astroService: AstroServiceLike | null,
        private readonly docIntel: DocumentationIntelligenceService | null,
        private readonly mcpService: McpPreInferenceServiceLike | null = null,
        private readonly worldModelAssembler: WorldModelAssembler | null = null,
        private readonly maintenanceLoop: MaintenanceLoopService | null = null,
    ) {}

    /**
     * Orchestrates all pre-inference context gathering for one turn.
     *
     * @param turnId - Unique turn identifier.
     * @param rawInput - Raw user input text.
     * @param mode - Active cognitive mode.
     * @param options - Optional agent/user IDs for emotional state personalisation,
     *   plus `notebookActive` to activate strict notebook grounding.
     * @returns Normalised pre-inference orchestration result.
     */
    public async orchestrate(
        turnId: string,
        rawInput: string,
        mode: Mode,
        options: { agentId?: string; userId?: string; notebookActive?: boolean } = {},
    ): Promise<PreInferenceOrchestrationResult> {
        const orchestrationStart = Date.now();
        const sourcesQueried: string[] = [];
        const sourcesSuppressed: string[] = [];

        telemetry.operational(
            'cognitive',
            'preinference_orchestration_started',
            'info',
            `turn:${turnId}`,
            `Pre-inference orchestration started: mode=${mode} inputLen=${rawInput.length}`,
            'success',
            { payload: { turnId, mode, inputLen: rawInput.length } },
        );

        try {
            // ── 1. Router context (memory + doc) — always run ─────────────────
            sourcesQueried.push('tala_router');
            const turnContext = await this.talaRouter.process(
                turnId,
                rawInput,
                mode,
                this.docIntel ?? undefined,
                options.notebookActive,
            );
            const turnPolicy = turnContext.turnPolicy;

            const isGreeting = turnContext.intent.isGreeting;
            const intentClass = turnContext.intent.class;
            const memoryRetrievalSuppressed = turnContext.retrieval.suppressed;
            const memoryCandidateCount = turnContext.retrieval.approvedCount + turnContext.retrieval.excludedCount;
            const memoryExcludedCount = turnContext.retrieval.excludedCount;
            const approvedMemories: MemoryItem[] = (turnContext as any).resolvedMemories ?? [];

            // Emit memory retrieval telemetry
            if (memoryRetrievalSuppressed) {
                sourcesSuppressed.push('memory');
                telemetry.operational(
                    'cognitive',
                    'memory_preinference_applied',
                    'info',
                    `turn:${turnId}`,
                    `Memory retrieval suppressed: reason=${isGreeting ? 'greeting_intent' : 'policy'}`,
                    'suppressed',
                    { payload: { turnId, suppressed: true, reason: isGreeting ? 'greeting_intent' : 'policy' } },
                );
            } else {
                telemetry.operational(
                    'cognitive',
                    'memory_preinference_applied',
                    'info',
                    `turn:${turnId}`,
                    `Memory retrieval completed: approved=${turnContext.retrieval.approvedCount} excluded=${memoryExcludedCount}`,
                    'success',
                    {
                        payload: {
                            turnId,
                            suppressed: false,
                            approvedCount: turnContext.retrieval.approvedCount,
                            excludedCount: memoryExcludedCount,
                        },
                    },
                );
            }

            // Build backward-compatible memory context text from promptBlocks
            const memoryContextText = turnContext.promptBlocks
                .map((b: import('../router/ContextAssembler').ContextBlock) => `${b.header}\n${b.content}`)
                .join('\n\n');

            // ── 2. Documentation context ──────────────────────────────────────
            let docContextText: string | null = null;
            let docSourceIds: string[] = [];
            let docRationale: string | undefined;

            // Doc context is fetched inside talaRouter.process() and reflected in
            // the turnContext promptBlocks. Extract the doc block if present.
            const docBlock = turnContext.promptBlocks.find(
                (b: import('../router/ContextAssembler').ContextBlock) =>
                    b.header?.includes('DOCUMENTATION') || b.header?.includes('DOC'),
            );
            if (docBlock) {
                docContextText = docBlock.content ?? null;
                docSourceIds = [];
                docRationale = 'Documentation context extracted from router prompt blocks';
                sourcesQueried.push('doc_intel');
                telemetry.operational(
                    'cognitive',
                    'doc_preinference_applied',
                    'info',
                    `turn:${turnId}`,
                    `Documentation context retrieved from router`,
                    'success',
                    { payload: { turnId, docApplied: true } },
                );
            } else {
                sourcesSuppressed.push('doc_intel');
                docRationale = turnPolicy.docRetrievalPolicy === 'suppressed'
                    ? 'Documentation retrieval suppressed by turn policy'
                    : 'No documentation-relevant query detected';
                telemetry.operational(
                    'cognitive',
                    'doc_preinference_applied',
                    'info',
                    `turn:${turnId}`,
                    `Documentation context suppressed: ${docRationale}`,
                    'suppressed',
                    { payload: { turnId, docApplied: false, reason: docRationale } },
                );
            }

            // ── 3. Astro / emotional state ────────────────────────────────────
            let astroStateText: string | null = null;

            // Emotional state is suppressed in RP mode (separate full emotional control)
            // and when astro service is unavailable.
            const shouldQueryAstro =
                turnPolicy.astroLevel !== 'off' &&
                this.astroService !== null &&
                this.astroService.getReadyStatus();

            if (shouldQueryAstro && this.astroService) {
                sourcesQueried.push('astro');
                telemetry.operational(
                    'cognitive',
                    'emotional_state_requested',
                    'info',
                    `turn:${turnId}`,
                    `Astro emotional state requested: mode=${mode}`,
                    'success',
                    { payload: { turnId, mode } },
                );
                try {
                    const agentId = options.agentId ?? 'tala';
                    const userId = options.userId ?? 'User';
                    astroStateText = await this.astroService.getEmotionalState(agentId, userId);
                    telemetry.operational(
                        'cognitive',
                        'emotional_state_applied',
                        'info',
                        `turn:${turnId}`,
                        `Astro emotional state retrieved and applied`,
                        'success',
                        { payload: { turnId, available: true } },
                    );
                } catch (e) {
                    astroStateText = null;
                    telemetry.operational(
                        'cognitive',
                        'emotional_state_skipped',
                        'warn',
                        `turn:${turnId}`,
                        `Astro emotional state unavailable — graceful fallback`,
                        'failure',
                        { payload: { turnId, error: String(e).slice(0, 120) } },
                    );
                }
            } else {
                sourcesSuppressed.push('astro');
                const suppressReason = turnPolicy.astroLevel === 'off'
                    ? 'Turn policy suppresses astro state'
                    : this.astroService === null
                    ? 'AstroService not wired'
                    : 'AstroService not ready';
                telemetry.operational(
                    'cognitive',
                    'emotional_state_skipped',
                    'info',
                    `turn:${turnId}`,
                    `Astro emotional state skipped: ${suppressReason}`,
                    'suppressed',
                    { payload: { turnId, reason: suppressReason } },
                );
            }

            // ── 4. Reflection notes ───────────────────────────────────────────
            // Reflection notes are held in the in-process store; no remote call needed.
            sourcesQueried.push('reflection_store');
            const noteCount = reflectionContributionStore.getNoteCount();
            if (noteCount > 0) {
                telemetry.operational(
                    'cognitive',
                    'reflection_note_applied',
                    'info',
                    `turn:${turnId}`,
                    `Reflection notes available: ${noteCount} notes in store`,
                    'success',
                    { payload: { turnId, noteCount } },
                );
            } else {
                telemetry.operational(
                    'cognitive',
                    'reflection_note_suppressed',
                    'info',
                    `turn:${turnId}`,
                    `No reflection notes in store`,
                    'suppressed',
                    { payload: { turnId, noteCount: 0 } },
                );
            }

            // ── 5. MCP pre-inference (intent/mode-gated) ──────────────────────
            let mcpContextSummary: string | undefined;
            const mcpEligible = this._isMcpPreInferenceEligible(turnContext);

            if (mcpEligible && this.mcpService?.callTool) {
                sourcesQueried.push('mcp_preinference');
                telemetry.operational(
                    'cognitive',
                    'mcp_preinference_requested',
                    'info',
                    `turn:${turnId}`,
                    `MCP pre-inference requested: mode=${mode} intent=${intentClass}`,
                    'success',
                    { payload: { turnId, mode, intentClass } },
                );
                try {
                    mcpContextSummary = await this._queryMcpPreInference(turnId, mode, intentClass);
                    telemetry.operational(
                        'cognitive',
                        'mcp_preinference_completed',
                        'info',
                        `turn:${turnId}`,
                        `MCP pre-inference completed`,
                        'success',
                        { payload: { turnId, hasSummary: !!mcpContextSummary } },
                    );
                } catch (e) {
                    mcpContextSummary = undefined;
                    telemetry.operational(
                        'cognitive',
                        'mcp_preinference_failed',
                        'warn',
                        `turn:${turnId}`,
                        `MCP pre-inference failed — graceful fallback`,
                        'failure',
                        { payload: { turnId, error: String(e).slice(0, 120) } },
                    );
                }
            } else {
                sourcesSuppressed.push('mcp_preinference');
                telemetry.operational(
                    'cognitive',
                    'mcp_preinference_suppressed',
                    'info',
                    `turn:${turnId}`,
                    `MCP pre-inference suppressed: mode=${mode} intent=${intentClass} eligible=${mcpEligible}`,
                    'suppressed',
                    { payload: { turnId, mode, intentClass, mcpAvailable: !!this.mcpService?.callTool } },
                );
            }

            const orchestrationDurationMs = Date.now() - orchestrationStart;

            telemetry.operational(
                'cognitive',
                'preinference_orchestration_completed',
                'info',
                `turn:${turnId}`,
                `Pre-inference orchestration completed in ${orchestrationDurationMs}ms: sources=[${sourcesQueried.join(',')}] suppressed=[${sourcesSuppressed.join(',')}]`,
                'success',
                {
                    payload: {
                        turnId,
                        orchestrationDurationMs,
                        sourcesQueried,
                        sourcesSuppressed,
                        memoryApproved: turnContext.retrieval.approvedCount,
                        docApplied: !!docContextText,
                        astroApplied: !!astroStateText,
                        mcpApplied: !!mcpContextSummary,
                    },
                },
            );

            // Phase 3C — emit performance telemetry event
            telemetry.operational(
                'cognitive',
                'preinference_duration_ms',
                'debug',
                `turn:${turnId}`,
                `Pre-inference duration: ${orchestrationDurationMs}ms`,
                'success',
                { payload: { turnId, durationMs: orchestrationDurationMs } },
            );

            // ── 6. World model contribution (Phase 4A) ────────────────────────
            // Selectively contribute world-state summary based on intent/mode.
            // Not contributed on every turn — only when situational context is relevant.
            let worldStateSummary: string | undefined;
            const worldModel = this.worldModelAssembler?.getCachedModel();

            if (worldModel && this._isWorldStateRelevant(turnContext)) {
                worldStateSummary = this._buildWorldStateSummary(worldModel, intentClass);
                sourcesQueried.push('world_model');
                telemetry.operational(
                    'world_model',
                    'world_state_applied',
                    'info',
                    `turn:${turnId}`,
                    `World state summary applied: intent=${intentClass} mode=${mode}`,
                    'success',
                    { payload: { turnId, mode, intentClass, summaryLen: worldStateSummary?.length ?? 0 } },
                );
            } else {
                sourcesSuppressed.push('world_model');
                telemetry.operational(
                    'world_model',
                    'world_state_skipped',
                    'info',
                    `turn:${turnId}`,
                    `World state skipped: intent=${intentClass} mode=${mode} modelAvailable=${!!worldModel}`,
                    'suppressed',
                    { payload: { turnId, mode, intentClass, modelAvailable: !!worldModel } },
                );
            }

            // ── 7. Maintenance summary contribution (Phase 4B) ───────────────
            // Selectively inject maintenance context on troubleshooting/technical turns.
            // Suppressed on general chat, greeting, and RP mode to avoid noise.
            let maintenanceSummary: string | undefined;
            if (this.maintenanceLoop && this._isMaintenanceRelevant(turnContext)) {
                if (this.maintenanceLoop.hasActionableIssues()) {
                    const cognitiveSummary = this.maintenanceLoop.getCognitiveSummary();
                    maintenanceSummary = this._buildMaintenanceSummary(cognitiveSummary);
                    sourcesQueried.push('maintenance');
                } else {
                    sourcesSuppressed.push('maintenance');
                }
            } else {
                sourcesSuppressed.push('maintenance');
            }

            return {
                turnContext,
                approvedMemories,
                memoryCandidateCount,
                memoryExcludedCount,
                memoryRetrievalSuppressed,
                memorySuppressionReason: memoryRetrievalSuppressed
                    ? (isGreeting ? 'greeting_intent_suppression' : 'retrieval_policy_suppressed')
                    : undefined,
                intentClass,
                isGreeting,
                memoryContextText,
                docContextText,
                docSourceIds,
                docRationale,
                astroStateText,
                mcpContextSummary,
                worldStateSummary,
                maintenanceSummary,
                sourcesQueried,
                sourcesSuppressed,
                orchestrationDurationMs,
            };
        } catch (e) {
            const orchestrationDurationMs = Date.now() - orchestrationStart;
            telemetry.operational(
                'cognitive',
                'preinference_orchestration_failed',
                'error',
                `turn:${turnId}`,
                `Pre-inference orchestration failed after ${orchestrationDurationMs}ms`,
                'failure',
                { payload: { turnId, error: String(e).slice(0, 200) } },
            );
            throw e;
        }
    }

    // ─── MCP eligibility gating ───────────────────────────────────────────────

    /**
     * Determines whether MCP pre-inference queries are eligible for this turn.
     *
     * Rules:
     *   - RP mode: MCP is suppressed (no external state retrieval)
     *   - Greeting/conversation intents: MCP is suppressed (no cognitive overhead)
     *   - Assistant/hybrid with technical/coding/task intent: MCP may be queried
     */
    private _isMcpPreInferenceEligible(turnContext: TurnContext): boolean {
        if (turnContext.turnPolicy.mcpPreInferencePolicy !== 'enabled') return false;
        const mode = turnContext.resolvedMode as Mode;
        const intentClass = turnContext.intent.class;
        if (mode === 'rp') return false;
        if (intentClass === 'greeting' || intentClass === 'conversation') return false;
        return intentClass === 'coding' || intentClass === 'technical' || intentClass === 'task';
    }

    /**
     * Queries MCP services for pre-inference context.
     * Returns a normalised summary string safe for cognitive assembly.
     *
     * Only lightweight diagnostic/state MCP queries are made here.
     * Heavy tool calls happen during inference, not pre-inference.
     */
    private async _queryMcpPreInference(
        _turnId: string,
        _mode: Mode,
        _intentClass: string,
    ): Promise<string | undefined> {
        // MCP pre-inference queries are intentionally minimal — we only ask for
        // operational state summaries that can help ground cognitive context.
        // Heavy tool use (filesystem, code execution) happens during inference.
        //
        // If no relevant MCP state is available, return undefined (graceful no-op).
        return undefined;
    }

    // ─── World model helpers (Phase 4A) ──────────────────────────────────────

    /**
     * Determines whether world-state contribution is relevant for this turn.
     *
     * Rules:
     *   - RP mode: world state is suppressed (no environmental grounding in RP).
     *   - Greeting/conversation: world state is not useful overhead.
     *   - Assistant/hybrid with technical, coding, task, or workspace intent:
     *     world state is relevant and should be contributed.
     */
    private _isWorldStateRelevant(turnContext: TurnContext): boolean {
        if (turnContext.turnPolicy.worldStatePolicy !== 'enabled') return false;
        const mode = turnContext.resolvedMode as Mode;
        const intentClass = turnContext.intent.class;
        if (mode === 'rp') return false;
        if (intentClass === 'greeting' || intentClass === 'conversation') return false;
        return (
            intentClass === 'coding' ||
            intentClass === 'technical' ||
            intentClass === 'task' ||
            intentClass === 'workspace' ||
            intentClass === 'repo'
        );
    }

    /**
     * Builds a compact world-state summary string for cognitive injection.
     * Only includes sections relevant to the current intent — not the full model.
     * Safe for injection into cognitive context; no raw file contents.
     */
    private _buildWorldStateSummary(model: TalaWorldModel, intentClass: string): string {
        const parts: string[] = [];

        // Repo section — relevant for coding/technical/repo intents.
        if (
            (intentClass === 'coding' || intentClass === 'technical' || intentClass === 'repo') &&
            model.repo.meta.availability !== 'unavailable'
        ) {
            const branchPart = model.repo.branch ? ` (${model.repo.branch})` : '';
            const dirtyPart = model.repo.isDirty ? ` — ${model.repo.changedFileCount} uncommitted change(s)` : '';
            parts.push(`Repo: ${model.repo.projectType}${branchPart}${dirtyPart}`);
        }

        // Runtime section — relevant for technical/task intents.
        if (
            (intentClass === 'technical' || intentClass === 'task') &&
            model.runtime.meta.availability !== 'unavailable'
        ) {
            const providerPart = model.runtime.selectedProviderName
                ? ` provider=${model.runtime.selectedProviderName}`
                : '';
            const degradedPart =
                model.runtime.hasActiveDegradation
                    ? ` DEGRADED: ${model.runtime.degradedSubsystems.join(',')}`
                    : '';
            parts.push(`Runtime: inference=${model.runtime.inferenceReady ? 'ready' : 'not ready'}${providerPart}${degradedPart}`);
        }

        // Workspace section — relevant for workspace/task intents.
        if (
            (intentClass === 'workspace' || intentClass === 'task') &&
            model.workspace.meta.availability !== 'unavailable'
        ) {
            parts.push(`Workspace: ${model.workspace.classification} dirs=[${model.workspace.knownDirectories.join(',')}]`);
        }

        // Goal section — always include if available and there is an explicit goal.
        if (model.goals.hasExplicitGoal && model.goals.immediateTask) {
            parts.push(`Active task: ${model.goals.immediateTask.slice(0, 80)}`);
        }

        return parts.join(' | ');
    }

    /**
     * Returns true if maintenance summary should be contributed for this turn.
     * Suppressed on RP mode, greetings, and general conversation.
     */
    private _isMaintenanceRelevant(turnContext: TurnContext): boolean {
        if (turnContext.turnPolicy.maintenancePolicy !== 'enabled') return false;
        const mode = turnContext.resolvedMode as Mode;
        const intentClass = turnContext.intent.class;
        if (mode === 'rp') return false;
        if (intentClass === 'greeting' || intentClass === 'conversation') return false;
        return (
            intentClass === 'technical' ||
            intentClass === 'task' ||
            intentClass === 'troubleshooting' ||
            intentClass === 'coding' ||
            intentClass === 'workspace'
        );
    }

    /**
     * Builds a compact maintenance summary string for cognitive injection.
     * Compact and safe — no raw issue details or execution logs.
     */
    private _buildMaintenanceSummary(
        summary: import('../../../shared/maintenance/maintenanceTypes').MaintenanceCognitiveSummary,
    ): string {
        const parts: string[] = [];
        if (summary.topIssueDescription) {
            parts.push(`[Maintenance] ${summary.topIssueDescription}`);
        }
        if (summary.activeIssueCount > 1) {
            parts.push(`+${summary.activeIssueCount - 1} more issue(s).`);
        }
        if (summary.recommendedAction) {
            parts.push(summary.recommendedAction);
        }
        if (summary.pendingApproval) {
            parts.push('User approval needed for a maintenance action.');
        }
        if (summary.recentAutoRecovery) {
            parts.push('Auto-recovery was recently attempted.');
        }
        return parts.join(' ');
    }
}
