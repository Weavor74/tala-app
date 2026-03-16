/**
 * Cognitive Context Compactor — Phase 3B: Small-Model Cognitive Compaction
 *
 * Compacts a TalaCognitiveContext into a model-appropriate CompactPromptPacket.
 *
 * Sits between TalaCognitiveContext and final prompt assembly.
 * Does NOT modify AgentService or the live inference path directly.
 *
 * Compaction precedence (highest to lowest):
 *   1. Identity core
 *   2. Active mode
 *   3. Current task intent
 *   4. Explicit user facts (identity memories)
 *   5. Tool availability/policy
 *   6. Compressed emotional modulation
 *   7. Top memory/context items
 *   8. Response rules
 *
 * Lower-priority material is dropped under budget pressure.
 * Every compaction produces a CompactionDiagnosticsSummary.
 */

import type {
    TalaCognitiveContext,
} from '../../../shared/cognitiveTurnTypes';
import type {
    ModelCapabilityProfile,
    CompactPromptPacket,
    CompactionDiagnosticsSummary,
} from '../../../shared/modelCapabilityTypes';
import { identityCompressionPolicy } from './IdentityCompressionPolicy';
import { toolCompressionPolicy } from './ToolCompressionPolicy';
import { emotionalCompressionPolicy } from './EmotionalCompressionPolicy';
import { cognitiveBudgetApplier } from './CognitiveBudgetApplier';
import { telemetry } from '../TelemetryService';

// ─── Response rules ───────────────────────────────────────────────────────────

const RESPONSE_RULES_TINY = `[Rules] Be concise. Stay on task. Do not hallucinate. Do not repeat yourself. If unsure, say so.`;
const RESPONSE_RULES_STANDARD = `[Rules] Respond clearly and helpfully. Stay on the current task. Acknowledge uncertainty when it exists. Use tools only when they add value. Maintain Tala's tone and continuity.`;

// ─── Compactor ────────────────────────────────────────────────────────────────

