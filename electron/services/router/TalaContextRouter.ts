import { MemoryService, MemoryItem } from '../MemoryService';
import { Mode, ModePolicyEngine, type TurnPolicyId } from './ModePolicyEngine';
import { IntentClassifier, Intent } from './IntentClassifier';
import { MemoryFilter } from './MemoryFilter';
import { ContextAssembler, TurnContext, MemoryWriteDecision, MemoryWriteCategory, ResponseMode, TurnPolicyState, TurnBehaviorState } from './ContextAssembler';
import { DocumentationIntelligenceService } from '../DocumentationIntelligenceService';
import { RagService } from '../RagService';
import { auditLogger } from '../AuditLogger';
import { v4 as uuidv4 } from 'uuid';

interface LoreMemorySnapshot {
    id: string;
    text: string;
    source: string;
    docId?: string;
    title?: string;
    score?: number;
    confidence?: number;
    metadata?: Record<string, unknown>;
}

export interface ActiveLoreMemoryContext {
    originatingTurnId: string;
    responseMode: ResponseMode;
    approvedMemoryIds: string[];
    approvedDocIds: string[];
    memoryLabels: string[];
    anchorEntities: string[];
    ageHint?: number;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    ttlMs: number;
    continuationTurns: number;
    consecutiveContinuationMisses: number;
    memories: LoreMemorySnapshot[];
}

