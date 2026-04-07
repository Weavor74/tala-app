/**
 * ContextAssembler — Pure Runtime Context Assembly Boundary
 *
 * This is the explicit, hardened context assembly boundary for TALA's agent turn lifecycle.
 *
 * **Role:**
 *   ContextAssembler is a pure assembly layer. It takes pre-gathered, normalized context
 *   inputs and produces a structured AssembledContext — one deterministic output per input set.
 *
 * **What this service does:**
 *   - Assembles structured ContextSection[] from pre-gathered context inputs
 *   - Enforces deterministic per-section and total token budgets
 *   - Assigns typed ContextSelectionReason / ContextExclusionReason codes to every section
 *   - Maps approved memories to ContextEvidence[] with full provenance
 *   - Produces ContextAssemblyMetadata with full budget accounting
 *   - Returns AssembledContext as a single normalized boundary value
 *
 * **What this service does NOT do (by design):**
 *   - Does NOT execute tools or invoke any external service
 *   - Does NOT write to memory or mutate any store
 *   - Does NOT perform policy enforcement (policy is resolved upstream)
 *   - Does NOT emit telemetry or trigger side effects during assembly
 *   - Does NOT synthesize or emit user-visible responses
 *   - Does NOT perform retrieval — all inputs must be pre-gathered before assembly
 *
 * **Budget enforcement:**
 *   - Per-section maxChars budgets are enforced before the section is finalized.
 *   - Content exceeding maxChars is truncated at a word boundary (overflowPolicy='truncate')
 *     or the section is dropped (overflowPolicy='drop').
 *   - After all sections are built, the total token budget is enforced:
 *     non-mandatory sections are dropped (in reverse priority order) until the total fits.
 *   - Mandatory sections (mode_constraints, request_summary) are never dropped.
 *
 * **Section priority order (canonical):**
 *   identity > mode_constraints > memory > document > graph_retrieval >
 *   affective > tool_availability > request_summary
 *
 * **Determinism guarantee:**
 *   Given the same ContextAssemblerInputs (excluding timestamp and correlationId),
 *   assembleContext() always produces the same set of sections, evidence, and budget records.
 *   Section inclusion, ordering, truncation, and reason codes are fully determined by the inputs.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    AssembledContext,
    ContextAssemblerInputs,
    ContextAssemblyMetadata,
    ContextBudgetPolicy,
    ContextEvidence,
    ContextExclusionReason,
    ContextSection,
    ContextSectionName,
    ContextSelectionReason,
    SectionBudgetResult,
} from '../../../shared/context/assembledContextTypes';

// ─── Token estimation ─────────────────────────────────────────────────────────

/** Rough 4-chars-per-token heuristic (consistent with ContextAssemblyService). */
function estimateTokens(charCount: number): number {
    return Math.ceil(charCount / 4);
}

// ─── Budget constants ─────────────────────────────────────────────────────────

/**
 * Default total token budget for one assembled context.
 * Designed for 8k–16k context window models. Override via inputs.totalBudgetTokensOverride.
 */
export const DEFAULT_TOTAL_BUDGET_TOKENS = 6000;

/**
 * Suffix appended to truncated content to signal the truncation.
 * Kept short to avoid wasting token budget.
 */
const TRUNCATION_SUFFIX = ' [...]';

/**
 * Maximum number of characters to include from the raw user input in the
 * request summary section. Inputs longer than this are truncated with "...".
 */
const REQUEST_SUMMARY_TRUNCATION_LENGTH = 100;

// ─── Section budget contracts ─────────────────────────────────────────────────

/**
 * Canonical per-section budget policies.
 *
 * Budgets are expressed in characters (4 chars ≈ 1 token).
 * mandatoryInclude=true sections survive total-budget enforcement.
 *
 * Rationale for values:
 *   identity        2000 chars ≈  500 tokens — persona grounding; rarely long
 *   mode_constraints 800 chars ≈  200 tokens — compact policy summary; mandatory
 *   memory          8000 chars ≈ 2000 tokens — primary evidence; high budget
 *   document        6000 chars ≈ 1500 tokens — doc/notebook context
 *   graph_retrieval 3200 chars ≈  800 tokens — supplementary graph context
 *   affective        800 chars ≈  200 tokens — emotional modulation; compact
 *   tool_availability 400 chars ≈ 100 tokens — capability list; compact
 *   request_summary  800 chars ≈  200 tokens — user input summary; mandatory
 */
