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
 *   - Maps approved memories to ContextEvidence[] with full provenance
 *   - Produces ContextAssemblyMetadata for audit and observability
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
 * **Assembly inputs:**
 *   All inputs come from the pre-inference orchestration stage
 *   (PreInferenceContextOrchestrator + CognitiveTurnAssembler inputs). No IO occurs
 *   inside assembleContext().
 *
 * **Determinism guarantee:**
 *   Given the same ContextAssemblerInputs (excluding timestamp and correlationId),
 *   assembleContext() always produces the same set of sections and evidence items.
 *   Section inclusion, ordering, and content are fully determined by the inputs.
 *
 * **Downstream consumption:**
 *   The returned AssembledContext is consumed by prompt builders and the cognitive
 *   turn assembler to construct the model-facing prompt for inference.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    AssembledContext,
    ContextAssemblerInputs,
    ContextAssemblyMetadata,
    ContextEvidence,
    ContextSection,
    ContextSectionName,
} from '../../../shared/context/assembledContextTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of characters to include from the raw user input in the
 * request summary section. Inputs longer than this are truncated with "...".
 */
const REQUEST_SUMMARY_TRUNCATION_LENGTH = 100;

// ─── Section ordering ─────────────────────────────────────────────────────────

/** Priority order for section rendering. Lower index = higher priority. */
const SECTION_PRIORITY_ORDER: ContextSectionName[] = [
    'identity',
    'mode_constraints',
    'memory',
    'document',
    'graph_retrieval',
    'affective',
    'tool_availability',
    'request_summary',
];

// ─── ContextAssembler ─────────────────────────────────────────────────────────

/**
 * Pure, deterministic runtime context assembler.
 *
 * Call assembleContext() exactly once per turn to produce the AssembledContext
 * boundary value for that turn. No IO, no side effects, no external calls.
 */
export class ContextAssembler {
    /**
     * Assembles a structured AssembledContext from pre-gathered context inputs.
     *
     * This method is synchronous and side-effect-free. All IO must have completed
     * before this method is called. The returned AssembledContext is a pure data
     * value that can be safely serialized, logged, or passed to downstream services.
     *
     * @param inputs - All pre-gathered context inputs for this turn.
     * @returns A structured, normalized AssembledContext for the turn.
     */
    public static assembleContext(inputs: ContextAssemblerInputs): AssembledContext {
        const assemblyStart = Date.now();
        const assembledAt = new Date().toISOString();
        const correlationId = uuidv4();

        const sections: ContextSection[] = [];

        // ── 1. Identity / persona section ─────────────────────────────────
        sections.push(ContextAssembler.buildIdentitySection(inputs));

        // ── 2. Mode / system constraints section ──────────────────────────
        sections.push(ContextAssembler.buildModeConstraintsSection(inputs));

        // ── 3. Memory section ─────────────────────────────────────────────
        sections.push(ContextAssembler.buildMemorySection(inputs));

        // ── 4. Document / notebook section ────────────────────────────────
        sections.push(ContextAssembler.buildDocumentSection(inputs));

        // ── 5. Graph / retrieval section ──────────────────────────────────
        sections.push(ContextAssembler.buildGraphRetrievalSection(inputs));

        // ── 6. Affective / astro section ──────────────────────────────────
        sections.push(ContextAssembler.buildAffectiveSection(inputs));

        // ── 7. Tool availability section ──────────────────────────────────
        sections.push(ContextAssembler.buildToolAvailabilitySection(inputs));

        // ── 8. Request summary section ────────────────────────────────────
        sections.push(ContextAssembler.buildRequestSummarySection(inputs));

        // ── Sort sections by canonical priority order ──────────────────────
        const sortedSections = ContextAssembler.sortSections(sections);

        // ── Build evidence items from approved memories ────────────────────
        const evidence = ContextAssembler.buildEvidence(inputs);

        // ── Assembly metadata ──────────────────────────────────────────────
        const includedSectionCount = sortedSections.filter(s => s.included).length;
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
            sectionCount: sortedSections.length,
            includedSectionCount,
            totalEvidenceCount: evidence.length,
            wasCompacted,
            assemblyDurationMs,
        };

