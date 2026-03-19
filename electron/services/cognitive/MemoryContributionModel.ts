/**
 * Memory Contribution Model — Phase 3: Cognitive Loop (Objective B)
 *
 * Implements structured memory categorization and influence policy for Tala's
 * cognitive loop. Memory is identity-bearing context, not just retrieval snippets.
 *
 * Memory categories:
 * - identity: stable user identity facts (name, persistent preferences)
 * - task_relevant: memories directly relevant to the current query/task
 * - preference: user behavioral tendencies and expressed preferences
 * - recent_continuity: recent session context and conversational continuity
 *
 * Influence policy:
 * - identity memories may shape tone AND provide factual recall
 * - task_relevant memories may shape behavior AND provide factual recall
 * - preference memories may shape tone and style
 * - recent_continuity memories provide factual recall and session coherence
 *
 * Memory writes remain policy-based:
 * - RP mode: no writes
 * - Assistant mode task/technical: long_term
 * - Assistant mode default: short_term
 * - Hybrid mode: short_term
 * - Explicit user facts never overridden by inferred memory
 */

import type { MemoryItem } from '../MemoryService';
import type { Mode } from '../router/ModePolicyEngine';
import type {
    MemoryContribution,
    MemoryContributionCategory,
    MemoryContributionModel,
} from '../../../shared/cognitiveTurnTypes';

// ─── Memory influence policy ───────────────────────────────────────────────────

/**
 * Influence scope per memory category.
 * Governs what aspects of behavior each category may affect.
 */
const INFLUENCE_SCOPE_BY_CATEGORY: Record<
    MemoryContributionCategory,
    Array<'tone' | 'task' | 'identity' | 'style'>
> = {
    identity: ['tone', 'identity'],
    task_relevant: ['task', 'tone'],
    preference: ['tone', 'style'],
    recent_continuity: ['task'],
};

/**
 * Minimum salience threshold for each category.
 * Memories below this threshold are excluded to prevent noise.
 */
const MIN_SALIENCE_BY_CATEGORY: Record<MemoryContributionCategory, number> = {
    identity: 0.3,       // Identity memories are high-value even at lower salience
    task_relevant: 0.4,
    preference: 0.4,
    recent_continuity: 0.2, // Recent context matters even at low salience
};

/**
 * Maximum contributions per category per turn.
 * Prevents flooding the prompt with flat memory dumps.
 */
const MAX_CONTRIBUTIONS_BY_CATEGORY: Record<MemoryContributionCategory, number> = {
    identity: 3,
    task_relevant: 5,
    preference: 3,
    recent_continuity: 3,
};

/** Maximum length for memory contribution summaries (characters). */
const MAX_MEMORY_SUMMARY_LENGTH = 200;

// ─── Category detection ────────────────────────────────────────────────────────

/**
 * Classifies a MemoryItem into a contribution category based on its metadata.
 * Falls back to heuristic type/role matching when explicit metadata is absent.
 */
function classifyMemoryCategory(memory: MemoryItem): MemoryContributionCategory {
    const type = memory.metadata?.type as string | undefined;
    const role = memory.metadata?.role as string | undefined;
    const tags = (memory.metadata?.tags as string[] | undefined) ?? [];

    // Explicit category annotation takes precedence
    if (type === 'user_profile' || type === 'identity' || tags.includes('identity')) {
        return 'identity';
    }
    if (type === 'user_preference' || tags.includes('preference')) {
        return 'preference';
    }
    if (type === 'session' || type === 'recent' || tags.includes('recent') || role === 'session') {
        return 'recent_continuity';
    }
    if (
        type === 'technical' ||
        type === 'task_state' ||
        type === 'factual' ||
        type === 'lore' ||
        type === 'autobiographical' ||
        type === 'roleplay_scene' ||
        tags.includes('task')
    ) {
        return 'task_relevant';
    }

    // Default: treat as task_relevant (most conservative)
    return 'task_relevant';
}

/**
 * Generates a human-readable rationale for including a memory contribution.
 */
function buildRationale(memory: MemoryItem, category: MemoryContributionCategory): string {
    const source = memory.metadata?.source as string | undefined;
    const salience = memory.metadata?.salience as number | undefined;
    const confidence = memory.metadata?.confidence as number | undefined;

    const parts: string[] = [`Category: ${category}`];
    if (source) parts.push(`source: ${source}`);
    if (salience !== undefined) parts.push(`salience: ${salience.toFixed(2)}`);
    if (confidence !== undefined) parts.push(`confidence: ${confidence.toFixed(2)}`);
    return parts.join(', ');
}

// ─── MemoryContributionBuilder ────────────────────────────────────────────────

/**
 * Builds the structured MemoryContributionModel for a cognitive turn.
 *
 * This is the authoritative path for converting filtered MemoryItems into
 * structured cognitive contributions with category, influence scope, and rationale.
 */
