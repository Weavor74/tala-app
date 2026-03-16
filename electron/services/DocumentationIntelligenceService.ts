import { DocumentationIndexer } from './DocumentationIndexer';
import { DocumentationRetriever, RetrievalResult } from './DocumentationRetriever';
import { telemetry } from './TelemetryService';

// ─── Gating policy ────────────────────────────────────────────────────────────

/**
 * Doc retrieval is only triggered when the query matches one of these semantic
 * patterns. Retrieval does NOT run on every turn — only when it will materially
 * improve accuracy or diagnostics.
 *
 * Use cases:
 * - Explaining subsystem or service behavior
 * - Diagnosing architecture-level issues
 * - Resolving where a capability is implemented
 * - Identifying expected contracts between services
 * - Clarifying intended mode / artifact / memory semantics
 */
const DOC_RETRIEVAL_PATTERN =
    /\b(architecture|design|interface|spec|protocol|how does|explain|docs?|documentation|logic|engine|service|requirement|traceability|security|contract|schema|api|workflow|pipeline|subsystem|capability|memory|artifact|mode|reflection|telemetry|inference|audit)\b/i;

// ─── Structured retrieval result ──────────────────────────────────────────────

/**
 * A single attributed documentation citation returned by the retrieval pipeline.
 * Source attribution is always preserved for diagnostic and developer use.
 */
export interface DocCitation {
    /** Relative path of the source document within the repo. */
    sourcePath: string;
    /** Heading within the document (for section-level attribution). */
    heading: string;
    /** Relevance score used for ranking (higher = more relevant). */
    score: number;
    /** The retrieved text content (trimmed, not the full document). */
    content: string;
}

/**
 * Structured result from a documentation retrieval call.
 * Carries attribution, gating metadata, and a prompt-ready context block.
 */
export interface DocRetrievalResult {
    /** Whether retrieval was executed (false = gating suppressed it). */
    retrieved: boolean;
    /** Reason retrieval was suppressed, when retrieved=false. */
    suppressReason?: string;
    /** Gating rule label that matched (for telemetry). */
    gatingRuleMatched?: string;
    /** Ordered list of cited sources (highest score first). */
    citations: DocCitation[];
    /** Pre-formatted context block ready for LLM prompt injection. */
    promptContext: string;
    /** Duration of the retrieval operation in ms. */
    durationMs: number;
}

// ─── DocumentationIntelligenceService ────────────────────────────────────────

/**
 * DocumentationIntelligenceService - Knowledge Orchestrator
 *
 * Phase 2 enhancements:
 * - Gating policy: retrieval only executes when query matches known use cases.
 * - Structured citation model with source attribution.
 * - Telemetry emission for retrieval, suppression, and failures.
 * - Runtime interface for other services to call intentionally.
 *
 * The service provides the primary interface for TALA to access project-level
 * documentation. It manages the lifecycle of the documentation index
 * (loading/rebuilding) and provides high-level context retrieval methods
 * for the agentic loop.
 */
export class DocumentationIntelligenceService {
    private indexer: DocumentationIndexer;
    private retriever: DocumentationRetriever | null = null;

    constructor(baseDir: string) {
        this.indexer = new DocumentationIndexer(baseDir);
    }

    /**
     * Initializes the service by loading or rebuilding the documentation index.
     *
     * **Flow:**
     * - Attempts to load an existing index from disk (`data/docs_index/docs.json`).
     * - If no index is found, triggers a full rebuild (crawl/classify/chunk).
     * - Instantiates the `DocumentationRetriever` with the loaded index.
     */
    public async ignite(): Promise<void> {
        console.log('[DocIntel] Igniting Documentation Intelligence Service...');
        let index = this.indexer.load();

        if (!index) {
            console.log('[DocIntel] No index found. Performing initial build...');
            index = await this.indexer.rebuild();
        }

        this.retriever = new DocumentationRetriever(index);
        console.log('[DocIntel] Service ready.');
    }

    /**
     * Rebuilds the documentation index on-demand.
     */
    public async refresh(): Promise<void> {
        const index = await this.indexer.rebuild();
        this.retriever = new DocumentationRetriever(index);
    }

    // ------------------------------------------------------------------
    // Gating check (public for testing)
    // ------------------------------------------------------------------

    /**
     * Evaluates the gating policy for a query.
     * Returns whether retrieval should proceed and the rule label that matched.
     */
    public evaluateGating(query: string): { allowed: boolean; ruleLabel: string } {
        const match = DOC_RETRIEVAL_PATTERN.exec(query);
        if (match) {
            return { allowed: true, ruleLabel: `keyword:${match[0].toLowerCase()}` };
        }
        return { allowed: false, ruleLabel: 'no_match' };
    }

    // ------------------------------------------------------------------
    // Structured retrieval (Phase 2 primary API)
    // ------------------------------------------------------------------

