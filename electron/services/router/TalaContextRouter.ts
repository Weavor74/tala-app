import { MemoryService, MemoryItem } from '../MemoryService';
import { Mode, ModePolicyEngine } from './ModePolicyEngine';
import { IntentClassifier, Intent } from './IntentClassifier';
import { MemoryFilter } from './MemoryFilter';
import { ContextAssembler, TurnContext, MemoryWriteDecision, MemoryWriteCategory } from './ContextAssembler';
import { DocumentationIntelligenceService } from '../DocumentationIntelligenceService';
import { RagService } from '../RagService';
import { auditLogger } from '../AuditLogger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Tala Context Router
 * 
 * The primary entry point for context orchestration in the TALA ecosystem.
 * It determines how to assemble the prompt for each turn by classifying intent,
 * filtering relevant memories, and enforcing mode-based capability policies.
 * 
 * **Pipeline Logic:**
 * 1. **Intent Classification**: Analyzes the query to identify the user's goal.
 * 2. **Lore Follow-up Carryover**: For underspecified follow-ups after a lore turn,
 *    carries over autobiographical retrieval context for up to 5 minutes.
 * 3. **Retrieval Gating**: Bypasses memory search for simple intents (e.g., greetings).
 * 4. **Memory Retrieval**: Searches the `MemoryService` using mode-scoped weights.
 *    For lore intent: also queries `RagService` for LTMF/canon lore candidates first.
 * 5. **Policy Enforcement**: Filters memories based on security and mode constraints.
 * 6. **Contradiction Resolution**: Merges conflicting memory state with source-priority ranking.
 * 7. **Prompt Assembly**: Generates the final instruction blocks via the `ContextAssembler`.
 * 8. **Capability Resolution**: Maps the current state to allowed system tools.
 * 9. **Memory Write Policy**: Determines whether this turn's output may be persisted.
 * 10. **Audit Emission**: Emits structured telemetry for the full routing decision.
 */
export class TalaContextRouter {
    private memoryService: MemoryService;
    /** Optional RAG service — injected so lore turns can query LTMF/canon lore first. */
    private ragService?: RagService;

    /**
     * How long (ms) after a lore turn that a follow-up underspecified query
     * inherits the autobiographical retrieval domain.
     */
    private static readonly LORE_CARRYOVER_MS = 5 * 60 * 1000;

    /**
     * Maximum number of RAG/LTMF/canon lore candidates to inject for a lore turn.
     * These occupy the primary slots in the approved memory set.
     */
    private static readonly LORE_PRIMARY_CANDIDATE_LIMIT = 5;

    /**
     * Maximum number of explicit/chat fallback candidates allowed in the approved
     * set when canon lore candidates are present.  Set to 1 so recent greetings and
     * conversational snippets do not crowd out autobiographical lore.
     */
    private static readonly LORE_FALLBACK_CAP = 1;

    /**
     * Sources treated as "canon lore" for the purposes of source-bucket composition.
     * Candidates from any of these sources fill the primary slots first.
     */
    private static readonly LORE_CANON_SOURCES = new Set([
        'rag', 'diary', 'graph', 'core_bio', 'lore',
    ]);

    /**
     * Patterns that indicate a short follow-up query referencing a prior lore turn.
     * These are matched in addition to IntentClassifier to handle underspecified
     * replies like "you don't remember?" that may not fire the main lore patterns.
     */
    private static readonly LORE_FOLLOWUP_PATTERNS = [
        /\b(so\s+you\s+(don'?t|do\s+not)|you\s+(don'?t|do\s+not))\s+(have|remember|recall|know)/i,
        /\b(what\s+about\s+(that|then|it)|and\s+that|but\s+that)\b/i,
    ];

    /** Timestamp of the most recent lore-classified turn (for carryover logic). */
    private lastLoreQueryTs: number = 0;

    constructor(memoryService: MemoryService, ragService?: RagService) {
        this.memoryService = memoryService;
        this.ragService = ragService;
    }