export const SECTION_BUDGET_POLICIES: Record<ContextSectionName, ContextBudgetPolicy> = {
    identity:          { maxChars: 2000,  maxTokens: 500,  mandatoryInclude: false, overflowPolicy: 'truncate' },
    mode_constraints:  { maxChars: 800,   maxTokens: 200,  mandatoryInclude: true,  overflowPolicy: 'truncate' },
    memory:            { maxChars: 8000,  maxTokens: 2000, mandatoryInclude: false, overflowPolicy: 'truncate' },
    document:          { maxChars: 6000,  maxTokens: 1500, mandatoryInclude: false, overflowPolicy: 'truncate' },
    graph_retrieval:   { maxChars: 3200,  maxTokens: 800,  mandatoryInclude: false, overflowPolicy: 'truncate' },
    affective:         { maxChars: 800,   maxTokens: 200,  mandatoryInclude: false, overflowPolicy: 'truncate' },
    tool_availability: { maxChars: 400,   maxTokens: 100,  mandatoryInclude: false, overflowPolicy: 'truncate' },
    request_summary:   { maxChars: 800,   maxTokens: 200,  mandatoryInclude: true,  overflowPolicy: 'truncate' },
};

// ─── Section ordering ─────────────────────────────────────────────────────────

/**
 * Canonical section priority order for rendering and budget enforcement.
 * Higher-priority sections are filled first and dropped last.
 * Lower index = higher priority.
 */
export const SECTION_PRIORITY_ORDER: ContextSectionName[] = [
    'identity',
    'mode_constraints',
    'memory',
    'document',
    'graph_retrieval',
    'affective',
    'tool_availability',
    'request_summary',
];

// ─── Internal assembly helper ─────────────────────────────────────────────────

/**
 * Internal working type: a section before budget enforcement is applied.
 * Carries the raw content and classification; budget is enforced afterwards.
 */
interface RawSection {
    name: ContextSectionName;
    header: string;
    rawContent: string;
    priority: 'high' | 'normal' | 'low';
    included: boolean;
    suppressionReason?: string;
    selectionReason?: ContextSelectionReason;
    exclusionReason?: ContextExclusionReason;
}

// ─── ContextAssembler ─────────────────────────────────────────────────────────

/**
 * Pure, deterministic runtime context assembler with explicit section contracts
 * and token budget enforcement.
 *
 * Call assembleContext() exactly once per turn to produce the AssembledContext
 * boundary value for that turn. No IO, no side effects, no external calls.
 */
export class ContextAssembler {
    /**
     * Assembles a structured AssembledContext from pre-gathered context inputs.
     *
     * Budget enforcement is applied in two passes:
     *   Pass 1: Per-section budget — content exceeding maxChars is truncated or dropped.
     *   Pass 2: Total budget — non-mandatory sections over the total are dropped.
     *
     * @param inputs - All pre-gathered context inputs for this turn.
     * @returns A structured, normalized AssembledContext for the turn.
     */
    public static assembleContext(inputs: ContextAssemblerInputs): AssembledContext {
        const assemblyStart = Date.now();
        const assembledAt = new Date().toISOString();
        const correlationId = uuidv4();
        const totalBudgetTokens = inputs.totalBudgetTokensOverride ?? DEFAULT_TOTAL_BUDGET_TOKENS;
        const totalBudgetChars = totalBudgetTokens * 4;

        // ── Pass 0: Build raw sections ─────────────────────────────────────
        const rawSections: RawSection[] = [
            ContextAssembler.buildRawIdentitySection(inputs),
            ContextAssembler.buildRawModeConstraintsSection(inputs),
            ContextAssembler.buildRawMemorySection(inputs),
            ContextAssembler.buildRawDocumentSection(inputs),
            ContextAssembler.buildRawGraphRetrievalSection(inputs),
            ContextAssembler.buildRawAffectiveSection(inputs),
            ContextAssembler.buildRawToolAvailabilitySection(inputs),
            ContextAssembler.buildRawRequestSummarySection(inputs),
        ];

        // ── Sort raw sections by canonical priority ────────────────────────
        const sortedRaw = ContextAssembler.sortRawSections(rawSections);

        // ── Pass 1: Per-section budget enforcement ─────────────────────────
        const budgetedSections = sortedRaw.map(raw =>
            ContextAssembler.applyPerSectionBudget(raw),
        );

        // ── Pass 2: Total budget enforcement ──────────────────────────────
        const { finalSections, sectionBudgets, droppedCount } =
            ContextAssembler.applyTotalBudget(budgetedSections, totalBudgetChars);

        // ── Build evidence items from approved memories ────────────────────
        const evidence = ContextAssembler.buildEvidence(inputs);

        // ── Compute metadata ───────────────────────────────────────────────
        const includedSections = finalSections.filter(s => s.included);
        const includedSectionCount = includedSections.length;
        const totalCharCount = includedSections.reduce((sum, s) => sum + s.charCount, 0);
        const totalEstimatedTokens = estimateTokens(totalCharCount);
        const truncatedSectionCount = sectionBudgets.filter(b => b.wasTruncated).length;

        const totalContributions =
            (inputs.approvedMemories?.length ?? 0) +
            (inputs.docContextText ? 1 : 0) +
            (inputs.graphContextText ? 1 : 0);
        const wasCompacted = totalContributions > 12;

        const assemblyDurationMs = Date.now() - assemblyStart;

        const metadata: ContextAssemblyMetadata = {
            turnId: inputs.turnId,
            assembledAt,
            correlationId,
            mode: inputs.mode,
            intentClass: inputs.intentClass,
            sectionCount: finalSections.length,
            includedSectionCount,
            totalEvidenceCount: evidence.length,
            wasCompacted,
            assemblyDurationMs,
            totalCharCount,
            totalEstimatedTokens,
            totalBudgetTokens,
            budgetUtilization: totalBudgetTokens > 0 ? totalEstimatedTokens / totalBudgetTokens : 0,
            sectionBudgets,
            truncatedSectionCount,
            droppedSectionCount: droppedCount,
        };

        return {
            metadata,
            sections: finalSections,
            evidence,
        };
    }

