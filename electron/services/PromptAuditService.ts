import fs from 'fs';
import path from 'path';
import { resolveLogsPath } from './PathResolver';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type PromptAuditLevel = 'off' | 'summary' | 'full';

export interface PromptAuditConfig {
    enabled: boolean;
    level: PromptAuditLevel;
    logToConsole: boolean;
    logToFile: boolean;
    previewChars: number;
    maxFullInlineChars: number;
}

export const DEFAULT_PROMPT_AUDIT_CONFIG: PromptAuditConfig = {
    enabled: true,
    level: 'summary',
    logToConsole: true,
    logToFile: true,
    previewChars: 1200,
    maxFullInlineChars: 12000
};

export interface PromptAuditSection {
    name: string;
    included: boolean;
    reason?: string;
    charCount: number;
    preview?: string;
    fullText?: string;
}

export interface PromptAuditMessage {
    role: string;
    charCount: number;
    preview?: string;
    fullText?: string;
}

export interface PromptAuditRecord {
    timestamp: string;
    sessionId?: string;
    turnId?: string;
    model?: string;

    mode?: string;
    intent?: string;
    isGreeting?: boolean;

    inclusionFlags: {
        personalityIncluded: boolean;
        astroIncluded: boolean;
        memoryIncluded: boolean;
        worldIncluded: boolean;
        historyIncluded: boolean;
        toolsIncluded: boolean;
        imagesIncluded: boolean;
    };

    filterDecisions: {
        personalityExcludedReason?: string;
        astroExcludedReason?: string;
        memoryExcludedReason?: string;
        worldExcludedReason?: string;
        historyExcludedReason?: string;
        toolsExcludedReason?: string;
        imagesExcludedReason?: string;
    };

    sectionSizes: {
        personalityChars: number;
        astroChars: number;
        memoryChars: number;
        worldChars: number;
        historyChars: number;
        systemPromptChars: number;
        userPromptChars: number;
        totalPayloadChars: number;
    };

    assemblyOrder: string[];
    sections: PromptAuditSection[];
    messages: PromptAuditMessage[];

    requestSummary: {
        stream?: boolean;
        toolsFieldPresent: boolean;
        toolChoiceFieldPresent: boolean;
        messageCount: number;
        optionsPresent: boolean;
    };

    requestBodyPreview?: unknown;
    requestBodyFull?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// SENSITIVE FIELD REDACTION
// ─────────────────────────────────────────────────────────────────────────────

const SENSITIVE_KEYS_RE = /apikey|api_key|authorization|bearer|secret|token|credential/i;

function redactSensitiveFields(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(redactSensitiveFields);
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEYS_RE.test(k)) {
            result[k] = '[REDACTED]';
        } else {
            result[k] = redactSensitiveFields(v);
        }
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT AUDIT SERVICE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LLM Governance & Transparency Engine.
 * 
 * The `PromptAuditService` provides detailed visibility into the final prompts 
 * sent to AI models. It captures the assembly process, inclusion flags, 
 * and raw payloads, ensuring that engineering decisions (e.g., context pruning) 
 * are auditable and transparent.
 * 
 * **Core Responsibilities:**
 * - **Pre-flight Auditing**: Captures the exact prompt bytes before they leave 
 *    the application.
 * - **Governance Logs**: Maintains a JSONL record of prompt metadata, 
 *   including `sessionId`, `turnId`, and `intent`.
 * - **Redaction**: Scrubs API keys and sensitive tokens before logging.
 * - **Volume Analysis**: Tracks character counts per context block (Astro, 
 *   Memory, History) to optimize prompt performance.
 */
export class PromptAuditService {
    private config: PromptAuditConfig;
    private logPath: string | null = null;
    private logDirReady = false;

    constructor(config?: Partial<PromptAuditConfig>) {
        this.config = { ...DEFAULT_PROMPT_AUDIT_CONFIG, ...(config || {}) };
        this.initLogPath();
    }