    /**
     * The primary entry point for context orchestration.
     *
     * Returns a fully-populated `TurnContext` that carries all routing decisions
     * required for a deterministic, auditable agent turn.
     */
    public async process(turnId: string, query: string, mode: Mode, docIntel?: DocumentationIntelligenceService): Promise<TurnContext> {
        const turnStartedAt = Date.now();
        const correlationId = uuidv4();

        console.log(`[TalaRouter] Processing turn ${turnId} in mode=${mode} `);

        // 1. Resolve Mode (Handled by input)
        // 2. Classify Intent
        const rawIntent = IntentClassifier.classify(query);

        // 2a. Lore follow-up carryover: if this turn is underspecified and follows a recent
        //     lore turn, treat it as lore so autobiographical retrieval stays active.
        const isWithinLoreWindow = (Date.now() - this.lastLoreQueryTs) < TalaContextRouter.LORE_CARRYOVER_MS;
        const isLoreFollowUp =
            isWithinLoreWindow &&
            rawIntent.class !== 'lore' &&
            TalaContextRouter.LORE_FOLLOWUP_PATTERNS.some(p => p.test(query));

        const intent: Intent = isLoreFollowUp
            ? {
                class: 'lore',
                confidence: 0.75,
                subsystem: 'lore',
                precedenceLog: 'Lore carryover from previous turn (follow-up detected)',
            }
            : rawIntent;

        if (isLoreFollowUp) {
            console.log(`[TalaRouter] Lore follow-up detected — carrying over autobiographical retrieval context`);
        }

        const isGreetingOnly = intent.class === 'greeting';
        const retrievalSuppressed = isGreetingOnly; // Gating logic

        console.log(`[TalaRouter] Intent: ${intent.class} | Suppressed: ${retrievalSuppressed} | Reason: ${intent.precedenceLog || 'standard'} `);
        if (intent.class === 'lore' && rawIntent.precedenceLog?.includes('Greeting')) {
            console.log(`[TalaRouter] Greeting opener present, but lore request overrides suppression — retrieval will run`);
        }

        // Update lore timestamp so follow-up carryover works on the next turn
        if (intent.class === 'lore') {
            this.lastLoreQueryTs = Date.now();
        }

        // 3. Retrieval Phase (Conditional)
        let resolved: MemoryItem[] = [];
        let candidateCount = 0;
        let excludedCount = 0;

        if (!retrievalSuppressed) {
            // We query the MemoryService which already implements weighted ranking and association expansion
            // strictly for the requested mode.
            let candidates: MemoryItem[] = await this.memoryService.search(query, 10, mode);

            // 3a. Lore/autobiographical intent — query RAG/LTMF canon lore first.
            //
            //     RAG results are prepended to the candidate list so MemoryFilter sees them,
            //     and the lore-aware sourceRank in resolveContradictions() elevates them over
            //     recent chat snippets regardless of composite score ordering.
            //
            //     Requires ragService to be injected (wired in AgentService).
            if (intent.class === 'lore' && this.ragService) {
                const ragResults = await this.ragService.searchStructured(query, {
                    limit: TalaContextRouter.LORE_PRIMARY_CANDIDATE_LIMIT,
                    // No category filter — fetch top-k canon lore by semantic similarity.
                    // A category filter (e.g. {category:'roleplay'}) can silently reduce
                    // results to 1 when most LTMF documents carry different metadata.
                    // Semantic relevance alone is the correct gate for lore retrieval.
                });
                if (ragResults.length > 0) {
                    console.log(`[TalaRouter] Lore intent — injecting ${ragResults.length} RAG/LTMF candidates`);
                    const now = Date.now();
                    const ragMemoryItems: MemoryItem[] = ragResults.map((r, idx) => {
                        const score = r.score ?? 0.5;
                        return {
                            id: `rag-lore-${idx}-${now}`,
                            text: r.text,
                            metadata: {
                                source: 'rag',
                                role: 'rp',
                                type: 'lore',
                                category: 'roleplay',
                                confidence: score,
                                salience: score,
                                docId: r.docId,
                            },
                            score,
                            compositeScore: score,
                            timestamp: now,
                            salience: score,
                            confidence: score,
                            created_at: now,
                            last_accessed_at: null,
                            last_reinforced_at: null,
                            access_count: 0,
                            associations: [],
                            status: 'active' as const,
                        };
                    });
                    // Audit log each RAG candidate before merging
                    for (const item of ragMemoryItems) {
                        console.log(
                            `[MemoryAudit] source=rag role=rp id=${item.id} score=${item.score?.toFixed(3)} docId=${item.metadata?.docId ?? 'n/a'}`
                        );
                    }
                    // RAG lore items go first; mem0 candidates follow as fallback
                    candidates = [...ragMemoryItems, ...candidates];
                } else {
                    console.log('[TalaRouter] Lore intent — RAG returned no results; mem0/local used as fallback');
                }
            }

            // Log candidate source composition for audit visibility
            if (candidates.length > 0) {
                const sourceSummary = candidates.reduce<Record<string, number>>((acc, c) => {
                    const src = c.metadata?.source ?? 'unknown';
                    acc[src] = (acc[src] ?? 0) + 1;
                    return acc;
                }, {});
                console.log(
                    `[TalaRouter] Candidates before filter — ${Object.entries(sourceSummary).map(([s, n]) => `${s}:${n}`).join(', ')} (total=${candidates.length})`
                );
            }

            candidateCount = candidates.length;

            // 4. Validation & Policy Enforcement
            // No untagged memory may enter (handled by Search/Normalize)
            // Strict exclusion based on mode_scope and status
            const filtered = MemoryFilter.filter(candidates, mode, intent);
            excludedCount = candidateCount - filtered.length;

            // 5. Contradiction Resolution
            resolved = MemoryFilter.resolveContradictions(filtered, intent);

            // 5a. Source-bucket composition for lore intent.
            //
            //     When autobiographical/lore intent is active and canon lore candidates
            //     exist (rag, diary, graph, core_bio, lore), enforce a canon-first approved
            //     set so recent chat/explicit snippets cannot dominate:
            //
            //       primary slots  → up to LORE_PRIMARY_CANDIDATE_LIMIT canon lore items
            //       fallback slots → up to LORE_FALLBACK_CAP explicit/chat items
            //
            //     Fallback behavior is preserved: if no canon candidates exist, the full
            //     resolved set (explicit/chat/mem0) passes through unchanged.
            if (intent.class === 'lore' && resolved.length > 0) {
                const loreSources = TalaContextRouter.LORE_CANON_SOURCES;
                const loreBucket = resolved.filter(m => loreSources.has(m.metadata?.source ?? ''));
                const fallbackBucket = resolved.filter(m => !loreSources.has(m.metadata?.source ?? ''));

                console.log(
                    `[TalaRouter] Lore composition — loreCandidates=${loreBucket.length} explicitCandidates=${fallbackBucket.length} fallbackCap=${TalaContextRouter.LORE_FALLBACK_CAP}`
                );

                if (loreBucket.length > 0) {
                    const primary = loreBucket.slice(0, TalaContextRouter.LORE_PRIMARY_CANDIDATE_LIMIT);
                    const fallback = fallbackBucket.slice(0, TalaContextRouter.LORE_FALLBACK_CAP);
                    const suppressed = fallbackBucket.length - fallback.length;
                    if (suppressed > 0) {
                        console.log(`[TalaRouter] Suppressed explicit/chat candidates for canon-first composition: ${suppressed}`);
                    }
                    resolved = [...primary, ...fallback];
                }
                // else: no canon lore — fallback bucket passes through unchanged (all resolved items kept)
            }

            // Log final approved source composition
            if (resolved.length > 0) {
                const approvedSummary = resolved.reduce<Record<string, number>>((acc, c) => {
                    const src = c.metadata?.source ?? 'unknown';
                    acc[src] = (acc[src] ?? 0) + 1;
                    return acc;
                }, {});
                console.log(
                    `[TalaRouter] Approved memories — ${Object.entries(approvedSummary).map(([s, n]) => `${s}:${n}`).join(', ')} (total=${resolved.length})`
                );
            }
        } else {
            console.log(`[TalaRouter] Retrieval bypassed — ${intent.class} intent (no lore/substantive override).`);
        }

        // 6. Documentation Retrieval Phase (NEW)
        let docContext = '';
        const DOC_RELEVANCE_PATTERN = /\b(architecture|design|interface|spec|protocol|how does|explain|docs|documentation|logic|engine|service|requirement|traceability|security)\b/i;
        if (docIntel && DOC_RELEVANCE_PATTERN.test(query) && mode !== 'rp') {
            console.log(`[TalaRouter] Turn identified as documentation-relevant. Requesting doc context...`);
            docContext = docIntel.getRelevantContext(query);
        }

        // 7. Assembly & Handoff
        // Pass retrievalSuppressed flag to tell assembler not to emit a fallback block when retrieval was intentionally gated.
        const promptBlocks = ContextAssembler.assemble(resolved, mode, intent.class, retrievalSuppressed, docContext).blocks;
        const fallbackUsed = promptBlocks.some((b: import('./ContextAssembler').ContextBlock) => b.header.includes('FALLBACK CONTRACT'));

        // 8. Capability Resolution (done here so TurnContext is self-contained)
        const blockedCapabilities: string[] = [];
        const allowedCapabilities: string[] = [];

        if (mode === 'rp') {
            // RP mode: block tool execution but explicitly allow memory retrieval reads.
            // Memory writes remain blocked (enforced separately by memoryWriteDecision).
            // This keeps RP operationally isolated while allowing autobiographical grounding.
            blockedCapabilities.push('tools');
            allowedCapabilities.push('memory_retrieval');
            console.log(`[TalaRouter] RP mode policy — tools=false, memoryReads=true, memoryWrites=false`);
        } else if (retrievalSuppressed) {
            // Greeting suppression: block only memory retrieval tools
            blockedCapabilities.push('memory_retrieval');
        } else {
            allowedCapabilities.push('all');
        }

        // 9. Memory Write Policy
        const memoryWriteDecision = this.resolveMemoryWritePolicy(mode, intent.class, isGreetingOnly);

        console.log(`[TalaRouter] Routing complete. Approved memories: ${resolved.length}/${candidateCount}`);
        console.log(`[TalaRouter] Capabilities — allowed=${JSON.stringify(allowedCapabilities)} blocked=${JSON.stringify(blockedCapabilities)}`);
        console.log(`[TalaRouter] Memory write policy: ${memoryWriteDecision.category} — ${memoryWriteDecision.reason}`);

        const context: TurnContext = {
            turnId,
            resolvedMode: mode,
            rawInput: query,
            normalizedInput: query.toLowerCase().trim(),
            intent: {
                class: intent.class,
                confidence: intent.confidence || 0.9,
                isGreeting: isGreetingOnly
            },
            retrieval: {
                suppressed: retrievalSuppressed,
                approvedCount: resolved.length,
                excludedCount: excludedCount
            },
            promptBlocks,
            fallbackUsed,
            allowedCapabilities: allowedCapabilities as any,
            blockedCapabilities: blockedCapabilities as any,
            persistedMode: mode,
            selectedTools: [],
            artifactDecision: null,
            memoryWriteDecision,
            auditMetadata: {
                turnStartedAt,
                turnCompletedAt: null,
                mcpServicesUsed: [],
                correlationId
            },
            errorState: null,
            resolvedMemories: resolved,
        };

        // Emit structured routing telemetry
        auditLogger.info('turn_routed', 'TalaContextRouter', {
            turnId,
            mode,
            intent: intent.class,
            retrievalSuppressed,
            approvedMemories: resolved.length,
            excludedMemories: excludedCount,
            fallbackUsed,
            allowedCapabilities,
            blockedCapabilities,
            memoryWriteCategory: memoryWriteDecision.category,
            correlationId
        });

        return context;
    }