    // ─── Raw section builders ─────────────────────────────────────────────────

    private static buildRawIdentitySection(inputs: ContextAssemblerInputs): RawSection {
        const hasContent = !!(inputs.identityText && inputs.identityText.trim().length > 0);
        return {
            name: 'identity',
            header: '[IDENTITY — PERSONA GROUNDING]',
            rawContent: hasContent ? inputs.identityText!.trim() : '',
            priority: 'high',
            included: hasContent,
            selectionReason: hasContent ? 'content_available' : undefined,
            suppressionReason: hasContent ? undefined : 'No identity text provided',
            exclusionReason: hasContent ? undefined : 'no_content',
        };
    }

    private static buildRawModeConstraintsSection(inputs: ContextAssemblerInputs): RawSection {
        const lines: string[] = [`Mode: ${inputs.mode}`];
        if (inputs.memoryRetrievalPolicy)     lines.push(`Memory retrieval: ${inputs.memoryRetrievalPolicy}`);
        if (inputs.memoryWritePolicy)         lines.push(`Memory write: ${inputs.memoryWritePolicy}`);
        if (inputs.toolUsePolicy)             lines.push(`Tool use: ${inputs.toolUsePolicy}`);
        if (inputs.docRetrievalPolicy)        lines.push(`Doc retrieval: ${inputs.docRetrievalPolicy}`);
        if (inputs.emotionalExpressionBounds) lines.push(`Emotional expression: ${inputs.emotionalExpressionBounds}`);
        return {
            name: 'mode_constraints',
            header: '[MODE POLICY CONSTRAINTS]',
            rawContent: lines.join('\n'),
            priority: 'high',
            included: true,
            selectionReason: 'mandatory',
        };
    }