export class MemoryContributionBuilder {
    /**
     * Builds a MemoryContributionModel from a list of approved (post-filter) memory items.
     *
     * @param approvedMemories - Memories that passed MemoryFilter and contradiction resolution.
     * @param candidateCount - Total candidates before filtering (for diagnostics).
     * @param excludedCount - Memories excluded by policy (for diagnostics).
     * @param retrievalSuppressed - Whether retrieval was suppressed for this turn.
     * @param suppressionReason - Human-readable reason for suppression.
     * @param mode - Active cognitive mode (influences max contributions and filtering).
     */
    public static build(
        approvedMemories: MemoryItem[],
        candidateCount: number,
        excludedCount: number,
        retrievalSuppressed: boolean,
        suppressionReason?: string,
        mode: Mode = 'assistant',
    ): MemoryContributionModel {
        const now = new Date().toISOString();

        if (retrievalSuppressed || approvedMemories.length === 0) {
            return {
                contributions: [],
                candidateCount,
                excludedCount,
                retrievalSuppressed,
                suppressionReason,
                retrievedAt: now,
            };
        }

        // Sort: explicit user facts always first, then by salience * confidence
        // Explicit facts receive a large priority boost to guarantee they outrank any inferred memory.
        const sorted = [...approvedMemories].sort((a, b) => {
            const scoreOf = (m: MemoryItem): number => {
                const salience = (m.metadata?.salience as number | undefined) ?? 0.5;
                const confidence = (m.metadata?.confidence as number | undefined) ?? 0.5;
                // Explicit user facts receive a strong priority boost (Phase 3C)
                const explicitBoost = m.metadata?.source === 'explicit' ? 1.0 : 0;
                return salience * confidence + explicitBoost;
            };
            return scoreOf(b) - scoreOf(a);
        });

        // Build contributions, respecting per-category limits
        const contributions: MemoryContribution[] = [];
        const categoryCounts: Partial<Record<MemoryContributionCategory, number>> = {};

        for (const memory of sorted) {
            const category = classifyMemoryCategory(memory);
            const currentCount = categoryCounts[category] ?? 0;
            const maxForCategory = this.getMaxContributions(category, mode);
            const minSalience = MIN_SALIENCE_BY_CATEGORY[category];
            const salience = (memory.metadata?.salience as number | undefined) ?? 0.5;
            const isExplicit = memory.metadata?.source === 'explicit';
            const confidence = (memory.metadata?.confidence as number | undefined) ?? 0.5;

            // Skip if category is at capacity
            if (currentCount >= maxForCategory) continue;

            // Skip low-confidence inferred memories — explicit facts bypass this check (Phase 3C)
            if (!isExplicit && confidence < 0.3) continue;

            // Skip if salience below threshold — explicit facts bypass salience filtering
            if (!isExplicit && salience < minSalience) continue;

            const overrides = isExplicit ? this.findOverriddenInferredMemory(memory, sorted) : undefined;

            contributions.push({
                memoryId: memory.id,
                category,
                summary: memory.text.slice(0, MAX_MEMORY_SUMMARY_LENGTH),
                rationale: buildRationale(memory, category),
                influenceScope: INFLUENCE_SCOPE_BY_CATEGORY[category],
                salience,
                ...(overrides ? { overrides } : {}),
            });

            categoryCounts[category] = currentCount + 1;
        }

        return {
            contributions,
            candidateCount,
            excludedCount,
            retrievalSuppressed: false,
            retrievedAt: now,
        };
    }

    /**
     * Finds the first inferred memory (same category, not explicit) that an explicit
     * memory overrides. Used for diagnostics/attribution only.
     */
    private static findOverriddenInferredMemory(
        explicitMemory: MemoryItem,
        allMemories: MemoryItem[],
    ): string | undefined {
        const explicitCategory = classifyMemoryCategory(explicitMemory);
        const inferred = allMemories.find(
            m =>
                m.id !== explicitMemory.id &&
                m.metadata?.source !== 'explicit' &&
                classifyMemoryCategory(m) === explicitCategory,
        );
        return inferred?.id;
    }

    /**
     * Returns the maximum number of contributions allowed for a category in a given mode.
     * RP mode has stricter limits than assistant mode.
     */
    private static getMaxContributions(
        category: MemoryContributionCategory,
        mode: Mode,
    ): number {
        const base = MAX_CONTRIBUTIONS_BY_CATEGORY[category];
        if (mode === 'rp') {
            // RP mode limits task/identity bleed-in
            if (category === 'task_relevant') return 2;
            if (category === 'identity') return 1;
        }
        return base;
    }

    /**
     * Returns the resolved memory write policy for a turn.
     * Explicit user facts must not be overridden by inferred memory.
     *
     * @param mode - Active mode.
     * @param intentClass - Classified intent for this turn.
     * @param isGreeting - Whether this turn is a greeting.
     */
    public static resolveWritePolicy(
        mode: Mode,
        intentClass: string,
        isGreeting: boolean,
    ): { policy: string; reason: string } {
        if (mode === 'rp') {
            return { policy: 'do_not_write', reason: 'RP mode isolation prohibits memory writes' };
        }
        if (isGreeting || intentClass === 'greeting') {
            return { policy: 'do_not_write', reason: 'Greeting turns carry no persistent content' };
        }
        if (mode === 'hybrid') {
            return { policy: 'short_term', reason: 'Hybrid mode uses short-term persistence by default' };
        }
        if (mode === 'assistant') {
            if (['technical', 'coding', 'planning', 'task_state'].includes(intentClass)) {
                return {
                    policy: 'long_term',
                    reason: `Technical/${intentClass} intent warrants long-term retention`,
                };
            }
            return { policy: 'short_term', reason: 'Assistant mode default: short-term retention' };
        }
        return { policy: 'short_term', reason: 'Default write policy' };
    }
}
