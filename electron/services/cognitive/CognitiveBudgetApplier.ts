/**
 * Cognitive Budget Applier — Phase 3B: Small-Model Cognitive Compaction
 *
 * Applies per-profile category caps to memory, doc, and reflection contributions.
 *
 * Priority order (highest to lowest within each category):
 *   Memory: identity > task_relevant > recent_continuity > preference
 *   Docs: included only when applied=true and cap allows
 *   Reflection: sorted by confidence desc, dropped below threshold
 *
 * Explicit user facts (identity memories) always outrank recalled memory.
 * Low-confidence reflection notes are dropped first.
 * Docs are only included when materially relevant (applied=true).
 */

import type {
    MemoryContributionModel,
    MemoryContribution,
    DocContributionModel,
    ReflectionContributionModel,
    ReflectionBehavioralNote,
} from '../../../shared/cognitiveTurnTypes';
import type { CognitiveBudgetProfile } from '../../../shared/modelCapabilityTypes';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface BudgetedMemoryResult {
    kept: MemoryContribution[];
    dropped: MemoryContribution[];
    keptCount: number;
    droppedCount: number;
}

export interface BudgetedDocResult {
    included: boolean;
    summary: string;
    droppedReason?: string;
}

export interface BudgetedReflectionResult {
    kept: ReflectionBehavioralNote[];
    dropped: ReflectionBehavioralNote[];
    keptCount: number;
    droppedCount: number;
}

// ─── Memory category precedence ───────────────────────────────────────────────

const MEMORY_CATEGORY_ORDER: Array<import('../../../shared/cognitiveTurnTypes').MemoryContributionCategory> = [
    'identity',
    'task_relevant',
    'recent_continuity',
    'preference',
];

// ─── Applier ──────────────────────────────────────────────────────────────────

export class CognitiveBudgetApplier {
    /**
     * Applies category caps to memory contributions.
     * Identity memories are processed first (highest priority).
     * Preference memories are capped or dropped last.
     */
    public applyMemoryBudget(
        model: MemoryContributionModel,
        budget: CognitiveBudgetProfile,
    ): BudgetedMemoryResult {
        const caps: Record<string, number> = {
            identity: budget.identityMemoryCap,
            task_relevant: budget.taskMemoryCap,
            recent_continuity: budget.continuityMemoryCap,
            preference: budget.preferenceMemoryCap,
        };

        const kept: MemoryContribution[] = [];
        const dropped: MemoryContribution[] = [];

        // Group by category
        const grouped: Record<string, MemoryContribution[]> = {};
        for (const cat of MEMORY_CATEGORY_ORDER) {
            grouped[cat] = model.contributions
                .filter(c => c.category === cat)
                .sort((a, b) => b.salience - a.salience); // highest salience first
        }

        // Apply caps in priority order
        for (const cat of MEMORY_CATEGORY_ORDER) {
            const items = grouped[cat] ?? [];
            const cap = caps[cat] ?? 0;
            for (let i = 0; i < items.length; i++) {
                if (i < cap) {
                    kept.push(items[i]);
                } else {
                    dropped.push(items[i]);
                }
            }
        }

        return {
            kept,
            dropped,
            keptCount: kept.length,
            droppedCount: dropped.length,
        };
    }

    /**
     * Applies doc budget — suppresses docs unless applied=true and cap allows.
     */
    public applyDocBudget(
        model: DocContributionModel,
        budget: CognitiveBudgetProfile,
    ): BudgetedDocResult {
        if (!model.applied) {
            return {
                included: false,
                summary: '',
                droppedReason: 'Doc retrieval not applied for this turn.',
            };
        }

        if (budget.docChunkCap === 0) {
            return {
                included: false,
                summary: '',
                droppedReason: 'Doc budget cap is 0 for this profile.',
            };
        }

        if (budget.suppressDocsUnlessHighlyRelevant && model.sourceIds.length === 0) {
            return {
                included: false,
                summary: '',
                droppedReason: 'Docs suppressed: no high-relevance sources for this profile.',
            };
        }

        return {
            included: true,
            summary: model.summary ?? '',
        };
    }

    /**
     * Applies reflection note budget.
     * Suppressed notes are always excluded.
     * Remaining notes are sorted by confidence desc, then capped.
     */
    public applyReflectionBudget(
        model: ReflectionContributionModel,
        budget: CognitiveBudgetProfile,
    ): BudgetedReflectionResult {
        if (!model.applied) {
            return {
                kept: [],
                dropped: [...model.activeNotes],
                keptCount: 0,
                droppedCount: model.activeNotes.length,
            };
        }

        // Sort active notes by confidence descending (highest confidence first)
        const sorted = [...model.activeNotes]
            .filter(n => !n.suppressed)
            .sort((a, b) => b.confidence - a.confidence);

        const cap = budget.reflectionNoteCap;
        const kept = sorted.slice(0, cap);
        const dropped = sorted.slice(cap);

        // Also count suppressed notes as dropped
        const suppressedNotes = model.activeNotes.filter(n => n.suppressed);
        const allDropped = [...dropped, ...suppressedNotes];

        return {
            kept,
            dropped: allDropped,
            keptCount: kept.length,
            droppedCount: allDropped.length,
        };
    }
}

/** Module singleton. */
export const cognitiveBudgetApplier = new CognitiveBudgetApplier();