    private static buildRawMemorySection(inputs: ContextAssemblerInputs): RawSection {
        const memories = inputs.approvedMemories ?? [];

        if (inputs.memoryRetrievalSuppressed) {
            return {
                name: 'memory',
                header: '[MEMORY CONTEXT]',
                rawContent: '',
                priority: 'normal',
                included: false,
                suppressionReason: inputs.memorySuppressionReason ?? 'Memory retrieval suppressed',
                exclusionReason: 'retrieval_suppressed',
            };
        }

        if (memories.length === 0) {
            const isSubstantive = !inputs.isGreeting && inputs.intentClass !== 'unknown';
            if (!isSubstantive) {
                return {
                    name: 'memory',
                    header: '[MEMORY CONTEXT]',
                    rawContent: '',
                    priority: 'normal',
                    included: false,
                    suppressionReason: inputs.isGreeting
                        ? 'No memories to include for greeting turn'
                        : 'No memories to include for unknown intent',
                    exclusionReason: inputs.isGreeting ? 'greeting_turn' : 'unknown_intent',
                };
            }
            return {
                name: 'memory',
                header: '[MEMORY CONTEXT]',
                rawContent: `No approved memories found for intent: ${inputs.intentClass}. ` +
                            `Do not invent or fabricate memory content.`,
                priority: 'normal',
                included: true,
                selectionReason: 'fallback_contract',
            };
        }

        if (inputs.notebookGrounded) {
            const labeledContent = memories
                .map((m, idx) => {
                    const uri = (m.metadata?.['uri'] as string | undefined)
                        ?? (m.metadata?.['sourcePath'] as string | undefined)
                        ?? (m.metadata?.['docId'] as string | undefined)
                        ?? 'unknown';
                    return `[${idx + 1}] Source: ${uri}\n---\n${m.text}\n---`;
                })
                .join('\n\n');
            return {
                name: 'memory',
                header: '[CANON NOTEBOOK CONTEXT — STRICT]',
                rawContent: labeledContent,
                priority: 'high',
                included: true,
                selectionReason: 'notebook_grounding',
            };
        }

        if (inputs.responseMode) {
            const labeledContent = memories
                .map((m, idx) => {
                    const source = m.source ?? (m.metadata?.['source'] as string | undefined) ?? 'unknown';
                    return `Memory ${idx + 1}:\nSource: ${ContextAssembler.loreSourceLabel(source)}\nContent: ${m.text}`;
                })
                .join('\n\n');
            return {
                name: 'memory',
                header: '[CANON LORE MEMORIES — HIGH PRIORITY]',
                rawContent: labeledContent,
                priority: 'high',
                included: true,
                selectionReason: 'lore_grounding',
            };
        }

        return {
            name: 'memory',
            header: '[MEMORY CONTEXT]',
            rawContent: memories.map(m => m.text).join('\n'),
            priority: 'normal',
            included: true,
            selectionReason: 'content_available',
        };
    }

    private static buildRawDocumentSection(inputs: ContextAssemblerInputs): RawSection {
        const hasDoc = !!(inputs.docContextText && inputs.docContextText.trim().length > 0);
        if (!hasDoc) {
            return {
                name: 'document',
                header: '[PROJECT DOCUMENTATION CONTEXT]',
                rawContent: '',
                priority: 'high',
                included: false,
                suppressionReason: inputs.docRationale ?? 'No documentation context retrieved',
                exclusionReason: 'no_content',
            };
        }
        const sourceNote = inputs.docSourceIds && inputs.docSourceIds.length > 0
            ? `\n\nSources: ${inputs.docSourceIds.join(', ')}`
            : '';
        return {
            name: 'document',
            header: '[PROJECT DOCUMENTATION CONTEXT]',
            rawContent: inputs.docContextText!.trim() + sourceNote,
            priority: 'high',
            included: true,
            selectionReason: 'content_available',
        };
    }

    private static buildRawGraphRetrievalSection(inputs: ContextAssemblerInputs): RawSection {
        const hasGraph = !!(inputs.graphContextText && inputs.graphContextText.trim().length > 0);
        return {
            name: 'graph_retrieval',
            header: '[DIRECT GRAPH CONTEXT]',
            rawContent: hasGraph ? inputs.graphContextText!.trim() : '',
            priority: 'normal',
            included: hasGraph,
            selectionReason: hasGraph ? 'content_available' : undefined,
            suppressionReason: hasGraph ? undefined : 'No graph context available for this turn',
            exclusionReason: hasGraph ? undefined : 'no_content',
        };
    }

    private static buildRawAffectiveSection(inputs: ContextAssemblerInputs): RawSection {
        const hasAstro = !!(inputs.astroStateText && inputs.astroStateText.trim().length > 0);
        const modApplied = inputs.emotionalModulationApplied === true;
        if (!hasAstro || !modApplied) {
            return {
                name: 'affective',
                header: '[AFFECTIVE / EMOTIONAL STATE]',
                rawContent: '',
                priority: 'normal',
                included: false,
                suppressionReason: !hasAstro
                    ? 'No astro/emotional state available'
                    : 'Emotional modulation not applied for this mode',
                exclusionReason: !hasAstro ? 'no_content' : 'policy_suppressed',
            };
        }
        const strengthNote = inputs.emotionalModulationStrength
            ? ` (strength: ${inputs.emotionalModulationStrength})`
            : '';
        return {
            name: 'affective',
            header: '[AFFECTIVE / EMOTIONAL STATE]',
            rawContent: inputs.astroStateText!.trim() + strengthNote,
            priority: 'normal',
            included: true,
            selectionReason: 'content_available',
        };
    }

