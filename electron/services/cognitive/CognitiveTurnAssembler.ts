/**
 * Cognitive Turn Assembler — Phase 3: Cognitive Loop (Objective F)
 *
 * The canonical assembly path for Tala's cognitive turn model.
 * Assembles one TalaCognitiveContext per turn from structured cognitive inputs:
 * - Mode policy (from ModePolicyEngine)
 * - Memory contributions (from MemoryContributionBuilder)
 * - Documentation context (from DocumentationIntelligenceService)
 * - Emotional modulation (from EmotionalModulationPolicy)
 * - Reflection contributions (from ReflectionContributionStore)
 * - Provider metadata (from InferenceDiagnosticsService)
 *
 * Precedence rules (highest to lowest priority in prompt assembly):
 * 1. Explicit user input (always included, never suppressed)
 * 2. Mode policy constraints (gates what other inputs are allowed)
 * 3. Identity memory contributions (shapes Tala's self-understanding)
 * 4. Task-relevant memory contributions (grounds the response)
 * 5. Documentation context (factual grounding)
 * 6. Preference memory contributions (style and tone shaping)
 * 7. Recent continuity contributions (session coherence)
 * 8. Emotional modulation (bounded expression influence)
 * 9. Reflection behavioral notes (advisory, bounded, non-authoritative)
 * 10. Runtime degradation notes (operational context)
 *
 * This is the only place where TalaCognitiveContext is constructed.
 * Downstream services must not reconstruct state from partial inputs.
 */

import { v4 as uuidv4 } from 'uuid';
import type { MemoryItem } from '../MemoryService';
import type { Mode } from '../router/ModePolicyEngine';
import { ModePolicyEngine } from '../router/ModePolicyEngine';
import { MemoryContributionBuilder } from './MemoryContributionModel';
import { EmotionalModulationPolicy } from './EmotionalModulationPolicy';
import { reflectionContributionStore } from './ReflectionContributionModel';
import { telemetry } from '../TelemetryService';
import type {
    TalaCognitiveContext,
    CognitiveModePolicy,
    CognitiveProviderMetadata,
    DocContributionModel,
    MemoryContributionCategory,
} from '../../../shared/cognitiveTurnTypes';

// ─── Assembly inputs ──────────────────────────────────────────────────────────

/**
 * Inputs required to assemble a TalaCognitiveContext.
 * All fields except turnId, rawInput, and mode are optional for graceful degradation.
 */
export interface CognitiveAssemblyInputs {
    /** Unique turn identifier. */
    turnId: string;
    /** Raw user input text. */
    rawInput: string;
    /** Active cognitive mode. */
    mode: Mode;
    /** Memories that passed filtering and contradiction resolution. */
    approvedMemories?: MemoryItem[];
    /** Total memory candidates before filtering (for diagnostics). */
    memoryCandidateCount?: number;
    /** Memories excluded by policy (for diagnostics). */
    memoryExcludedCount?: number;
    /** Whether memory retrieval was suppressed for this turn. */
    memoryRetrievalSuppressed?: boolean;
    /** Reason retrieval was suppressed (if applicable). */
    memorySuppressionReason?: string;
    /** Classified intent for this turn. */
    intentClass?: string;
    /** Whether this turn is a greeting. */
    isGreeting?: boolean;
    /** Raw astro/emotional state string from AstroService. */
    astroStateText?: string | null;
    /** Documentation context text (if retrieved). */
    docContextText?: string | null;
    /** Documentation source IDs (if any). */
    docSourceIds?: string[];
    /** Reason docs were or were not retrieved. */
    docRationale?: string;
    /** ISO timestamp of last reflection cycle. */
    lastReflectionAt?: string;
    /** ID of the selected inference provider. */
    providerId?: string;
    /** Display name of the selected provider. */
    providerName?: string;
    /** Whether inference fallback was applied. */
    fallbackApplied?: boolean;
    /** Whether the runtime is in a degraded state. */
    runtimeDegraded?: boolean;
    /** Human-readable degradation notes. */
    degradationNotes?: string;
}

// ─── CognitiveTurnAssembler ───────────────────────────────────────────────────

/**
 * The canonical assembler for Tala's cognitive turn model.
 * Call assemble() exactly once per turn to produce a TalaCognitiveContext.
 */