export class CognitiveContextCompactor {
    /**
     * Compacts a TalaCognitiveContext into a CompactPromptPacket appropriate
     * for the given ModelCapabilityProfile.
     *
     * Emits telemetry events for each major compression step.
     *
     * @param context - The full cognitive context from CognitiveTurnAssembler.
     * @param profile - The model capability profile from PromptProfileSelector.
     * @returns CompactPromptPacket for downstream prompt assembly.
     */
    public compact(
        context: TalaCognitiveContext,
        profile: ModelCapabilityProfile,
    ): CompactPromptPacket {
        const compactionStart = Date.now();
        const profileClass = profile.promptProfileClass;
        const budget = profile.budgetProfile;
        const turnId = context.turnId;
        const mode = context.modePolicy.mode;

        // ── 1. Identity compression ───────────────────────────────────────────
        const { prose: identityCore, scaffold: identityScaffold } =
            identityCompressionPolicy.compress(profileClass, mode);

        telemetry.operational(
            'cognitive',
            'identity_compression_applied',
            'debug',
            'CognitiveContextCompactor',
            `Identity compression: ${budget.allowFullIdentityProse ? 'full' : 'compressed'} scaffold for ${profileClass}`,
            'success',
            { payload: { turnId, profileClass, mode, identityMode: budget.allowFullIdentityProse ? 'full' : 'compressed' } },
        );

        // ── 2. Mode block ─────────────────────────────────────────────────────
        const modeBlock = `[Mode] ${mode}`;

        // ── 3. Tool compression ───────────────────────────────────────────────
        const toolPolicy = context.modePolicy.toolUsePolicy;
        const toolGuidance = toolCompressionPolicy.compress(profileClass, toolPolicy, budget);
        const toolPolicyBlock = [
            toolGuidance.useGuidance,
            toolGuidance.allowedSummary,
            toolGuidance.blockedSummary,
        ].filter(Boolean).join('\n');

        telemetry.operational(
            'cognitive',
            'tool_compression_applied',
            'debug',
            'CognitiveContextCompactor',
            `Tool compression: ${budget.allowFullToolSchemas ? 'full schemas' : 'compact policy'} for ${profileClass}`,
            'success',
            { payload: { turnId, profileClass, toolUsePolicy: toolPolicy, toolMode: budget.allowFullToolSchemas ? 'full_schemas' : 'compact_policy' } },
        );

        // ── 4. Emotional compression ──────────────────────────────────────────
        const emotionalBias = emotionalCompressionPolicy.compress(
            context.emotionalModulation,
            profileClass,
        );
        const emotionalBiasBlock = emotionalCompressionPolicy.toPromptBlock(emotionalBias);

        telemetry.operational(
            'cognitive',
            'emotional_compression_applied',
            'debug',
            'CognitiveContextCompactor',
            `Emotional compression: ${emotionalBias.available ? 'bias applied' : 'unavailable/skipped'} for ${profileClass}`,
            'success',
            { payload: { turnId, profileClass, emotionAvailable: emotionalBias.available, warmth: emotionalBias.warmth, caution: emotionalBias.caution } },
        );

        // ── 5. Memory budget ──────────────────────────────────────────────────
        const memoryResult = cognitiveBudgetApplier.applyMemoryBudget(
            context.memoryContributions,
            budget,
        );

        telemetry.operational(
            'cognitive',
            'memory_budget_applied',
            'debug',
            'CognitiveContextCompactor',
            `Memory budget: kept ${memoryResult.keptCount}, dropped ${memoryResult.droppedCount}`,
            'success',
            { payload: { turnId, profileClass, kept: memoryResult.keptCount, dropped: memoryResult.droppedCount } },
        );

        // ── 6. Doc budget ─────────────────────────────────────────────────────
        const docResult = cognitiveBudgetApplier.applyDocBudget(
            context.docContributions,
            budget,
        );

        telemetry.operational(
            'cognitive',
            'doc_budget_applied',
            'debug',
            'CognitiveContextCompactor',
            `Doc budget: ${docResult.included ? 'included' : 'excluded'} — ${docResult.droppedReason ?? 'applied'}`,
            'success',
            { payload: { turnId, profileClass, docsIncluded: docResult.included } },
        );

        // ── 7. Reflection budget ──────────────────────────────────────────────
        const reflectionResult = cognitiveBudgetApplier.applyReflectionBudget(
            context.reflectionContributions,
            budget,
        );

        telemetry.operational(
            'cognitive',
            'reflection_budget_applied',
            'debug',
            'CognitiveContextCompactor',
            `Reflection budget: kept ${reflectionResult.keptCount}, dropped ${reflectionResult.droppedCount}`,
            'success',
            { payload: { turnId, profileClass, kept: reflectionResult.keptCount, dropped: reflectionResult.droppedCount } },
        );

        // ── 8. Continuity block from budgeted memory ──────────────────────────
        const continuityBlock = this.buildContinuityBlock(memoryResult.kept, docResult);

        // ── 9. Current task block ─────────────────────────────────────────────
        const currentTaskBlock = this.buildTaskBlock(context.normalizedInput, reflectionResult.kept);

        // ── 10. Response rules ────────────────────────────────────────────────
        const isTinyOrSmall = profileClass === 'tiny_profile' || profileClass === 'small_profile';
        const responseRulesBlock = isTinyOrSmall ? RESPONSE_RULES_TINY : RESPONSE_RULES_STANDARD;

        // ── 11. Assemble sections in stable order ─────────────────────────────
        const allSections: Array<{ key: string; content: string }> = [
            { key: 'identity', content: identityCore },
            { key: 'mode', content: modeBlock },
            { key: 'emotion', content: emotionalBiasBlock },
            { key: 'tools', content: toolPolicyBlock },
            { key: 'continuity', content: continuityBlock },
            { key: 'task', content: currentTaskBlock },
            { key: 'rules', content: responseRulesBlock },
        ];

        const includedSections = allSections.filter(s => s.content.trim().length > 0);
        const droppedSections = allSections
            .filter(s => s.content.trim().length === 0)
            .map(s => s.key);

        const assembledSections = includedSections.map(s => s.content);

        // ── 12. Build diagnostics summary ─────────────────────────────────────
        const diagnosticsSummary: CompactionDiagnosticsSummary = {
            profileClass,
            compactionPolicy: profile.compactionPolicy,
            parameterClass: profile.parameterClass,
            memoriesKept: memoryResult.keptCount,
            memoriesDropped: memoryResult.droppedCount,
            docsIncluded: docResult.included,
            docChunksIncluded: docResult.included ? 1 : 0,
            reflectionNotesKept: reflectionResult.keptCount,
            reflectionNotesDropped: reflectionResult.droppedCount,
            emotionIncluded: emotionalBias.available,
            identityMode: budget.allowFullIdentityProse ? 'full' : 'compressed',
            toolMode: budget.allowFullToolSchemas ? 'full_schemas' : 'compact_policy',
            sectionsIncluded: includedSections.map(s => s.key),
            sectionsDropped: droppedSections,
            rationale: `Profile: ${profileClass} (${profile.parameterClass}) — compaction: ${profile.compactionPolicy}. ${profile.classificationRationale}`,
        };

        // ── 13. Emit compaction telemetry ─────────────────────────────────────
        const compactionDurationMs = Date.now() - compactionStart;

        telemetry.operational(
            'cognitive',
            'cognitive_context_compacted_for_model',
            'info',
            'CognitiveContextCompactor',
            `Cognitive context compacted for ${profileClass} (${profile.parameterClass}): ${memoryResult.keptCount} memories kept, ${memoryResult.droppedCount} dropped`,
            'success',
            {
                payload: {
                    turnId,
                    profileClass,
                    parameterClass: profile.parameterClass,
                    compactionPolicy: profile.compactionPolicy,
                    memoriesKept: memoryResult.keptCount,
                    memoriesDropped: memoryResult.droppedCount,
                    docsIncluded: docResult.included,
                    reflectionNotesKept: reflectionResult.keptCount,
                    reflectionNotesDropped: reflectionResult.droppedCount,
                    emotionIncluded: emotionalBias.available,
                    sectionsIncluded: diagnosticsSummary.sectionsIncluded,
                },
            },
        );

        // Phase 3C — emit compaction performance telemetry
        telemetry.operational(
            'cognitive',
            'compaction_duration_ms',
            'debug',
            'CognitiveContextCompactor',
            `Compaction duration: ${compactionDurationMs}ms`,
            'success',
            { payload: { turnId, durationMs: compactionDurationMs } },
        );

        return {
            identityCore,
            modeBlock,
            emotionalBiasBlock,
            toolPolicyBlock,
            continuityBlock,
            currentTaskBlock,
            responseRulesBlock,
            assembledSections,
            diagnosticsSummary,
        };
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private buildContinuityBlock(
        keptMemories: import('../../../shared/cognitiveTurnTypes').MemoryContribution[],
        docResult: import('./CognitiveBudgetApplier').BudgetedDocResult,
    ): string {
        const parts: string[] = [];

        if (keptMemories.length > 0) {
            const memLines = keptMemories.map(m => `• [${m.category}] ${m.summary}`).join('\n');
            parts.push(`[Context]\n${memLines}`);
        }

        if (docResult.included && docResult.summary) {
            parts.push(`[Docs] ${docResult.summary}`);
        }

        return parts.join('\n\n');
    }

    private buildTaskBlock(
        normalizedInput: string,
        reflectionNotes: import('../../../shared/cognitiveTurnTypes').ReflectionBehavioralNote[],
    ): string {
        const parts: string[] = [];

        if (normalizedInput) {
            parts.push(`[Task] ${normalizedInput}`);
        }

        if (reflectionNotes.length > 0) {
            const noteLines = reflectionNotes
                .map(n => `• [${n.noteClass}] ${n.summary}`)
                .join('\n');
            parts.push(`[Behavioral notes]\n${noteLines}`);
        }

        return parts.join('\n\n');
    }
}

/** Module singleton. */
export const cognitiveContextCompactor = new CognitiveContextCompactor();