    private static buildRawToolAvailabilitySection(inputs: ContextAssemblerInputs): RawSection {
        const allowed = inputs.allowedCapabilities ?? [];
        const blocked = inputs.blockedCapabilities ?? [];
        const hasCapabilities = allowed.length > 0 || blocked.length > 0;
        if (!hasCapabilities) {
            return {
                name: 'tool_availability',
                header: '[TOOL AVAILABILITY]',
                rawContent: '',
                priority: 'low',
                included: false,
                suppressionReason: 'No capability information available',
                exclusionReason: 'no_content',
            };
        }
        const lines: string[] = [];
        if (allowed.length > 0) lines.push(`Allowed: ${allowed.join(', ')}`);
        if (blocked.length > 0) lines.push(`Blocked: ${blocked.join(', ')}`);
        return {
            name: 'tool_availability',
            header: '[TOOL AVAILABILITY]',
            rawContent: lines.join('\n'),
            priority: 'low',
            included: true,
            selectionReason: 'content_available',
        };
    }

    private static buildRawRequestSummarySection(inputs: ContextAssemblerInputs): RawSection {
        const lines = [
            `Input: ${inputs.rawInput.slice(0, REQUEST_SUMMARY_TRUNCATION_LENGTH)}${inputs.rawInput.length > REQUEST_SUMMARY_TRUNCATION_LENGTH ? '...' : ''}`,
            `Intent: ${inputs.intentClass}`,
            `Greeting: ${inputs.isGreeting}`,
        ];
        if (inputs.normalizedInput !== inputs.rawInput.toLowerCase().trim()) {
            lines.push(`Normalized: ${inputs.normalizedInput.slice(0, REQUEST_SUMMARY_TRUNCATION_LENGTH)}`);
        }
        return {
            name: 'request_summary',
            header: '[REQUEST SUMMARY]',
            rawContent: lines.join('\n'),
            priority: 'low',
            included: true,
            selectionReason: 'mandatory',
        };
    }

    // ─── Budget enforcement ───────────────────────────────────────────────────

    /**
     * Pass 1: Enforce the per-section character budget.
     * If content exceeds the section's maxChars:
     *   - overflowPolicy='truncate': truncate at a word boundary; update selectionReason.
     *   - overflowPolicy='drop': exclude the section; set exclusionReason.
     *
     * Returns a fully-formed ContextSection with budget metadata.
     */
    private static applyPerSectionBudget(raw: RawSection): ContextSection {
        const policy = SECTION_BUDGET_POLICIES[raw.name];
        let content = raw.rawContent;
        let selectionReason = raw.selectionReason;
        let included = raw.included;
        let suppressionReason = raw.suppressionReason;
        let exclusionReason = raw.exclusionReason;
        let wasTruncated = false;

        if (included && policy.maxChars > 0 && content.length > policy.maxChars) {
            if (policy.overflowPolicy === 'truncate') {
                content = ContextAssembler.truncateAtWordBoundary(content, policy.maxChars);
                selectionReason = 'content_truncated';
                wasTruncated = true;
            } else {
                // drop
                included = false;
                content = '';
                selectionReason = undefined;
                suppressionReason = `Content (${raw.rawContent.length} chars) exceeds section budget (${policy.maxChars} chars)`;
                exclusionReason = 'section_budget_exceeded';
            }
        }

        const charCount = included ? content.length : 0;
        const estimatedTokens = estimateTokens(charCount);

        return {
            name: raw.name,
            header: raw.header,
            content,
            priority: raw.priority,
            included,
            suppressionReason,
            selectionReason,
            exclusionReason,
            charCount,
            estimatedTokens,
            budgetPolicy: policy,
        };
    }