    public updateConfig(config: Partial<PromptAuditConfig>) {
        this.config = { ...this.config, ...config };
        this.initLogPath();
    }

    private initLogPath() {
        if (!this.config.logToFile) {
            console.log('[PromptAudit] file logging is DISABLED in config');
            return;
        }
        try {
            const logDir = resolveLogsPath();
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            this.logPath = path.join(logDir, 'prompt-audit.jsonl');
            this.logDirReady = true;
            console.log(`[PromptAudit] file logging enabled=true`);
            console.log(`[PromptAudit] output path=${this.logPath}`);
        } catch (e: any) {
            console.warn('[PromptAudit] append failed: could not init log path', e.message);
            this.logDirReady = false;
        }
    }

    private trunc(text: string | undefined | null, maxLen: number): string {
        if (!text) return '';
        if (text.length <= maxLen) return text;
        return text.slice(0, maxLen) + `…[+${text.length - maxLen} chars]`;
    }

    /**
     * Records a complete prompt audit event.
     * 
     * This is the primary entry point for capturing the final state of an 
     * LLM request. Depending on the `level` configuration, it will output 
     * to the console, to a persistent JSONL file, or both.
     * 
     * @param record - The fully assembled `PromptAuditRecord`.
     */
    public emit(record: PromptAuditRecord): void {
        if (!this.config.enabled || this.config.level === 'off') return;

        try {
            if (this.config.logToConsole) {
                this.consoleLog(record);
            }
            if (this.config.logToFile && this.logDirReady && this.logPath) {
                this.fileLog(record);
            }
        } catch (e) {
            console.warn('[PromptAudit] non-fatal logging failure:', e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CONSOLE OUTPUT
    // ─────────────────────────────────────────────────────────────────────────

    private consoleLog(r: PromptAuditRecord): void {
        const f = r.inclusionFlags;
        const d = r.filterDecisions;
        const s = r.sectionSizes;
        const rq = r.requestSummary;

        if (this.config.level === 'summary') {
            console.log(`[FinalPromptAudit] turn=${r.turnId || 'unknown'} session=${r.sessionId || 'unknown'} mode=${r.mode || '?'} intent=${r.intent || '?'} greeting=${r.isGreeting ?? false} model=${r.model || '?'}`);
            console.log(`[FinalPromptAudit] included personality=${f.personalityIncluded}(${s.personalityChars}) astro=${f.astroIncluded}(${s.astroChars}) memory=${f.memoryIncluded}(${s.memoryChars}) world=${f.worldIncluded}(${s.worldChars}) history=${f.historyIncluded}(${s.historyChars}) tools=${f.toolsIncluded} images=${f.imagesIncluded}`);
            const excl: string[] = [];
            if (!f.memoryIncluded && d.memoryExcludedReason) excl.push(`memory=${d.memoryExcludedReason}`);
            if (!f.toolsIncluded && d.toolsExcludedReason) excl.push(`tools=${d.toolsExcludedReason}`);
            if (!f.worldIncluded && d.worldExcludedReason) excl.push(`world=${d.worldExcludedReason}`);
            if (!f.astroIncluded && d.astroExcludedReason) excl.push(`astro=${d.astroExcludedReason}`);
            if (!f.personalityIncluded && d.personalityExcludedReason) excl.push(`personality=${d.personalityExcludedReason}`);
            console.log(`[FinalPromptAudit] excluded ${excl.length > 0 ? excl.join(' ') : 'none'}`);
            console.log(`[FinalPromptAudit] order=${r.assemblyOrder.join(' -> ')}`);
            console.log(`[FinalPromptAudit] messages=${rq.messageCount} totalPayloadChars=${s.totalPayloadChars} toolsField=${rq.toolsFieldPresent} toolChoiceField=${rq.toolChoiceFieldPresent} stream=${rq.stream ?? false}`);
        } else {
            // full mode
            const sep = '='.repeat(72);
            const dash = '-'.repeat(72);
            const lines: string[] = [
                sep,
                'FINAL PROMPT AUDIT',
                sep,
                `turnId            : ${r.turnId || 'unknown'}`,
                `sessionId         : ${r.sessionId || 'unknown'}`,
                `mode              : ${r.mode || 'unknown'}`,
                `intent            : ${r.intent || 'unknown'}`,
                `isGreeting        : ${r.isGreeting ?? false}`,
                `model             : ${r.model || 'unknown'}`,
                '',
                'INCLUSION FLAGS',
                dash,
                `personalityIncluded : ${f.personalityIncluded}`,
                `astroIncluded       : ${f.astroIncluded}`,
                `memoryIncluded      : ${f.memoryIncluded}`,
                `worldIncluded       : ${f.worldIncluded}`,
                `historyIncluded     : ${f.historyIncluded}`,
                `toolsIncluded       : ${f.toolsIncluded}`,
                `imagesIncluded      : ${f.imagesIncluded}`,
                '',
                'FILTER DECISIONS',
                dash,
                ...(d.memoryExcludedReason ? [`memoryExcluded      : ${d.memoryExcludedReason}`] : []),
                ...(d.toolsExcludedReason ? [`toolsExcluded       : ${d.toolsExcludedReason}`] : []),
                ...(d.astroExcludedReason ? [`astroExcluded       : ${d.astroExcludedReason}`] : []),
                ...(d.worldExcludedReason ? [`worldExcluded       : ${d.worldExcludedReason}`] : []),
                ...(d.personalityExcludedReason ? [`personalityExcluded : ${d.personalityExcludedReason}`] : []),
                ...(d.historyExcludedReason ? [`historyExcluded     : ${d.historyExcludedReason}`] : []),
                ...(d.imagesExcludedReason ? [`imagesExcluded      : ${d.imagesExcludedReason}`] : []),
                '',
                'SECTION SIZES',
                dash,
                `personalityChars    : ${s.personalityChars}`,
                `astroChars          : ${s.astroChars}`,
                `memoryChars         : ${s.memoryChars}`,
                `worldChars          : ${s.worldChars}`,
                `historyChars        : ${s.historyChars}`,
                `systemPromptChars   : ${s.systemPromptChars}`,
                `userPromptChars     : ${s.userPromptChars}`,
                `totalPayloadChars   : ${s.totalPayloadChars}`,
                '',
                'ASSEMBLY ORDER',
                dash,
                ...r.assemblyOrder.map((name, i) => `${i + 1}. ${name}`),
            ];

            for (const sec of r.sections) {
                if (sec.included && (sec.preview || sec.fullText)) {
                    lines.push('');
                    lines.push(`SECTION PREVIEW: ${sec.name.toUpperCase()}`);
                    lines.push(dash);
                    lines.push(sec.fullText || sec.preview || '');
                }
            }

            lines.push('');
            lines.push('FINAL MESSAGES');
            lines.push(dash);
            for (let i = 0; i < r.messages.length; i++) {
                const m = r.messages[i];
                lines.push(`[${i}] role=${m.role}`);
                lines.push(m.fullText || m.preview || '(empty)');
                lines.push('');
            }

            lines.push('REQUEST SUMMARY');
            lines.push(dash);
            lines.push(`toolsFieldPresent   : ${rq.toolsFieldPresent}`);
            lines.push(`toolChoicePresent   : ${rq.toolChoiceFieldPresent}`);
            lines.push(`stream              : ${rq.stream ?? false}`);
            lines.push(`optionsPresent      : ${rq.optionsPresent}`);
            lines.push(sep);

            console.log(lines.join('\n'));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // JSONL FILE OUTPUT
    // ─────────────────────────────────────────────────────────────────────────

    private fileLog(r: PromptAuditRecord): void {
        try {
            const record: any = {
                timestamp: r.timestamp,
                sessionId: r.sessionId,
                turnId: r.turnId,
                mode: r.mode,
                intent: r.intent,
                isGreeting: r.isGreeting,
                model: r.model,
                inclusionFlags: r.inclusionFlags,
                filterDecisions: r.filterDecisions,
                sectionSizes: r.sectionSizes,
                assemblyOrder: r.assemblyOrder,
                messages: r.messages.map(m => ({
                    role: m.role,
                    charCount: m.charCount,
                    preview: m.preview,
                    ...(this.config.level === 'full' ? { fullText: m.fullText } : {})
                })),
                requestSummary: r.requestSummary
            };

            if (this.config.level === 'full') {
                record.sections = r.sections;
                if (r.requestBodyFull) {
                    record.requestBodyFull = redactSensitiveFields(r.requestBodyFull);
                } else if (r.requestBodyPreview) {
                    record.requestBodyPreview = redactSensitiveFields(r.requestBodyPreview);
                }
            }

            fs.appendFileSync(this.logPath!, JSON.stringify(record) + '\n', 'utf-8');
            // console.log(`[PromptAudit] append success`);
        } catch (e: any) {
            console.warn(`[PromptAudit] append failed: ${e.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BUILDER HELPER
    // Build a PromptAuditRecord from the AgentService's assembled context
    // ─────────────────────────────────────────────────────────────────────────

    public buildRecord(params: {
        sessionId?: string;
        turnId?: string;
        mode: string;
        intent: string;
        isGreeting: boolean;
        hasMemories: boolean;
        memoryContext: string;
        systemPrompt: string;
        userMessage: string;
        astroState: string;
        hasAstro: boolean;
        hasImages: boolean;
        hasWorld: boolean;
        toolsIncluded: boolean;
        toolsExcludedReason?: string;
        memoryExcludedReason?: string;
        goalsAndReflections?: string;
        messages?: Array<{ role: string; content?: string }>;
    }): PromptAuditRecord {
        const pc = this.config.previewChars;
        const full = this.config.level === 'full';

        const personalityChars = params.systemPrompt.length;
        const astroChars = params.hasAstro ? params.astroState.length : 0;
        const memoryChars = params.hasMemories ? params.memoryContext.length : 0;
        const worldChars = params.hasWorld ? 200 : 0; // world context is injected into system prompt, not tracked separately
        const historyChars = params.messages ? params.messages.filter(m => m.role !== 'system').reduce((sum, m) => sum + (m.content?.length || 0), 0) : 0;
        const userPromptChars = params.userMessage.length;
        const totalPayloadChars = personalityChars + astroChars + memoryChars + userPromptChars + historyChars;

        const assemblyOrder: string[] = [];
        if (params.hasAstro) assemblyOrder.push('astro');
        if (params.hasMemories) assemblyOrder.push('memory');
        if (params.goalsAndReflections?.trim()) assemblyOrder.push('goals_and_reflections');
        assemblyOrder.push('personality');
        if (params.toolsIncluded) assemblyOrder.push('tool_schema_summary');
        assemblyOrder.push('recent_history');
        assemblyOrder.push('user_message');

        const sections: PromptAuditSection[] = [
            {
                name: 'personality',
                included: true,
                charCount: personalityChars,
                preview: this.trunc(params.systemPrompt, pc),
                fullText: full ? params.systemPrompt.slice(0, this.config.maxFullInlineChars) : undefined
            },
            {
                name: 'astro',
                included: params.hasAstro,
                reason: params.hasAstro ? undefined : 'no_astro_state_available',
                charCount: astroChars,
                preview: params.hasAstro ? this.trunc(params.astroState, pc) : undefined,
                fullText: full && params.hasAstro ? params.astroState : undefined
            },
            {
                name: 'memory',
                included: params.hasMemories,
                reason: params.memoryExcludedReason,
                charCount: memoryChars,
                preview: params.hasMemories ? this.trunc(params.memoryContext, pc) : undefined,
                fullText: full && params.hasMemories ? params.memoryContext.slice(0, this.config.maxFullInlineChars) : undefined
            },
            {
                name: 'tool_schema_summary',
                included: params.toolsIncluded,
                reason: params.toolsExcludedReason,
                charCount: params.toolsIncluded ? 1 : 0, // approximate; tools are embedded in system prompt
            },
            {
                name: 'recent_history',
                included: historyChars > 0,
                charCount: historyChars,
            },
            {
                name: 'user_message',
                included: true,
                charCount: userPromptChars,
                preview: this.trunc(params.userMessage, pc),
                fullText: full ? params.userMessage : undefined
            }
        ];

        const messages: PromptAuditMessage[] = (params.messages || []).map(m => ({
            role: m.role,
            charCount: m.content?.length || 0,
            preview: this.trunc(m.content, pc),
            fullText: full ? m.content : undefined
        }));

        return {
            timestamp: new Date().toISOString(),
            sessionId: params.sessionId,
            turnId: params.turnId,
            mode: params.mode,
            intent: params.intent,
            isGreeting: params.isGreeting,
            model: undefined, // filled in at pre-flight

            inclusionFlags: {
                personalityIncluded: true,
                astroIncluded: params.hasAstro,
                memoryIncluded: params.hasMemories,
                worldIncluded: params.hasWorld,
                historyIncluded: historyChars > 0,
                toolsIncluded: params.toolsIncluded,
                imagesIncluded: params.hasImages
            },

            filterDecisions: {
                memoryExcludedReason: !params.hasMemories ? (params.memoryExcludedReason || 'greeting_or_suppressed') : undefined,
                toolsExcludedReason: !params.toolsIncluded ? (params.toolsExcludedReason || 'capability_policy') : undefined,
                astroExcludedReason: !params.hasAstro ? 'no_astro_state_available' : undefined,
                worldExcludedReason: !params.hasWorld ? 'world_data_absent' : undefined
            },

            sectionSizes: {
                personalityChars,
                astroChars,
                memoryChars,
                worldChars,
                historyChars,
                systemPromptChars: personalityChars,
                userPromptChars,
                totalPayloadChars
            },

            assemblyOrder,
            sections,
            messages,

            requestSummary: {
                stream: undefined, // filled in at pre-flight
                toolsFieldPresent: params.toolsIncluded,
                toolChoiceFieldPresent: false,
                messageCount: messages.length,
                optionsPresent: false
            }
        };
    }

    /**
     * Enrich an existing record with pre-flight data from OllamaBrain.
     * Called just before the fetch() is executed.
     */
    public enrichWithPreFlight(record: PromptAuditRecord, params: {
        model: string;
        messages: any[];
        toolsFieldPresent: boolean;
        toolChoiceFieldPresent: boolean;
        stream: boolean;
        optionsPresent: boolean;
        requestBody?: any;
    }): PromptAuditRecord {
        record.model = params.model;
        record.requestSummary = {
            stream: params.stream,
            toolsFieldPresent: params.toolsFieldPresent,
            toolChoiceFieldPresent: params.toolChoiceFieldPresent,
            messageCount: params.messages.length,
            optionsPresent: params.optionsPresent
        };

        // Rebuild messages from actual pre-flight payload for accuracy
        const pc = this.config.previewChars;
        const full = this.config.level === 'full';
        record.messages = params.messages.map((m: any) => ({
            role: m.role || 'unknown',
            charCount: (m.content || '').length,
            preview: this.trunc(m.content, pc),
            fullText: full ? m.content : undefined
        }));

        if (params.requestBody) {
            const safe = redactSensitiveFields(params.requestBody);
            if (this.config.level === 'full') {
                record.requestBodyFull = safe;
            } else {
                // summary: just the top-level shape
                record.requestBodyPreview = {
                    model: safe.model,
                    messageCount: safe.messages?.length,
                    hasTools: !!safe.tools,
                    toolCount: safe.tools?.length ?? 0,
                    stream: safe.stream,
                    hasOptions: !!safe.options
                };
            }
        }

        return record;
    }
}

// Singleton — AgentService and OllamaBrain share the same instance
export const promptAuditService = new PromptAuditService();