    /**
     * Runtime-safe documentation retrieval with gating policy, source attribution,
     * and structured telemetry.
     *
     * - Does NOT run on every turn; gating policy is enforced here.
     * - Results are ranked by score and attributed to source documents.
     * - Emits telemetry for retrieval, suppression, and failure states.
     *
     * @param query - The user query or intent string used for retrieval.
     * @param turnId - The current turn ID for telemetry correlation.
     * @param mode - The current operating mode.
     * @param maxResults - Maximum number of citations to return (default: 3).
     * @returns A structured DocRetrievalResult.
     */
    public queryWithGating(
        query: string,
        turnId = 'global',
        mode = 'unknown',
        maxResults = 3
    ): DocRetrievalResult {
        const startMs = Date.now();

        telemetry.debug(
            'docs_intel',
            'doc_retrieval_started',
            'DocumentationIntelligenceService',
            `Doc retrieval started for turn ${turnId}`,
            { turnId, mode }
        );

        // Gating policy check
        const { allowed, ruleLabel } = this.evaluateGating(query);

        if (!allowed) {
            const durationMs = Date.now() - startMs;

            telemetry.debug(
                'docs_intel',
                'doc_retrieval_suppressed',
                'DocumentationIntelligenceService',
                `Doc retrieval suppressed — gating policy: ${ruleLabel}`,
                {
                    turnId,
                    mode,
                    payload: {
                        suppressReason: 'gating_policy',
                        gatingRuleMatched: ruleLabel,
                        durationMs,
                        resultCount: 0,
                    },
                }
            );

            return {
                retrieved: false,
                suppressReason: 'gating_policy',
                gatingRuleMatched: ruleLabel,
                citations: [],
                promptContext: '',
                durationMs,
            };
        }

        if (!this.retriever) {
            const durationMs = Date.now() - startMs;

            telemetry.operational(
                'docs_intel',
                'doc_retrieval_failed',
                'warn',
                'DocumentationIntelligenceService',
                'Doc retrieval failed — retriever not initialized',
                'failure',
                { turnId, mode, payload: { suppressReason: 'not_initialized', durationMs } }
            );

            return {
                retrieved: false,
                suppressReason: 'not_initialized',
                citations: [],
                promptContext: '',
                durationMs,
            };
        }

        const rawResults: RetrievalResult[] = this.retriever.search(query, maxResults);
        const durationMs = Date.now() - startMs;

        if (rawResults.length === 0) {
            telemetry.debug(
                'docs_intel',
                'doc_retrieval_suppressed',
                'DocumentationIntelligenceService',
                `Doc retrieval returned no results for rule: ${ruleLabel}`,
                {
                    turnId,
                    mode,
                    payload: { suppressReason: 'no_results', gatingRuleMatched: ruleLabel, durationMs },
                }
            );

            return {
                retrieved: false,
                suppressReason: 'no_results',
                gatingRuleMatched: ruleLabel,
                citations: [],
                promptContext: '',
                durationMs,
            };
        }

        // Build structured citations with attribution
        const citations: DocCitation[] = rawResults.map(r => ({
            sourcePath: r.chunk.filePath,
            heading: r.chunk.heading,
            score: r.score,
            content: r.chunk.content,
        }));

        const sources = citations.map(c => c.sourcePath);
        const topScore = citations[0]?.score ?? 0;

        telemetry.audit(
            'docs_intel',
            'doc_retrieval_completed',
            'DocumentationIntelligenceService',
            `Doc retrieval completed: ${citations.length} results in ${durationMs}ms`,
            'success',
            {
                turnId,
                mode,
                payload: {
                    resultCount: citations.length,
                    topScore,
                    sources,
                    gatingRuleMatched: ruleLabel,
                    durationMs,
                },
            }
        );

        return {
            retrieved: true,
            gatingRuleMatched: ruleLabel,
            citations,
            promptContext: this.buildPromptContext(citations),
            durationMs,
        };
    }

    // ------------------------------------------------------------------
    // Legacy context helper (preserved for backward compatibility)
    // ------------------------------------------------------------------

    /**
     * Retrieves relevant documentation context formatted for LLM prompts.
     *
     * @deprecated Prefer `queryWithGating()` which enforces the gating policy
     * and emits structured telemetry. This method is preserved for backward
     * compatibility but bypasses the gating policy.
     *
     * @param query - The user query or intent string.
     * @returns A string of documentation context blocks, or an empty string.
     */
    public getRelevantContext(query: string): string {
        if (!this.retriever) {
            console.warn('[DocIntel] Retriever not initialized.');
            return '';
        }

        const results = this.retriever.search(query, 3);
        if (results.length === 0) return '';

        const citations: DocCitation[] = results.map(r => ({
            sourcePath: r.chunk.filePath,
            heading: r.chunk.heading,
            score: r.score,
            content: r.chunk.content,
        }));

        return this.buildPromptContext(citations);
    }

    /**
     * Diagnostic method to inspect the current index status.
     */
    public getStatus(): { indexedDocs: number; generatedAt?: string } {
        const index = this.indexer.load();
        return {
            indexedDocs: index?.documents.length || 0,
            generatedAt: index?.generatedAt
        };
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    private buildPromptContext(citations: DocCitation[]): string {
        const contextBlocks = citations.map(c =>
            `[DOCUMENTATION: ${c.sourcePath}]\n${c.content}`
        );
        return `[PROJECT DOCUMENTATION CONTEXT]\n${contextBlocks.join('\n\n')}`;
    }
}