    /**
     * Pass 2: Enforce the total token budget.
     * Non-mandatory sections are dropped in reverse priority order (lowest priority first)
     * until the total estimated token count fits within the budget.
     *
     * Returns the final sections array, per-section budget records, and dropped count.
     */
    private static applyTotalBudget(
        sections: ContextSection[],
        totalBudgetChars: number,
    ): { finalSections: ContextSection[]; sectionBudgets: SectionBudgetResult[]; droppedCount: number } {
        let runningChars = sections.reduce((sum, s) => sum + s.charCount, 0);
        let droppedCount = 0;

        // Build a working copy we can mutate for dropping
        const working = sections.map(s => ({ ...s }));

        // Drop non-mandatory sections in reverse priority order (lowest priority first)
        // until total fits. We iterate from the end of SECTION_PRIORITY_ORDER backwards.
        if (runningChars > totalBudgetChars) {
            for (let i = SECTION_PRIORITY_ORDER.length - 1; i >= 0 && runningChars > totalBudgetChars; i--) {
                const name = SECTION_PRIORITY_ORDER[i];
                const policy = SECTION_BUDGET_POLICIES[name];
                if (policy.mandatoryInclude) continue; // Never drop mandatory sections

                const idx = working.findIndex(s => s.name === name && s.included);
                if (idx === -1) continue;

                runningChars -= working[idx].charCount;
                working[idx] = {
                    ...working[idx],
                    included: false,
                    content: '',
                    charCount: 0,
                    estimatedTokens: 0,
                    selectionReason: undefined,
                    suppressionReason: 'Dropped: total context budget exceeded',
                    exclusionReason: 'total_budget_exceeded',
                };
                droppedCount++;
            }
        }

        // Build SectionBudgetResult records in canonical section order
        const sectionBudgets: SectionBudgetResult[] = SECTION_PRIORITY_ORDER.map(name => {
            const original = sections.find(s => s.name === name)!;
            const final = working.find(s => s.name === name)!;
            const rawCharCount = original.included ? original.content.length : 0;
            return {
                name,
                policy: SECTION_BUDGET_POLICIES[name],
                rawCharCount,
                finalCharCount: final.charCount,
                estimatedTokens: final.estimatedTokens,
                wasTruncated: original.selectionReason === 'content_truncated',
                included: final.included,
            };
        });

        return { finalSections: working, sectionBudgets, droppedCount };
    }

    // ─── Evidence builder ─────────────────────────────────────────────────────

    private static buildEvidence(inputs: ContextAssemblerInputs): ContextEvidence[] {
        const evidence: ContextEvidence[] = [];
        const memories = inputs.approvedMemories ?? [];
        for (const mem of memories) {
            const source = mem.source ?? (mem.metadata?.['source'] as string | undefined) ?? 'memory';
            evidence.push({
                evidenceId: mem.id,
                content: mem.text,
                source,
                selectionClass: 'evidence',
                memoryId: mem.id,
                metadata: mem.metadata,
            });
        }
        return evidence;
    }

    // ─── Sorting ──────────────────────────────────────────────────────────────

    private static sortRawSections(sections: RawSection[]): RawSection[] {
        return [...sections].sort((a, b) => {
            const ai = SECTION_PRIORITY_ORDER.indexOf(a.name);
            const bi = SECTION_PRIORITY_ORDER.indexOf(b.name);
            const aIdx = ai === -1 ? SECTION_PRIORITY_ORDER.length : ai;
            const bIdx = bi === -1 ? SECTION_PRIORITY_ORDER.length : bi;
            return aIdx - bIdx;
        });
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Truncates text to at most maxChars characters, breaking at a word boundary
     * where possible. Appends TRUNCATION_SUFFIX to signal the truncation.
     */
    private static truncateAtWordBoundary(text: string, maxChars: number): string {
        const suffixLen = TRUNCATION_SUFFIX.length;
        const targetLen = maxChars - suffixLen;
        if (targetLen <= 0) return TRUNCATION_SUFFIX.trimStart();
        let truncated = text.slice(0, targetLen);
        // Back up to the last whitespace to avoid cutting mid-word
        const lastSpace = truncated.lastIndexOf(' ');
        if (lastSpace > targetLen * 0.8) {
            truncated = truncated.slice(0, lastSpace);
        }
        return truncated + TRUNCATION_SUFFIX;
    }

    /**
     * Maps an internal memory source identifier to a human-readable label
     * for use in the canon lore memory format presented to the model.
     */
    private static loreSourceLabel(source?: string): string {
        switch (source) {
            case 'rag':      return 'LTMF';
            case 'diary':    return 'diary';
            case 'graph':    return 'graph';
            case 'core_bio': return 'core_biographical';
            case 'lore':     return 'lore';
            case 'mem0':     return 'autobiographical';
            default:         return source ?? 'unknown';
        }
    }
}