interface LoreContinuationDecision {
    shouldContinue: boolean;
    confidence: number;
    matchedEntities: string[];
    reason: string;
}

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
    /** Optional RAG service â€” injected so lore turns can query LTMF/canon lore first. */
    private ragService?: RagService;

    /**
     * How long (ms) after a lore turn that a follow-up underspecified query
     * inherits the autobiographical retrieval domain.
     */
    private static readonly LORE_CARRYOVER_MS = 5 * 60 * 1000;
    private static readonly LORE_THREAD_TTL_MS = 8 * 60 * 1000;
    private static readonly LORE_THREAD_MAX_MISSES = 2;

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
    private static readonly AUTOBIO_ALLOWED_CANON_SOURCE_TYPES = new Set([
        'ltmf',
        'diary',
        'graph',
        'core_bio',
        'lore',
        'autobiographical_diary',
        'verified_lore',
        'verified_lore_file',
        'lore_file',
        'canon_lore',
    ]);
    private static readonly AUTOBIO_ALLOWED_MEMORY_TYPES = new Set([
        'autobiographical',
        'autobio',
        'diary',
        'lore',
        'canon_lore',
    ]);
    private static readonly INTERACTION_TRANSCRIPT_SOURCE_TYPES = new Set([
        'interaction',
        'interaction_log',
        'interaction_transcript',
        'conversation',
        'conversation_log',
        'chat',
        'chat_log',
        'transcript',
    ]);
    private static readonly INTERACTION_TRANSCRIPT_MEMORY_TYPES = new Set([
        'interaction',
        'interaction_log',
        'interaction_transcript',
        'conversation',
        'conversation_log',
        'chat',
        'chat_history',
        'assistant_reply',
        'assistant_response',
        'user_message',
        'session',
    ]);

    /**
     * Minimum number of high-confidence canon memories required before
     * autobiographical recall is allowed.
     */
    private static readonly AUTOBIO_MIN_CANON_APPROVED_COUNT = 2;

    /** Minimum semantic score required for autobiographical memory use. */
    private static readonly AUTOBIO_MIN_SEMANTIC_SCORE = 0.55;

    /** Minimum confidence score required for autobiographical memory use. */
    private static readonly AUTOBIO_MIN_CONFIDENCE_SCORE = 0.65;

    /**
     * Patterns that indicate a short follow-up query referencing a prior lore turn.
     * These are matched in addition to IntentClassifier to handle underspecified
     * replies like "you don't remember?" that may not fire the main lore patterns.
     */
    private static readonly LORE_FOLLOWUP_PATTERNS = [
        /\b(so\s+you\s+(don'?t|do\s+not)|you\s+(don'?t|do\s+not))\s+(have|remember|recall|know)/i,
        /\b(what\s+about\s+(that|then|it)|and\s+that|but\s+that)\b/i,
        /\bwhat\s+about\b/i,
        /\b(what\s+happened\s+next|tell\s+me\s+more|after\s+that|before\s+that)\b/i,
        /\b(personal\s+story\s+about\s+it|do\s+you\s+remember\s+that)\b/i,
    ];

    private static readonly LORE_THREAD_PRONOUN_FOLLOWUP_PATTERNS = [
        /\b(that|it|this|those)\b/i,
        /\b(what\s+about|after\s+that|before\s+that|next|then)\b/i,
    ];

    private static readonly LORE_THREAD_TOPIC_SHIFT_PATTERNS = [
        /\b(code|coding|file|terminal|tool|tools|browser|website|http|https|install|npm|python|typescript|debug|stack trace|unit test|run test)\b/i,
        /\b(open|launch|navigate|search|click|build|compile|deploy)\b/i,
    ];

    /**
     * Patterns that identify a query as a first-person autobiographical memory request â€”
     * specifically asking for Tala's own lived experiences, not general worldbuilding lore.
     *
     * These are a narrow subset of LORE_PATTERNS that signal the user wants Tala to
     * recall events from her own personal timeline (age references, childhood, past events).
     * Only evaluated when intent=lore is already established.
     */
    private static readonly AUTOBIO_LORE_PATTERNS = [
        // Explicit event-happened-to-you framing
        /\b(something|what|an?\s+event|a\s+time)\s+(that\s+)?happened\s+to\s+you\b/i,
        // Life-stage / age references: "when you were 17", "when you were young/a child"
        /\bwhen\s+you\s+were\s+(\d+|young|little|small|a\s+(child|kid|teen(ager)?))\b/i,
        // Imperfect shorthand variants: "when u were 17", "when ur 17", "when your 17", "when you're 17"
        /\bwhen\s+(?:u|ur|your|you'?re|you)\s+(?:were\s+)?(\d+|young|little|small|a\s+(child|kid|teen(ager)?))\b/i,
        // "at age [N]" or "at [N] years old"
        /\bat\s+(age\s+)?\d+(\s+years?\s*old)?\b/i,
        // "at seventeen" / "at fifteen"
        /\bat\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i,
        // "during your seventeenth year"
        /\bduring\s+your\s+([a-z-]+|\d{1,2}(st|nd|rd|th))\s+year\b/i,
        // "your 17" / "you're 17" / "ur 17" in autobiographical framing
        /\b(?:your|you'?re|ur)\s+\d{1,2}\b/i,
        // Personal life-period phrases
        /\b(your\s+(childhood|upbringing|early\s+life|younger\s+years?)|growing\s+up|back\s+when\s+you\s+were)\b/i,
        // "your past" / "your personal history" / "your life story"
        /\byour\s+(past|personal\s+history|life\s+story)\b/i,
        // First-person memory recall requests ("do you remember", "can you remember")
        /\b(do|can|could)\s+you\s+(remember|recall)\b/i,
        // "tell me about your [past/childhood/memories/experience]" or "a time when you"
        /\btell\s+(me\s+)?about\s+(your\s+(past|childhood|early|memory|memories?|life\s+story|experience)|something\s+that\s+happened\s+to\s+you|a\s+time\s+when\s+you)\b/i,
        // "what happened to you when"
        /\bwhat\s+happened\s+to\s+you\s+when\b/i,
    ];

    private static readonly AGE_CARDINAL_WORDS: Record<string, number> = {
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
        eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
        eighteen: 18, nineteen: 19, twenty: 20,
    };

    private static readonly AGE_ORDINAL_WORDS: Record<string, number> = {
        first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
        eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
        eighteenth: 18, nineteenth: 19, twentieth: 20,
    };

    private static readonly AUTOBIO_STANDALONE_AGE_MIN = 8;
    private static readonly AUTOBIO_STANDALONE_AGE_MAX = 33;
    private static readonly FACTUAL_QUERY_PATTERNS = [
        /^\s*(what|who|when|where|which|explain|define|summarize|compare|why)\b/i,
        /\b(what\s+is|how\s+does|explain|difference between|vs\.?)\b/i,
    ];

    /** Timestamp of the most recent lore-classified turn (for carryover logic). */
    private lastLoreQueryTs: number = 0;
    private activeLoreMemoryContext: ActiveLoreMemoryContext | null = null;

    constructor(memoryService: MemoryService, ragService?: RagService) {
        this.memoryService = memoryService;
        this.ragService = ragService;
    }

    public getActiveLoreMemoryContext(): ActiveLoreMemoryContext | null {
        if (!this.activeLoreMemoryContext) return null;
        return JSON.parse(JSON.stringify(this.activeLoreMemoryContext));
    }

    public setActiveLoreMemoryContext(ctx: ActiveLoreMemoryContext | null): void {
        this.activeLoreMemoryContext = ctx ? JSON.parse(JSON.stringify(ctx)) : null;
    }

    private hasLiveLoreThread(now: number): boolean {
        return !!this.activeLoreMemoryContext && now <= this.activeLoreMemoryContext.expiresAt;
    }

    private clearLoreThread(reason: string): void {
        if (this.activeLoreMemoryContext) {
            console.log(
                `[TalaRouter] Lore thread expired/cleared reason=${reason} originTurn=${this.activeLoreMemoryContext.originatingTurnId}`
            );
        }
        this.activeLoreMemoryContext = null;
    }

    private static normalizeEntityText(value: string): string {
        return value
            .toLowerCase()
            .replace(/[_\-]+/g, ' ')
            .replace(/[^a-z0-9\s']/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    private static memoryTitleFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
        if (!metadata) return undefined;
        const directCandidates = [
            metadata.title,
            metadata.memory_title,
            metadata.canonical_name,
            metadata.event_name,
            metadata.theme_anchor,
        ];
        for (const item of directCandidates) {
            if (typeof item === 'string' && item.trim().length > 0) return item.trim();
        }
        const eventIdentity = metadata.event_identity as Record<string, unknown> | undefined;
        if (eventIdentity && typeof eventIdentity.canonical_name === 'string' && eventIdentity.canonical_name.trim().length > 0) {
            return eventIdentity.canonical_name.trim();
        }
        return undefined;
    }

    private static extractAnchorEntitiesFromMemories(memories: MemoryItem[]): string[] {
        const stop = new Set([
            'the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'were', 'your', 'about', 'have', 'into', 'then',
            'they', 'them', 'there', 'what', 'where', 'which', 'while', 'because', 'after', 'before', 'story', 'memory',
            'remember', 'recall', 'tala', 'personal', 'event', 'canon', 'lore',
        ]);

        const scored = new Map<string, number>();
        const boost = (phrase: string, score: number) => {
            const normalized = TalaContextRouter.normalizeEntityText(phrase);
            if (!normalized || normalized.length < 4) return;
            const wordCount = normalized.split(' ').filter(Boolean).length;
            if (wordCount > 4) return;
            if (wordCount === 1 && stop.has(normalized)) return;
            scored.set(normalized, Math.max(scored.get(normalized) ?? 0, score));
        };

        for (const memory of memories) {
            const metadata = memory.metadata as Record<string, unknown> | undefined;
            const title = TalaContextRouter.memoryTitleFromMetadata(metadata);
            if (title) boost(title, 1);

            const docId = typeof metadata?.docId === 'string' ? metadata.docId : undefined;
            if (docId) {
                const stem = docId.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '');
                boost(stem, 0.95);
            }

            const text = TalaContextRouter.normalizeEntityText(memory.text || '');
            const words = text.split(/\s+/).filter(w => w.length >= 3 && !stop.has(w));
            for (let i = 0; i < words.length; i++) {
                const bigram = `${words[i]} ${words[i + 1] || ''}`.trim();
                const trigram = `${words[i]} ${words[i + 1] || ''} ${words[i + 2] || ''}`.trim();
                if (words[i + 1]) boost(bigram, 0.75);
                if (words[i + 2]) boost(trigram, 0.8);
            }
        }

        return [...scored.entries()]
            .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
            .map(([phrase]) => phrase)
            .slice(0, 16);
    }

    private static toLoreMemorySnapshot(memory: MemoryItem): LoreMemorySnapshot {
        const metadata = (memory.metadata && typeof memory.metadata === 'object')
            ? { ...(memory.metadata as Record<string, unknown>) }
            : {};
        const title = TalaContextRouter.memoryTitleFromMetadata(metadata);
        return {
            id: memory.id,
            text: memory.text,
            source: typeof metadata.source === 'string' ? metadata.source : 'unknown',
            docId: typeof metadata.docId === 'string' ? metadata.docId : undefined,
            title,
            score: typeof memory.score === 'number' ? memory.score : undefined,
            confidence: typeof memory.confidence === 'number' ? memory.confidence : undefined,
            metadata,
        };
    }

    private static snapshotToMemoryItem(snapshot: LoreMemorySnapshot): MemoryItem {
        const now = Date.now();
        const score = snapshot.score ?? 0.8;
        const confidence = snapshot.confidence ?? 0.8;
        return {
            id: snapshot.id,
            text: snapshot.text,
            metadata: { ...(snapshot.metadata || {}), source: snapshot.source, docId: snapshot.docId, title: snapshot.title },
            score,
            compositeScore: score,
            timestamp: now,
            salience: score,
            confidence,
            created_at: now,
            last_accessed_at: null,
            last_reinforced_at: null,
            access_count: 0,
            associations: [],
            status: 'active',
        };
    }

    private evaluateLoreContinuationDecision(
        query: string,
        rawIntent: Intent,
        now: number,
    ): LoreContinuationDecision {
        if (!this.hasLiveLoreThread(now)) {
            return { shouldContinue: false, confidence: 0, matchedEntities: [], reason: 'no_active_thread' };
        }
        if (TalaContextRouter.LORE_THREAD_TOPIC_SHIFT_PATTERNS.some(p => p.test(query)) || ['technical', 'coding', 'action', 'browser'].includes(rawIntent.class)) {
            this.clearLoreThread('explicit_topic_shift');
            return { shouldContinue: false, confidence: 0, matchedEntities: [], reason: 'explicit_topic_shift' };
        }

        const normalized = TalaContextRouter.normalizeEntityText(query);
        const active = this.activeLoreMemoryContext!;
        const matchedEntities = active.anchorEntities.filter(e => e.length > 2 && normalized.includes(e));

        const explicitFollowup = TalaContextRouter.LORE_FOLLOWUP_PATTERNS.some(p => p.test(query));
        const pronounFollowup = TalaContextRouter.LORE_THREAD_PRONOUN_FOLLOWUP_PATTERNS.some(p => p.test(query));
        const shortQuery = normalized.split(/\s+/).filter(Boolean).length <= 10;

        let confidence = 0;
        if (explicitFollowup) confidence += 0.45;
        if (pronounFollowup && shortQuery) confidence += 0.2;
        if (matchedEntities.length > 0) confidence += 0.45;
        if ((now - active.updatedAt) <= 2 * 60 * 1000) confidence += 0.1;
        confidence = Math.min(1, confidence);

        const shouldContinue = confidence >= 0.5;
        return {
            shouldContinue,
            confidence,
            matchedEntities,
            reason: shouldContinue ? 'lore_thread_followup_match' : 'confidence_below_threshold',
        };
    }

    private upsertLoreThreadFromResolved(
        turnId: string,
        responseMode: ResponseMode | undefined,
        resolved: MemoryItem[],
        autobiographicalAgeHint: number | undefined,
        continuationSuccess: boolean,
    ): void {
        const canon = resolved.filter(m => TalaContextRouter.LORE_CANON_SOURCES.has(m.metadata?.source ?? ''));
        if (!responseMode || responseMode !== 'memory_grounded_strict' || canon.length === 0) {
            if (this.activeLoreMemoryContext && continuationSuccess) {
                this.activeLoreMemoryContext.consecutiveContinuationMisses = 0;
                this.activeLoreMemoryContext.updatedAt = Date.now();
            }
            return;
        }

        const now = Date.now();
        const snapshots = canon.slice(0, TalaContextRouter.LORE_PRIMARY_CANDIDATE_LIMIT).map(TalaContextRouter.toLoreMemorySnapshot);
        const approvedMemoryIds = snapshots.map(s => s.id);
        const approvedDocIds = snapshots.map(s => s.docId).filter((v): v is string => !!v);
        const memoryLabels = snapshots
            .map(s => s.title || s.docId || s.id)
            .filter(Boolean)
            .slice(0, 8);
        const anchorEntities = TalaContextRouter.extractAnchorEntitiesFromMemories(canon);

        const prior = this.activeLoreMemoryContext;
        this.activeLoreMemoryContext = {
            originatingTurnId: continuationSuccess && prior ? prior.originatingTurnId : turnId,
            responseMode,
            approvedMemoryIds,
            approvedDocIds,
            memoryLabels,
            anchorEntities,
            ageHint: autobiographicalAgeHint,
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
            expiresAt: now + TalaContextRouter.LORE_THREAD_TTL_MS,
            ttlMs: TalaContextRouter.LORE_THREAD_TTL_MS,
            continuationTurns: continuationSuccess
                ? (prior?.continuationTurns ?? 0) + 1
                : 0,
            consecutiveContinuationMisses: 0,
            memories: snapshots,
        };
    }

    /**
     * Returns true when the query is specifically asking for Tala's own lived experiences â€”
     * first-person autobiographical queries about her personal timeline, childhood, past events,
     * or age-specific life stages.
     *
     * Only called when intent=lore is already established.  Distinct from general worldbuilding
     * lore (universe history, character backgrounds) which does not require autobiographical canon.
     */
    private static isAutobiographicalLoreRequest(query: string): boolean {
        const normalized = TalaContextRouter.normalizeAutobiographicalParseText(query);
        return TalaContextRouter.AUTOBIO_LORE_PATTERNS.some(p => p.test(normalized));
    }

    /**
     * Lightweight normalization for common missing-space autobiographical phrasing.
     * Keeps scope intentionally narrow to avoid broad semantic rewrites.
     */
    private static normalizeAutobiographicalParseText(query: string): string {
        let text = query.toLowerCase();
        const replacements: Array<[RegExp, string]> = [
            // "aboutwhen you were 17" -> "about when you were 17"
            [/\baboutwhen(?=\s|you\b|u\b|your\b|you'?re\b|youre\b)/gi, 'about when'],
            // "tell me aboutwhen" falls out of rule above, but keep boundary-safe variants.
            [/\bbackwhen(?=\s|you\b|u\b|your\b|you'?re\b|youre\b)/gi, 'back when'],
            [/\brememberwhen(?=\s|you\b|u\b|your\b|you'?re\b|youre\b)/gi, 'remember when'],
            [/\brecallwhen(?=\s|you\b|u\b|your\b|you'?re\b|youre\b)/gi, 'recall when'],
            // "whenyou were 17" -> "when you were 17"
            [/\bwhenyou\b/gi, 'when you'],
            [/\bwhenu\b/gi, 'when u'],
            [/\bwhenyour\b/gi, 'when your'],
            [/\bwhenyoure\b/gi, 'when youre'],
        ];
        for (const [pattern, replacement] of replacements) {
            text = text.replace(pattern, replacement);
        }
        return text.replace(/\s{2,}/g, ' ').trim();
    }

    private static normalizePotentialAge(raw: string | undefined): number | undefined {
        if (!raw) return undefined;
        const t = raw.trim().toLowerCase();
        const digitMatch = t.match(/^\d{1,2}$/);
        if (digitMatch) {
            const n = Number(digitMatch[0]);
            return Number.isFinite(n) && n >= 0 && n <= 130 ? n : undefined;
        }
        const ordinalDigitMatch = t.match(/^(\d{1,2})(st|nd|rd|th)$/);
        if (ordinalDigitMatch) {
            const n = Number(ordinalDigitMatch[1]);
            return Number.isFinite(n) && n >= 0 && n <= 130 ? n : undefined;
        }
        if (t in TalaContextRouter.AGE_CARDINAL_WORDS) return TalaContextRouter.AGE_CARDINAL_WORDS[t];
        if (t in TalaContextRouter.AGE_ORDINAL_WORDS) return TalaContextRouter.AGE_ORDINAL_WORDS[t];
        return undefined;
    }

    /**
     * Extracts autobiographical age hints from common user phrasings.
     * Examples:
     * - "when you were 17"
     * - "at 17"
     * - "during your seventeenth year"
     */
    private static extractAutobiographicalAgeHint(query: string): number | undefined {
        const text = TalaContextRouter.normalizeAutobiographicalParseText(query);
        const patterns: RegExp[] = [
            /\bwhen\s+you\s+were\s+(\d{1,2}|[a-z-]+)\b/i,
            /\bwhen\s+(?:u|ur|you're|youre|you)\s+were\s+(\d{1,2}|[a-z-]+)\b/i,
            /\bat\s+(?:age\s+)?(\d{1,2}|[a-z-]+)(?:\s+years?\s*old)?\b/i,
            /\bduring\s+your\s+(\d{1,2}(?:st|nd|rd|th)|[a-z-]+)\s+year\b/i,
            /\b(?:your|you're|youre|ur)\s+(\d{1,2}|[a-z-]+)\b/i,
            /\bwhen\b[\s\S]{0,32}\b(\d{1,2})\b/i,
        ];

        for (const pattern of patterns) {
            const m = text.match(pattern);
            if (!m) continue;
            const age = TalaContextRouter.normalizePotentialAge(m[1]);
            if (age !== undefined) return age;
        }

        const hasAutobioContext = /\b(your|you're|youre|ur|you|u|when|childhood|growing up|past)\b/i.test(text);
        if (hasAutobioContext) {
            const standalone = text.match(/\b(\d{1,2})\b/);
            if (standalone) {
                const n = Number(standalone[1]);
                if (
                    Number.isFinite(n) &&
                    n >= TalaContextRouter.AUTOBIO_STANDALONE_AGE_MIN &&
                    n <= TalaContextRouter.AUTOBIO_STANDALONE_AGE_MAX
                ) {
                    return n;
                }
            }
        }
        return undefined;
    }

    /**
     * Returns true when the resolved memory set contains at least one item from a
     * high-trust autobiographical canon source (diary / graph / core_bio / lore / rag).
     *
     * Fallback sources (explicit, conversation, mem0) alone are NOT sufficient:
     * they are chat snippets or low-confidence fragments that must not be the sole
     * basis for first-person autobiographical fact claims.
     */
    private static hasSufficientCanonMemoryForAutobio(
        resolved: MemoryItem[],
        minRequiredCanonCount: number,
    ): boolean {
        const qualifiedCanonCount = TalaContextRouter.countQualifiedCanonAutobioMemories(resolved);
        return qualifiedCanonCount >= minRequiredCanonCount;
    }

    /**
     * Returns the semantic score used by autobiographical confidence gates.
     */
    private static getAutobioSemanticScore(item: MemoryItem): number {
        const semanticFromMetadata = typeof item.metadata?.semantic_similarity === 'number'
            ? item.metadata.semantic_similarity
            : undefined;
        const raw =
            (typeof item.score === 'number' ? item.score : undefined)
            ?? (typeof item.compositeScore === 'number' ? item.compositeScore : undefined)
            ?? semanticFromMetadata
            ?? 0;
        if (!Number.isFinite(raw)) return 0;
        return Math.max(0, Math.min(1, raw));
    }

    /**
     * Returns the confidence score used by autobiographical confidence gates.
     */
    private static getAutobioConfidenceScore(item: MemoryItem): number {
        if (item.metadata?.structured_autobio_age_match === true) {
            // Structured autobiographical age matches are metadata-exact canon hits.
            // Treat as high-confidence so embedding confidence variance does not
            // incorrectly force canon fallback on valid age recall.
            return 1;
        }
        const raw =
            (typeof item.confidence === 'number' ? item.confidence : undefined)
            ?? (typeof item.metadata?.confidence === 'number' ? item.metadata.confidence : undefined)
            ?? 0;
        if (!Number.isFinite(raw)) return 0;
        return Math.max(0, Math.min(1, raw));
    }

    private static parseNumeric(value: unknown): number | undefined {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim().length > 0) {
            const n = Number(value);
            if (Number.isFinite(n)) return n;
        }
        return undefined;
    }

    private static parseBoolean(value: unknown): boolean | undefined {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            if (v === 'true' || v === '1' || v === 'yes') return true;
            if (v === 'false' || v === '0' || v === 'no') return false;
        }
        return undefined;
    }

    private static normalizeMetadataToken(value: unknown): string {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
    }

    private static isInteractionTranscriptCandidate(item: MemoryItem): boolean {
        const metadata = (item.metadata && typeof item.metadata === 'object')
            ? item.metadata as Record<string, unknown>
            : {};
        const source = TalaContextRouter.normalizeMetadataToken(metadata.source);
        const sourceType = TalaContextRouter.normalizeMetadataToken(metadata.source_type);
        const memoryType = TalaContextRouter.normalizeMetadataToken(metadata.memory_type);
        const role = TalaContextRouter.normalizeMetadataToken(metadata.role);

        if (source === 'conversation' || source === 'chat' || source === 'mem0' || source === 'explicit') return true;
        if (sourceType && TalaContextRouter.INTERACTION_TRANSCRIPT_SOURCE_TYPES.has(sourceType)) return true;
        if (memoryType && TalaContextRouter.INTERACTION_TRANSCRIPT_MEMORY_TYPES.has(memoryType)) return true;
        if (role === 'assistant' || role === 'user') return true;

        const text = (item.text || '').toLowerCase();
        if ((/^user:\s+/i.test(text) || /^tala:\s+/i.test(text)) && /(?:\n|$)/.test(text)) return true;
        return false;
    }

    private static isApprovedAutobioCanonCandidate(item: MemoryItem): boolean {
        const metadata = (item.metadata && typeof item.metadata === 'object')
            ? item.metadata as Record<string, unknown>
            : {};
        const source = TalaContextRouter.normalizeMetadataToken(metadata.source);
        const sourceType = TalaContextRouter.normalizeMetadataToken(metadata.source_type);
        const memoryType = TalaContextRouter.normalizeMetadataToken(metadata.memory_type);
        const canon = TalaContextRouter.parseBoolean(metadata.canon);

        if (!TalaContextRouter.LORE_CANON_SOURCES.has(source)) return false;
        if (TalaContextRouter.isInteractionTranscriptCandidate(item)) return false;

        // Strictest checks for RAG-injected lore files.
        if (source === 'rag') {
            if (sourceType && !TalaContextRouter.AUTOBIO_ALLOWED_CANON_SOURCE_TYPES.has(sourceType)) return false;
            if (memoryType && !TalaContextRouter.AUTOBIO_ALLOWED_MEMORY_TYPES.has(memoryType)) return false;
            if (canon === false) return false;
            return true;
        }

        // Trusted internal canon stores (diary/graph/core_bio/lore) remain valid even
        // when source_type/memory_type metadata is absent, as long as they are not transcript-like.
        if (sourceType && !TalaContextRouter.AUTOBIO_ALLOWED_CANON_SOURCE_TYPES.has(sourceType)) return false;
        if (memoryType && !TalaContextRouter.AUTOBIO_ALLOWED_MEMORY_TYPES.has(memoryType)) return false;
        if (canon === false) return false;

        return true;
    }

    /**
     * True only for structured age-query canon matches:
     * age + source_type=ltmf + memory_type=autobiographical + canon=true.
     *
     * This override is intentionally narrow so generic lore retrieval remains
     * gated by semantic/confidence thresholds.
     */
    private static isStructuredAutobioCanonAgeMatch(
        metadata: Record<string, unknown> | undefined,
        autobiographicalAgeHint: number | undefined,
    ): boolean {
        if (autobiographicalAgeHint === undefined || !metadata) return false;
        const age = TalaContextRouter.parseNumeric(metadata.age);
        const sourceType = typeof metadata.source_type === 'string' ? metadata.source_type.toLowerCase() : '';
        const memoryType = typeof metadata.memory_type === 'string' ? metadata.memory_type.toLowerCase() : '';
        const canon = TalaContextRouter.parseBoolean(metadata.canon);
        return (
            age === autobiographicalAgeHint &&
            sourceType === 'ltmf' &&
            memoryType === 'autobiographical' &&
            canon === true
        );
    }

    /**
     * True only for canon memories that pass both semantic and confidence gates.
     */
    private static isQualifiedCanonAutobioMemory(item: MemoryItem): boolean {
        const source = item.metadata?.source ?? '';
        if (!TalaContextRouter.LORE_CANON_SOURCES.has(source)) return false;
        if (item.metadata?.structured_autobio_age_match === true) return true;
        const semantic = TalaContextRouter.getAutobioSemanticScore(item);
        const confidence = TalaContextRouter.getAutobioConfidenceScore(item);
        return (
            semantic >= TalaContextRouter.AUTOBIO_MIN_SEMANTIC_SCORE &&
            confidence >= TalaContextRouter.AUTOBIO_MIN_CONFIDENCE_SCORE
        );
    }

    /** Count canon autobiographical memories that pass strict confidence gates. */
    private static countQualifiedCanonAutobioMemories(resolved: MemoryItem[]): number {
        return resolved.filter(m => TalaContextRouter.isQualifiedCanonAutobioMemory(m)).length;
    }

    private static hasStructuredAutobioAgeMatch(resolved: MemoryItem[]): boolean {
        return resolved.some(m => m.metadata?.structured_autobio_age_match === true);
    }

    /**
     * The primary entry point for context orchestration.
     *
     * Returns a fully-populated `TurnContext` that carries all routing decisions
     * required for a deterministic, auditable agent turn.
     *
     * @param notebookActive - When true, the agent has an active notebook context.
     *   This forces `responseMode = 'memory_grounded_strict'` and activates the
     *   notebook grounding path in `ContextAssembler.assemble()` regardless of intent
     *   classification or user phrasing.
     */
    public async process(
        turnId: string,
        query: string,
        mode: Mode,
        docIntel?: DocumentationIntelligenceService,
        notebookActive?: boolean,
    ): Promise<TurnContext> {
        const turnStartedAt = Date.now();
        const correlationId = uuidv4();

        console.log(`[TalaRouter] Processing turn ${turnId} in mode=${mode} `);

        // 1. Resolve Mode (Handled by input)
        // 2. Classify Intent
        const rawIntent = IntentClassifier.classify(query);
        const now = Date.now();
        if (this.activeLoreMemoryContext && now > this.activeLoreMemoryContext.expiresAt) {
            this.clearLoreThread('ttl_elapsed');
        }
        const autobioHeuristicMatch = TalaContextRouter.isAutobiographicalLoreRequest(query);
        const continuityDecision = this.evaluateLoreContinuationDecision(query, rawIntent, now);

        // 2a. Lore follow-up carryover: if this turn is underspecified and follows a recent
        //     lore turn, treat it as lore so autobiographical retrieval stays active.
        const isWithinLoreWindow = (Date.now() - this.lastLoreQueryTs) < TalaContextRouter.LORE_CARRYOVER_MS;
        const isLoreFollowUp =
            isWithinLoreWindow &&
            rawIntent.class !== 'lore' &&
            TalaContextRouter.LORE_FOLLOWUP_PATTERNS.some(p => p.test(query));
        const loreThreadFollowUp = continuityDecision.shouldContinue;
        const shouldThreadContinue = rawIntent.class !== 'lore' && loreThreadFollowUp;
        const shouldReuseLoreThread = isLoreFollowUp || loreThreadFollowUp;

        const intent: Intent = (isLoreFollowUp || shouldThreadContinue)
            ? {
                class: 'lore',
                confidence: Math.max(0.75, continuityDecision.confidence),
                subsystem: 'lore',
                precedenceLog: shouldThreadContinue
                    ? `Lore thread continuation (${continuityDecision.reason})`
                    : 'Lore carryover from previous turn (follow-up detected)',
            }
            : (
                rawIntent.class !== 'lore' && autobioHeuristicMatch
                    ? {
                        ...rawIntent,
                        class: 'lore',
                        confidence: Math.max(rawIntent.confidence ?? 0.5, 0.72),
                        subsystem: 'lore',
                        precedenceLog: 'Autobiographical lore heuristic override from query phrasing',
                    }
                    : rawIntent
            );

        if (shouldReuseLoreThread) {
            console.log('[TalaRouter] Lore follow-up detected - carrying over autobiographical retrieval context');
            if (continuityDecision.matchedEntities.length > 0) {
                console.log(
                    `[TalaRouter] Lore thread entity resolution matched anchors=${JSON.stringify(continuityDecision.matchedEntities)} confidence=${continuityDecision.confidence.toFixed(2)}`
                );
            }
        } else if (rawIntent.class !== 'lore' && intent.class === 'lore' && autobioHeuristicMatch) {
            console.log('[TalaRouter] Autobiographical lore heuristic detected - promoting intent to lore');
        }

        const isAutobiographicalLoreRequest =
            intent.class === 'lore' && autobioHeuristicMatch;
        const autobiographicalAgeHint =
            isAutobiographicalLoreRequest ? TalaContextRouter.extractAutobiographicalAgeHint(query) : undefined;
        let memorySystemState = 'unknown';
        let memorySystemDegraded = false;
        if (isAutobiographicalLoreRequest && typeof (this.memoryService as any).getHealthStatus === 'function') {
            try {
                const health = (this.memoryService as any).getHealthStatus?.();
                memorySystemState = health?.state ?? 'unknown';
                memorySystemDegraded =
                    memorySystemState === 'degraded' ||
                    memorySystemState === 'critical' ||
                    memorySystemState === 'disabled';
                if (memorySystemDegraded) {
                    console.log(`[CanonGate] memory subsystem degraded for autobiographical turn state=${memorySystemState}`);
                }
            } catch {
                console.warn('[CanonGate] failed to read memory health status; treating as unknown');
            }
        }

        const isGreetingOnly = intent.class === 'greeting';
        const policyId = this.resolveTurnPolicyId(mode, intent.class, isGreetingOnly, query);
        const turnPolicy = this.resolveTurnPolicy(mode, policyId, intent.class, isGreetingOnly);
        const turnBehaviorBaseline = this.createTurnBehaviorBaseline();
        const turnBehavior = this.applyTurnPolicyToBehavior(turnBehaviorBaseline, turnPolicy);
        const retrievalSuppressed = turnPolicy.memoryReadPolicy === 'blocked';

        console.log(`[TalaRouter] Intent: ${intent.class} | Suppressed: ${retrievalSuppressed} | Reason: ${intent.precedenceLog || 'standard'} `);
        console.log(`[TurnPolicy] resolved policy=${turnPolicy.policyId} mode=${mode} intent=${intent.class}`);
        console.log(
            `[TurnPolicy] memoryRead=${turnPolicy.memoryReadPolicy} memoryWrite=${turnPolicy.memoryWritePolicy} personality=${turnPolicy.personalityLevel} astro=${turnPolicy.astroLevel} reflection=${turnPolicy.reflectionLevel}`
        );
        console.log(`[TurnPolicy] tools=profile:${turnPolicy.toolExposureProfile} responseStyle=${turnPolicy.responseStyle}`);
        console.log(
            `[TurnBehavior] baseline personality=${turnBehaviorBaseline.personalityLevel} astro=${turnBehaviorBaseline.astroLevel} reflection=${turnBehaviorBaseline.reflectionLevel} tone=${turnBehaviorBaseline.toneProfile} immersive=${turnBehaviorBaseline.immersiveStyle}`
        );
        console.log(
            `[TurnBehavior] applied policy=${turnPolicy.policyId} personality=${turnBehavior.personalityLevel} astro=${turnBehavior.astroLevel} reflection=${turnBehavior.reflectionLevel} tone=${turnBehavior.toneProfile} immersive=${turnBehavior.immersiveStyle}`
        );
        if (intent.class === 'lore' && rawIntent.precedenceLog?.includes('Greeting')) {
            console.log(`[TalaRouter] Greeting opener present, but lore request overrides suppression â€” retrieval will run`);
        }

        // Update lore timestamp so follow-up carryover works on the next turn
        if (intent.class === 'lore') {
            this.lastLoreQueryTs = Date.now();
        }

        // 3. Retrieval Phase (Conditional)
        let resolved: MemoryItem[] = [];
        let candidateCount = 0;
        let excludedCount = 0;
        const threadCarryoverCandidates: MemoryItem[] =
            shouldReuseLoreThread && this.activeLoreMemoryContext
                ? this.activeLoreMemoryContext.memories.map(TalaContextRouter.snapshotToMemoryItem)
                : [];
        let reusedPriorCanon = false;
        let continuationSucceeded = false;
        let continuationFailed = false;
        const skipFreshRetrievalForContinuation =
            shouldReuseLoreThread &&
            continuityDecision.confidence >= 0.8 &&
            threadCarryoverCandidates.length > 0;

        if (!retrievalSuppressed) {
            // We query the MemoryService which already implements weighted ranking and association expansion
            // strictly for the requested mode.
            let candidates: MemoryItem[] = skipFreshRetrievalForContinuation
                ? []
                : await this.memoryService.search(query, 10, mode);
            if (threadCarryoverCandidates.length > 0) {
                reusedPriorCanon = true;
                candidates = [...threadCarryoverCandidates, ...candidates];
                console.log(
                    `[TalaRouter] Lore thread reuse applied candidates=${threadCarryoverCandidates.length} skipFresh=${skipFreshRetrievalForContinuation}`
                );
            }

            // 3a. Lore/autobiographical intent â€” query RAG/LTMF canon lore first.
            //
            //     RAG results are prepended to the candidate list so MemoryFilter sees them,
            //     and the lore-aware sourceRank in resolveContradictions() elevates them over
            //     recent chat snippets regardless of composite score ordering.
            //
            //     Requires ragService to be injected (wired in AgentService).
            if (intent.class === 'lore' && this.ragService && !skipFreshRetrievalForContinuation) {
                const ragOptions: { limit: number; filter?: Record<string, unknown> } = {
                    limit: TalaContextRouter.LORE_PRIMARY_CANDIDATE_LIMIT,
                };
                if (isAutobiographicalLoreRequest && autobiographicalAgeHint !== undefined) {
                    ragOptions.filter = {
                        age: autobiographicalAgeHint,
                        source_type: 'ltmf',
                        memory_type: 'autobiographical',
                        canon: true,
                    };
                    console.log(
                        `[TalaRouter] Autobiographical age query detected - applying structured canon filter age=${autobiographicalAgeHint}`,
                    );
                }
                let ragResults = await this.ragService.searchStructured(query, ragOptions);
                if (isAutobiographicalLoreRequest && ragResults.length > 0) {
                    const before = ragResults.length;
                    ragResults = ragResults.filter((r) => {
                        const sourceMetadata =
                            r.metadata && typeof r.metadata === 'object'
                                ? r.metadata as Record<string, unknown>
                                : undefined;
                        const structuredAutobioMatch = TalaContextRouter.isStructuredAutobioCanonAgeMatch(
                            sourceMetadata,
                            autobiographicalAgeHint,
                        );
                        if (structuredAutobioMatch) return true;
                        return (r.score ?? 0) >= TalaContextRouter.AUTOBIO_MIN_SEMANTIC_SCORE;
                    });
                    const rejected = before - ragResults.length;
                    if (rejected > 0) {
                        console.log(
                            `[CanonGate] rejected ${rejected} low-semantic RAG autobiographical candidate(s) threshold=${TalaContextRouter.AUTOBIO_MIN_SEMANTIC_SCORE}`,
                        );
                    }
                }

                if (ragResults.length > 0) {
                    console.log(`[TalaRouter] Lore intent â€” injecting ${ragResults.length} RAG/LTMF candidates`);
                    const now = Date.now();
                    const ragMemoryItems: MemoryItem[] = ragResults.map((r, idx) => {
                        const score = r.score ?? 0.5;
                        const sourceMetadata =
                            r.metadata && typeof r.metadata === 'object'
                                ? r.metadata as Record<string, unknown>
                                : {};
                        const rawAge = sourceMetadata.age;
                        const parsedAge =
                            typeof rawAge === 'number'
                                ? rawAge
                                : (typeof rawAge === 'string' ? Number(rawAge) : undefined);
                        const age = Number.isFinite(parsedAge as number) ? Number(parsedAge) : undefined;
                        const structuredAutobioAgeMatch = TalaContextRouter.isStructuredAutobioCanonAgeMatch(
                            sourceMetadata,
                            autobiographicalAgeHint,
                        );
                        const sequence = sourceMetadata.age_sequence ?? sourceMetadata.sequence ?? sourceMetadata.order;
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
                                source_type: sourceMetadata.source_type ?? 'ltmf',
                                memory_type: sourceMetadata.memory_type ?? 'autobiographical',
                                canon: sourceMetadata.canon ?? true,
                                age,
                                age_sequence: sequence,
                                age_query_match:
                                    autobiographicalAgeHint !== undefined && age === autobiographicalAgeHint,
                                structured_autobio_age_match: structuredAutobioAgeMatch,
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
                    console.log('[TalaRouter] Lore intent â€” RAG returned no results; mem0/local used as fallback');
                }
            } else if (intent.class === 'lore' && skipFreshRetrievalForContinuation) {
                console.log('[TalaRouter] Lore thread continuation confident - reusing prior canon context before widening retrieval');
            }

            // Log candidate source composition for audit visibility
            if (candidates.length > 0) {
                const sourceSummary = candidates.reduce<Record<string, number>>((acc, c) => {
                    const src = c.metadata?.source ?? 'unknown';
                    acc[src] = (acc[src] ?? 0) + 1;
                    return acc;
                }, {});
                console.log(
                    `[TalaRouter] Candidates before filter â€” ${Object.entries(sourceSummary).map(([s, n]) => `${s}:${n}`).join(', ')} (total=${candidates.length})`
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
            //       primary slots  â†’ up to LORE_PRIMARY_CANDIDATE_LIMIT canon lore items
            //       fallback slots â†’ up to LORE_FALLBACK_CAP explicit/chat items
            //
            //     Fallback behavior is preserved: if no canon candidates exist, the full
            //     resolved set (explicit/chat/mem0) passes through unchanged.
            if (intent.class === 'lore' && resolved.length > 0) {
                const loreSources = TalaContextRouter.LORE_CANON_SOURCES;
                const loreBucket = resolved.filter(m => loreSources.has(m.metadata?.source ?? ''));
                const fallbackBucket = resolved.filter(m => !loreSources.has(m.metadata?.source ?? ''));

                console.log(
                    `[TalaRouter] Lore composition â€” loreCandidates=${loreBucket.length} explicitCandidates=${fallbackBucket.length} fallbackCap=${TalaContextRouter.LORE_FALLBACK_CAP}`
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
                // else: no canon lore â€” fallback bucket passes through unchanged (all resolved items kept)
            }

            // 5b. Autobiographical contamination guard:
            //     For autobiographical lore recall, keep only approved canon sources and
            //     reject interaction transcripts / prior chat turns from lore grounding.
            if (intent.class === 'lore' && isAutobiographicalLoreRequest && resolved.length > 0) {
                const rejectedInteraction = resolved.filter(TalaContextRouter.isInteractionTranscriptCandidate);
                if (rejectedInteraction.length > 0) {
                    console.log(
                        `[TalaRouter] Rejected interaction transcript candidates from autobiographical lore grounding: ${rejectedInteraction.length}`
                    );
                }
                const canonOnly = resolved.filter(TalaContextRouter.isApprovedAutobioCanonCandidate);
                const rejectedNonCanon = resolved.length - canonOnly.length;
                if (rejectedNonCanon > 0) {
                    console.log(
                        `[TalaRouter] Autobiographical lore canon filter applied accepted=${canonOnly.length} rejected=${rejectedNonCanon}`
                    );
                }
                resolved = canonOnly;
            }
            if (shouldReuseLoreThread) {
                const hasCanonAfterResolution = resolved.some(m => TalaContextRouter.LORE_CANON_SOURCES.has(m.metadata?.source ?? ''));
                continuationSucceeded = hasCanonAfterResolution;
                continuationFailed = !hasCanonAfterResolution;
            }

            // Log final approved source composition
            if (resolved.length > 0) {
                const approvedSummary = resolved.reduce<Record<string, number>>((acc, c) => {
                    const src = c.metadata?.source ?? 'unknown';
                    acc[src] = (acc[src] ?? 0) + 1;
                    return acc;
                }, {});
                console.log(
                    `[TalaRouter] Approved memories â€” ${Object.entries(approvedSummary).map(([s, n]) => `${s}:${n}`).join(', ')} (total=${resolved.length})`
                );
            }
        } else {
            console.log(`[TalaRouter] Retrieval bypassed â€” ${intent.class} intent (no lore/substantive override).`);
        }

        // 6. Documentation Retrieval Phase (NEW)
        let docContext = '';
        const DOC_RELEVANCE_PATTERN = /\b(architecture|design|interface|spec|protocol|how does|explain|docs|documentation|logic|engine|service|requirement|traceability|security)\b/i;
        if (docIntel && DOC_RELEVANCE_PATTERN.test(query) && turnPolicy.docRetrievalPolicy === 'enabled') {
            console.log(`[TalaRouter] Turn identified as documentation-relevant. Requesting doc context...`);
            docContext = docIntel.getRelevantContext(query);
        }

        // 7. Canon gate for autobiographical lore requests.
        //
        //    Evaluated after source-bucket composition so we work with the final
        //    approved memory set.  Only fires when:
        //      a) intent=lore
        //      b) the query matches AUTOBIO_LORE_PATTERNS (first-person personal timeline)
        //      c) none of the approved memories come from a high-trust canon source
        //
        //    When the gate fires, responseMode is forced to 'canon_required' regardless
        //    of approved memory count â€” even partial fallback-only sets are insufficient.
        let sufficientCanonMemory = true;
        let canonGateApplied = false;
        let canonSourceTypes: string[] = [];
        let qualifiedCanonCount = 0;
        let minRequiredCanonCount = TalaContextRouter.AUTOBIO_MIN_CANON_APPROVED_COUNT;
        let degradedStructuredBypassApplied = false;

        if (intent.class === 'lore') {
            if (isAutobiographicalLoreRequest) {
                console.log('[CanonGate] autobiographical lore request detected');
                canonSourceTypes = [...new Set(resolved.map(m => m.metadata?.source ?? 'unknown'))];
                const hasStructuredAgeMatch =
                    autobiographicalAgeHint !== undefined &&
                    TalaContextRouter.hasStructuredAutobioAgeMatch(resolved);
                minRequiredCanonCount = hasStructuredAgeMatch ? 1 : TalaContextRouter.AUTOBIO_MIN_CANON_APPROVED_COUNT;
                qualifiedCanonCount = TalaContextRouter.countQualifiedCanonAutobioMemories(resolved);
                const sufficientByCount =
                    TalaContextRouter.hasSufficientCanonMemoryForAutobio(resolved, minRequiredCanonCount);
                degradedStructuredBypassApplied =
                    memorySystemDegraded &&
                    hasStructuredAgeMatch &&
                    qualifiedCanonCount >= 1;
                sufficientCanonMemory =
                    sufficientByCount &&
                    (!memorySystemDegraded || degradedStructuredBypassApplied);

                if (degradedStructuredBypassApplied) {
                    console.log('[CanonGate] degraded state override active for structured autobiographical age match');
                }
                if (!sufficientCanonMemory) {
                    console.log(
                        `[CanonGate] sufficientCanonMemory=false sources=${canonSourceTypes.join(',') || 'none'} approved=${resolved.length} qualifiedCanon=${qualifiedCanonCount} minCanon=${minRequiredCanonCount} minSemantic=${TalaContextRouter.AUTOBIO_MIN_SEMANTIC_SCORE} minConfidence=${TalaContextRouter.AUTOBIO_MIN_CONFIDENCE_SCORE} memoryState=${memorySystemState} degradedStructuredBypass=${degradedStructuredBypassApplied}`
                    );
                    console.log('[CanonGate] forcing strict no-canon response mode');
                    console.log('[CanonGate] hallucination prevention active for autobiographical turn');
                    canonGateApplied = true;
                }
            }
        }

        if (continuationFailed && this.activeLoreMemoryContext) {
            this.activeLoreMemoryContext.consecutiveContinuationMisses += 1;
            this.activeLoreMemoryContext.updatedAt = Date.now();
            if (this.activeLoreMemoryContext.consecutiveContinuationMisses >= TalaContextRouter.LORE_THREAD_MAX_MISSES) {
                this.clearLoreThread('continuation_failed_max_misses');
            }
        }

        // 8. Assembly & Handoff
        // Derive response grounding mode.
        //
        // Notebook active:  always 'memory_grounded_strict' â€” the user has an open notebook
        //   and all replies must be restricted to retrieved notebook content, regardless of
        //   intent or phrasing.
        //
        // Canon gate fired:  'canon_required' â€” autobiographical request with no high-trust
        //   canon memory; Tala must not fabricate first-person events.
        //
        // Lore intent (sufficient canon): always 'memory_grounded_strict'.
        let responseMode: ResponseMode | undefined;
        if (notebookActive) {
            responseMode = 'memory_grounded_strict';
            console.log(`[TalaRouter] Notebook context active â€” forcing responseMode=memory_grounded_strict`);
        } else if (canonGateApplied) {
            responseMode = 'canon_required';
            console.log(`[TalaRouter] CanonGate active â€” forcing responseMode=canon_required for autobiographical turn`);
        } else if (intent.class === 'lore' && resolved.length > 0) {
            responseMode = 'memory_grounded_strict';
            console.log(`[TalaRouter] Memory-grounded response mode: ${responseMode}`);
        }
        this.upsertLoreThreadFromResolved(
            turnId,
            responseMode,
            resolved,
            autobiographicalAgeHint,
            continuationSucceeded,
        );

        // Pass retrievalSuppressed flag to tell assembler not to emit a fallback block when retrieval was intentionally gated.
        const assemblyResult = ContextAssembler.assemble(
            resolved,
            mode,
            intent.class,
            retrievalSuppressed,
            docContext,
            responseMode,
            notebookActive,
        );
        const promptBlocks = assemblyResult.blocks;
        const fallbackUsed = promptBlocks.some((b: import('./ContextAssembler').ContextBlock) => b.header.includes('FALLBACK CONTRACT'));

        // 8. Capability Resolution (done here so TurnContext is self-contained)
        const blockedCapabilities: string[] = [];
        const allowedCapabilities: string[] = [];
        if (turnPolicy.toolExposureProfile === 'none') {
            blockedCapabilities.push('tools');
        } else {
            switch (turnPolicy.toolExposureProfile) {
                case 'technical_strict':
                    allowedCapabilities.push('system_core', 'memory_retrieval', 'diagnostic', 'browser_automation');
                    break;
                case 'factual_narrow':
                    allowedCapabilities.push('memory_retrieval', 'diagnostic');
                    break;
                case 'immersive_controlled':
                    if (mode === 'rp') {
                        blockedCapabilities.push('tools');
                        allowedCapabilities.push('memory_retrieval');
                    } else {
                        allowedCapabilities.push('memory_retrieval', 'diagnostic');
                    }
                    break;
                case 'balanced':
                default:
                    allowedCapabilities.push('all');
                    break;
            }
        }
        if (retrievalSuppressed) {
            blockedCapabilities.push('memory_retrieval');
            const idx = allowedCapabilities.indexOf('memory_retrieval');
            if (idx >= 0) allowedCapabilities.splice(idx, 1);
        }
        if (mode === 'rp' && !blockedCapabilities.includes('tools')) {
            blockedCapabilities.push('tools');
        }
        if (mode === 'rp' && !allowedCapabilities.includes('memory_retrieval')) {
            allowedCapabilities.push('memory_retrieval');
        }

        // 9. Memory Write Policy
        const memoryWriteDecision = this.resolveMemoryWritePolicy(mode, turnPolicy, intent.class, isGreetingOnly);

        console.log(`[TalaRouter] Routing complete. Approved memories: ${resolved.length}/${candidateCount}`);
        console.log(`[TalaRouter] Capabilities â€” allowed=${JSON.stringify(allowedCapabilities)} blocked=${JSON.stringify(blockedCapabilities)}`);
        console.log(`[TalaRouter] Memory write policy: ${memoryWriteDecision.category} â€” ${memoryWriteDecision.reason}`);

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
            turnPolicy,
            turnBehavior,
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
            responseMode,
            loreThread: this.activeLoreMemoryContext
                ? {
                    hasActiveContext: true,
                    continued: shouldReuseLoreThread,
                    continuationConfidence: continuityDecision.confidence,
                    reusedPriorCanon,
                    matchedAnchorEntities: continuityDecision.matchedEntities,
                    originTurnId: this.activeLoreMemoryContext.originatingTurnId,
                    expiresAt: this.activeLoreMemoryContext.expiresAt,
                    approvedMemoryIds: this.activeLoreMemoryContext.approvedMemoryIds,
                    approvedDocIds: this.activeLoreMemoryContext.approvedDocIds,
                    memoryLabels: this.activeLoreMemoryContext.memoryLabels,
                }
                : {
                    hasActiveContext: false,
                    continued: false,
                    continuationConfidence: continuityDecision.confidence,
                    reusedPriorCanon,
                    matchedAnchorEntities: continuityDecision.matchedEntities,
                    approvedMemoryIds: [],
                    approvedDocIds: [],
                    memoryLabels: [],
                },
            ...(intent.class === 'lore' ? {
                canonGateDecision: {
                    isAutobiographicalLoreRequest,
                    sufficientCanonMemory,
                    canonSourceTypes,
                    canonGateApplied,
                    qualifiedCanonCount,
                    minRequiredCanonCount,
                    minSemanticScore: TalaContextRouter.AUTOBIO_MIN_SEMANTIC_SCORE,
                    minConfidenceScore: TalaContextRouter.AUTOBIO_MIN_CONFIDENCE_SCORE,
                    memorySystemState,
                    memorySystemDegraded,
                    degradedStructuredBypassApplied,
                },
            } : {}),
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
            turnPolicyId: turnPolicy.policyId,
            toneProfile: turnBehavior.toneProfile,
            immersiveStyle: turnBehavior.immersiveStyle,
            memoryWriteCategory: memoryWriteDecision.category,
            responseMode: responseMode ?? 'none',
            isAutobiographicalLoreRequest,
            sufficientCanonMemory,
            canonSourceTypes,
            canonGateApplied,
            qualifiedCanonCount,
            minRequiredCanonCount,
            minSemanticScore: TalaContextRouter.AUTOBIO_MIN_SEMANTIC_SCORE,
            minConfidenceScore: TalaContextRouter.AUTOBIO_MIN_CONFIDENCE_SCORE,
            memorySystemState,
            memorySystemDegraded,
            degradedStructuredBypassApplied,
            loreThreadContinuation: {
                active: !!this.activeLoreMemoryContext,
                continued: shouldReuseLoreThread,
                confidence: continuityDecision.confidence,
                reusedPriorCanon,
                matchedAnchorEntities: continuityDecision.matchedEntities,
                activeOriginTurnId: this.activeLoreMemoryContext?.originatingTurnId ?? null,
                activeApprovedDocIds: this.activeLoreMemoryContext?.approvedDocIds ?? [],
                activeApprovedMemoryIds: this.activeLoreMemoryContext?.approvedMemoryIds ?? [],
            },
            correlationId
        });

        return context;
    }

    /**
     * Resolves the memory write policy for this turn based on mode and intent.
     *
     * Rules:
     * - RP mode â†’ do_not_write (RP isolation must not pollute memory)
     * - Greeting intent â†’ do_not_write (no content worth persisting)
     * - Hybrid mode â†’ short_term (moderate persistence)
     * - Assistant mode with task/technical intent â†’ long_term
     * - Assistant mode otherwise â†’ short_term
     */
    private resolveMemoryWritePolicy(mode: Mode, turnPolicy: TurnPolicyState, intentClass: string, isGreeting: boolean): MemoryWriteDecision {
        if (isGreeting || intentClass === 'greeting') {
            return { category: 'do_not_write', reason: 'Greeting turns carry no persistent content', executed: false };
        }
        if (turnPolicy.memoryWritePolicy === 'do_not_write') {
            const reason = mode === 'rp'
                ? 'RP mode isolation prohibits memory writes'
                : `Turn policy ${turnPolicy.policyId} prohibits memory writes`;
            return { category: 'do_not_write', reason, executed: false };
        }
        if (turnPolicy.memoryWritePolicy === 'long_term') {
            return { category: 'long_term', reason: `Turn policy ${turnPolicy.policyId} requires long-term retention`, executed: false };
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

    private resolveTurnPolicyId(mode: Mode, intentClass: string, isGreeting: boolean, query: string): TurnPolicyId {
        if (isGreeting || intentClass === 'greeting') return 'greeting';
        if (mode === 'rp' || intentClass === 'lore' || intentClass === 'narrative') return 'immersive_roleplay';
        if (['coding', 'technical', 'action', 'browser'].includes(intentClass)) return 'technical_execution';
        if (TalaContextRouter.FACTUAL_QUERY_PATTERNS.some((p) => p.test(query))) return 'factual_query';
        return ModePolicyEngine.resolveTurnPolicyId(mode, intentClass, isGreeting);
    }

    private resolveTurnPolicy(mode: Mode, policyId: TurnPolicyId, intentClass: string, isGreeting: boolean): TurnPolicyState {
        const base = ModePolicyEngine.getTurnPolicy(policyId);
        const memoryWritePolicy = this.resolvePolicyMemoryWrite(mode, base.policyId, intentClass, isGreeting);
        const toolExposureProfile = mode === 'assistant' && base.policyId === 'technical_execution'
            ? 'balanced'
            : base.toolExposureProfile;
        return {
            ...base,
            toolExposureProfile,
            memoryWritePolicy,
        };
    }

    private resolvePolicyMemoryWrite(
        mode: Mode,
        policyId: TurnPolicyId,
        intentClass: string,
        isGreeting: boolean,
    ): TurnPolicyState['memoryWritePolicy'] {
        if (policyId === 'greeting' || isGreeting || intentClass === 'greeting') return 'do_not_write';
        if (policyId === 'immersive_roleplay' || mode === 'rp') return 'do_not_write';
        if (policyId === 'technical_execution') return mode === 'assistant' ? 'long_term' : 'short_term';
        return 'short_term';
    }

    private createTurnBehaviorBaseline(): TurnBehaviorState {
        return {
            personalityLevel: 'minimal',
            astroLevel: 'off',
            reflectionLevel: 'off',
            toneProfile: 'neutral',
            immersiveStyle: false,
            narrativeAmplification: false,
            source: 'fresh',
        };
    }

    private applyTurnPolicyToBehavior(
        baseline: TurnBehaviorState,
        policy: TurnPolicyState,
    ): TurnBehaviorState {
        const applied: TurnBehaviorState = {
            ...baseline,
            personalityLevel: policy.personalityLevel,
            astroLevel: policy.astroLevel,
            reflectionLevel: policy.reflectionLevel,
            toneProfile: this.mapToneProfile(policy.responseStyle),
            immersiveStyle: policy.policyId === 'immersive_roleplay',
            narrativeAmplification: policy.policyId === 'immersive_roleplay',
            source: 'fresh',
        };
        return applied;
    }

    private mapToneProfile(
        responseStyle: TurnPolicyState['responseStyle'],
    ): TurnBehaviorState['toneProfile'] {
        switch (responseStyle) {
            case 'concise_technical':
                return 'precise';
            case 'neutral_informative':
                return 'concise';
            case 'warm_hybrid':
                return 'natural';
            case 'immersive_expressive':
                return 'immersive';
            case 'brief_direct':
            default:
                return 'neutral';
        }
    }
}