        return {
            metadata,
            sections: sortedSections,
            evidence,
        };
    }

    // ─── Section builders ─────────────────────────────────────────────────────

    private static buildIdentitySection(inputs: ContextAssemblerInputs): ContextSection {
        const included = !!(inputs.identityText && inputs.identityText.trim().length > 0);
        return {
            name: 'identity',
            header: '[IDENTITY — PERSONA GROUNDING]',
            content: included ? inputs.identityText!.trim() : '',
            priority: 'high',
            included,
            suppressionReason: included ? undefined : 'No identity text provided',
        };
    }

    private static buildModeConstraintsSection(inputs: ContextAssemblerInputs): ContextSection {
        const lines: string[] = [
            `Mode: ${inputs.mode}`,
        ];
        if (inputs.memoryRetrievalPolicy) lines.push(`Memory retrieval: ${inputs.memoryRetrievalPolicy}`);
        if (inputs.memoryWritePolicy)     lines.push(`Memory write: ${inputs.memoryWritePolicy}`);
        if (inputs.toolUsePolicy)         lines.push(`Tool use: ${inputs.toolUsePolicy}`);
        if (inputs.docRetrievalPolicy)    lines.push(`Doc retrieval: ${inputs.docRetrievalPolicy}`);
        if (inputs.emotionalExpressionBounds) {
            lines.push(`Emotional expression: ${inputs.emotionalExpressionBounds}`);
        }

        return {
            name: 'mode_constraints',
            header: '[MODE POLICY CONSTRAINTS]',
            content: lines.join('\n'),
            priority: 'high',
            included: true,
        };
    }

    private static buildMemorySection(inputs: ContextAssemblerInputs): ContextSection {
        const memories = inputs.approvedMemories ?? [];

        if (inputs.memoryRetrievalSuppressed) {
            return {
                name: 'memory',
                header: '[MEMORY CONTEXT]',
                content: '',
                priority: 'normal',
                included: false,
                suppressionReason: inputs.memorySuppressionReason ?? 'Memory retrieval suppressed',
            };
        }

        if (memories.length === 0) {
            const isSubstantive = !inputs.isGreeting && inputs.intentClass !== 'unknown';
            const content = isSubstantive
                ? `No approved memories found for intent: ${inputs.intentClass}. ` +
                  `Do not invent or fabricate memory content.`
                : '';
            return {
                name: 'memory',
                header: '[MEMORY CONTEXT]',
                content,
                priority: 'normal',
                included: isSubstantive,
                suppressionReason: isSubstantive
                    ? undefined
                    : 'No memories to include for greeting or unknown intent',
            };
        }

        // Notebook grounded: strict grounding mode
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
                content: labeledContent,
                priority: 'high',
                included: true,
            };
        }

        // Lore / autobiographical mode
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
                content: labeledContent,
                priority: 'high',
                included: true,
            };
        }

        // Standard memory context
        return {
            name: 'memory',
            header: '[MEMORY CONTEXT]',
            content: memories.map(m => m.text).join('\n'),
            priority: 'normal',
            included: true,
        };
    }

    private static buildDocumentSection(inputs: ContextAssemblerInputs): ContextSection {
        const hasDoc = !!(inputs.docContextText && inputs.docContextText.trim().length > 0);
        if (!hasDoc) {
            return {
                name: 'document',
                header: '[PROJECT DOCUMENTATION CONTEXT]',
                content: '',
                priority: 'high',
                included: false,
                suppressionReason: inputs.docRationale ?? 'No documentation context retrieved',
            };
        }

        const sourceNote = inputs.docSourceIds && inputs.docSourceIds.length > 0
            ? `\n\nSources: ${inputs.docSourceIds.join(', ')}`
            : '';

        return {
            name: 'document',
            header: '[PROJECT DOCUMENTATION CONTEXT]',
            content: inputs.docContextText!.trim() + sourceNote,
            priority: 'high',
            included: true,
        };
    }

    private static buildGraphRetrievalSection(inputs: ContextAssemblerInputs): ContextSection {
        const hasGraph = !!(inputs.graphContextText && inputs.graphContextText.trim().length > 0);
        return {
            name: 'graph_retrieval',
            header: '[DIRECT GRAPH CONTEXT]',
            content: hasGraph ? inputs.graphContextText!.trim() : '',
            priority: 'normal',
            included: hasGraph,
            suppressionReason: hasGraph ? undefined : 'No graph context available for this turn',
        };
    }

    private static buildAffectiveSection(inputs: ContextAssemblerInputs): ContextSection {
        const hasAstro = !!(inputs.astroStateText && inputs.astroStateText.trim().length > 0);
        const modApplied = inputs.emotionalModulationApplied === true;

        if (!hasAstro || !modApplied) {
            return {
                name: 'affective',
                header: '[AFFECTIVE / EMOTIONAL STATE]',
                content: '',
                priority: 'normal',
                included: false,
                suppressionReason: !hasAstro
                    ? 'No astro/emotional state available'
                    : 'Emotional modulation not applied for this mode',
            };
        }

        const strengthNote = inputs.emotionalModulationStrength
            ? ` (strength: ${inputs.emotionalModulationStrength})`
            : '';

        return {
            name: 'affective',
            header: '[AFFECTIVE / EMOTIONAL STATE]',
            content: inputs.astroStateText!.trim() + strengthNote,
            priority: 'normal',
            included: true,
        };
    }

    private static buildToolAvailabilitySection(inputs: ContextAssemblerInputs): ContextSection {
        const allowed = inputs.allowedCapabilities ?? [];
        const blocked = inputs.blockedCapabilities ?? [];
        const hasCapabilities = allowed.length > 0 || blocked.length > 0;

        if (!hasCapabilities) {
            return {
                name: 'tool_availability',
                header: '[TOOL AVAILABILITY]',
                content: '',
                priority: 'low',
                included: false,
                suppressionReason: 'No capability information available',
            };
        }

        const lines: string[] = [];
        if (allowed.length > 0) lines.push(`Allowed: ${allowed.join(', ')}`);
        if (blocked.length > 0) lines.push(`Blocked: ${blocked.join(', ')}`);

        return {
            name: 'tool_availability',
            header: '[TOOL AVAILABILITY]',
            content: lines.join('\n'),
            priority: 'low',
            included: true,
        };
    }

    private static buildRequestSummarySection(inputs: ContextAssemblerInputs): ContextSection {
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
            content: lines.join('\n'),
            priority: 'low',
            included: true,
        };
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

    /**
     * Sorts sections by the canonical priority order.
     * Sections not in the canonical order are appended at the end.
     */
    private static sortSections(sections: ContextSection[]): ContextSection[] {
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