export class CognitiveTurnAssembler {
    /**
     * Assembles a complete TalaCognitiveContext from the provided inputs.
     * Emits structured telemetry for each cognitive step.
     *
     * @param inputs - All inputs required to assemble the cognitive context.
     * @returns The fully-populated TalaCognitiveContext for this turn.
     */
    public static assemble(inputs: CognitiveAssemblyInputs): TalaCognitiveContext {
        const now = new Date().toISOString();
        const correlationId = uuidv4();
        const {
            turnId,
            rawInput,
            mode,
            approvedMemories = [],
            memoryCandidateCount = 0,
            memoryExcludedCount = 0,
            memoryRetrievalSuppressed = false,
            memorySuppressionReason,
            intentClass = 'unknown',
            isGreeting = false,
            astroStateText,
            docContextText,
            docSourceIds = [],
            docRationale,
            lastReflectionAt,
            providerId,
            providerName,
            fallbackApplied = false,
            runtimeDegraded = false,
            degradationNotes,
        } = inputs;

        // ── 1. Mode policy ────────────────────────────────────────────────────
        const cognitiveRules = ModePolicyEngine.getCognitiveRules(mode);
        const writePolicy = MemoryContributionBuilder.resolveWritePolicy(
            mode,
            intentClass,
            isGreeting,
        );

        const modePolicy: CognitiveModePolicy = {
            mode,
            memoryRetrievalPolicy: cognitiveRules.memoryRetrievalPolicy,
            memoryWritePolicy: writePolicy.policy as CognitiveModePolicy['memoryWritePolicy'],
            toolUsePolicy: cognitiveRules.toolUsePolicy,
            docRetrievalPolicy: cognitiveRules.docRetrievalPolicy,
            emotionalExpressionBounds: cognitiveRules.emotionalExpressionBounds,
            appliedAt: now,
        };

        telemetry.operational(
            'cognitive',
            'mode_policy_applied',
            'info',
            `turn:${turnId}`,
            `Mode policy applied: mode=${mode} memRetrieval=${modePolicy.memoryRetrievalPolicy} tools=${modePolicy.toolUsePolicy}`,
            'success',
            { payload: { mode, memoryRetrievalPolicy: modePolicy.memoryRetrievalPolicy, toolUsePolicy: modePolicy.toolUsePolicy, correlationId } },
        );

        // ── 2. Memory contributions ───────────────────────────────────────────
        const memoryContributions = MemoryContributionBuilder.build(
            approvedMemories,
            memoryCandidateCount,
            memoryExcludedCount,
            memoryRetrievalSuppressed,
            memorySuppressionReason,
            mode,
        );

        const memoryCategories: Partial<Record<MemoryContributionCategory, number>> = {};
        for (const c of memoryContributions.contributions) {
            memoryCategories[c.category] = (memoryCategories[c.category] ?? 0) + 1;
        }

        telemetry.operational(
            'cognitive',
            'memory_contribution_applied',
            'info',
            `turn:${turnId}`,
            `Memory contributions: ${memoryContributions.contributions.length} applied, ${memoryExcludedCount} excluded`,
            'success',
            {
                payload: {
                    memoryContributionCount: memoryContributions.contributions.length,
                    memoryCategories,
                    memoryRetrievalSuppressed,
                    correlationId,
                },
            },
        );

        // ── 3. Documentation contributions ───────────────────────────────────
        const docApplied = !!(
            docContextText &&
            docContextText.trim().length > 0 &&
            modePolicy.docRetrievalPolicy === 'enabled'
        );

        const docContributions: DocContributionModel = {
            applied: docApplied,
            summary: docApplied ? docContextText!.slice(0, 200) : undefined,
            rationale:
                docRationale ??
                (docApplied
                    ? 'Documentation context retrieved for relevant query'
                    : modePolicy.docRetrievalPolicy === 'suppressed'
                    ? 'Documentation retrieval suppressed by mode policy'
                    : 'No documentation context retrieved'),
            sourceIds: docApplied ? docSourceIds : [],
            retrievedAt: now,
        };

        if (docApplied) {
            telemetry.operational(
                'cognitive',
                'doc_context_applied',
                'info',
                `turn:${turnId}`,
                `Documentation context applied: ${docSourceIds.length} sources`,
                'success',
                { payload: { docContextApplied: true, docSourceCount: docSourceIds.length, correlationId } },
            );
        }

        // ── 4. Emotional modulation ───────────────────────────────────────────
        // Modulation is applied when the mode allows emotional expression beyond 'low'.
        // RP mode has 'high' bounds; assistant mode has 'low' bounds (which suppresses
        // modulation to prevent identity drift in task-focused turns).
        const allowEmotionalModulation = modePolicy.emotionalExpressionBounds !== 'low';
        const emotionalModulation = EmotionalModulationPolicy.apply(
            allowEmotionalModulation ? astroStateText : null,
            mode,
        );

        if (emotionalModulation.applied) {
            telemetry.operational(
                'cognitive',
                'emotional_modulation_applied',
                'info',
                `turn:${turnId}`,
                `Emotional modulation applied: strength=${emotionalModulation.strength}`,
                'success',
                {
                    payload: {
                        emotionalModulationApplied: true,
                        emotionalModulationStrength: emotionalModulation.strength,
                        astroUnavailable: emotionalModulation.astroUnavailable,
                        correlationId,
                    },
                },
            );
        } else {
            telemetry.operational(
                'cognitive',
                'emotional_modulation_skipped',
                'info',
                `turn:${turnId}`,
                `Emotional modulation skipped: ${emotionalModulation.skipReason ?? 'not applied'}`,
                'success',
                {
                    payload: {
                        emotionalModulationApplied: false,
                        astroUnavailable: emotionalModulation.astroUnavailable,
                        skipReason: emotionalModulation.skipReason,
                        correlationId,
                    },
                },
            );
        }

        // ── 5. Reflection contributions ───────────────────────────────────────
        const reflectionContributions = reflectionContributionStore.buildContributionModel(
            lastReflectionAt,
        );

        if (reflectionContributions.applied) {
            telemetry.operational(
                'cognitive',
                'reflection_contribution_applied',
                'info',
                `turn:${turnId}`,
                `Reflection behavioral notes applied: ${reflectionContributions.activeNotes.length} notes`,
                'success',
                {
                    payload: {
                        reflectionNoteCount: reflectionContributions.activeNotes.length,
                        correlationId,
                    },
                },
            );
        }

        // ── 6. Provider metadata ──────────────────────────────────────────────
        const providerMetadata: CognitiveProviderMetadata = {
            providerId,
            providerName,
            fallbackApplied,
            runtimeDegraded,
            degradationNotes,
        };

        // ── 7. Assembly inputs summary (precedence-ordered, no raw content) ───
        const assemblyInputsSummary: string[] = [
            `rawInput: ${rawInput.slice(0, 50)}${rawInput.length > 50 ? '...' : ''}`,
            `mode: ${mode}`,
            `memoryContributions: ${memoryContributions.contributions.length}`,
            `docContext: ${docApplied ? 'applied' : 'none'}`,
            `emotionalModulation: ${emotionalModulation.strength}`,
            `reflectionNotes: ${reflectionContributions.activeNotes.length}`,
            `provider: ${providerName ?? 'unknown'}${fallbackApplied ? ' (fallback)' : ''}`,
            runtimeDegraded ? `degraded: ${degradationNotes ?? 'yes'}` : '',
        ].filter(Boolean);

        // ── 8. Compaction check ───────────────────────────────────────────────
        // Context is considered compacted if contributions had to be trimmed.
        // This occurs when combined contribution count exceeds mode limits.
        const totalContributions =
            memoryContributions.contributions.length +
            (docApplied ? 1 : 0) +
            reflectionContributions.activeNotes.length;
        const wasCompacted = totalContributions > 12; // Reasonable turn budget

        if (wasCompacted) {
            telemetry.operational(
                'cognitive',
                'cognitive_context_compacted',
                'info',
                `turn:${turnId}`,
                `Cognitive context compacted: ${totalContributions} total contributions`,
                'success',
                { payload: { wasCompacted: true, totalContributions, correlationId } },
            );
        }

        // ── 9. Final cognitive context ────────────────────────────────────────
        const context: TalaCognitiveContext = {
            turnId,
            assembledAt: now,
            rawInput,
            normalizedInput: rawInput.toLowerCase().trim(),
            modePolicy,
            memoryContributions,
            docContributions,
            emotionalModulation,
            reflectionContributions,
            providerMetadata,
            assemblyInputsSummary,
            wasCompacted,
            correlationId,
        };

        // ── 10. Final assembly telemetry ──────────────────────────────────────
        telemetry.operational(
            'cognitive',
            'cognitive_context_assembled',
            'info',
            `turn:${turnId}`,
            `Cognitive context assembled: mode=${mode} memory=${memoryContributions.contributions.length} docs=${docApplied} emotion=${emotionalModulation.strength} reflection=${reflectionContributions.activeNotes.length}`,
            'success',
            {
                payload: {
                    mode,
                    memoryContributionCount: memoryContributions.contributions.length,
                    memoryCategories,
                    memoryRetrievalSuppressed,
                    docContextApplied: docApplied,
                    docSourceCount: docApplied ? docSourceIds.length : 0,
                    emotionalModulationApplied: emotionalModulation.applied,
                    emotionalModulationStrength: emotionalModulation.strength,
                    astroUnavailable: emotionalModulation.astroUnavailable,
                    reflectionNoteCount: reflectionContributions.activeNotes.length,
                    wasCompacted,
                    correlationId,
                },
            },
        );

        return context;
    }
}