    /**
     * Resolves the memory write policy for this turn based on mode and intent.
     *
     * Rules:
     * - RP mode → do_not_write (RP isolation must not pollute memory)
     * - Greeting intent → do_not_write (no content worth persisting)
     * - Hybrid mode → short_term (moderate persistence)
     * - Assistant mode with task/technical intent → long_term
     * - Assistant mode otherwise → short_term
     */
    private resolveMemoryWritePolicy(mode: Mode, intentClass: string, isGreeting: boolean): MemoryWriteDecision {
        if (mode === 'rp') {
            return { category: 'do_not_write', reason: 'RP mode isolation prohibits memory writes', executed: false };
        }
        if (isGreeting || intentClass === 'greeting') {
            return { category: 'do_not_write', reason: 'Greeting turns carry no persistent content', executed: false };
        }
        if (mode === 'hybrid') {
            return { category: 'short_term', reason: 'Hybrid mode uses short-term persistence by default', executed: false };
        }
        if (mode === 'assistant') {
            if (['technical', 'coding', 'planning', 'task_state'].includes(intentClass)) {
                return { category: 'long_term', reason: `Technical/${intentClass} intent warrants long-term retention`, executed: false };
            }
            return { category: 'short_term', reason: 'Assistant mode default: short-term retention', executed: false };
        }
        return { category: 'short_term', reason: 'Default write policy', executed: false };
    }
}
