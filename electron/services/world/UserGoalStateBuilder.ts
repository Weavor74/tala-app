/**
 * UserGoalStateBuilder — Phase 4A: World Model Foundation
 *
 * Builds UserGoalState for the TalaWorldModel.
 *
 * Responsibilities:
 *   - Derive the user's immediate task from the current turn.
 *   - Infer current project focus from recent turn summaries.
 *   - Carry stable high-level direction from profile/memory data.
 *   - Mark confidence and freshness for all inferred state.
 *
 * Design rules:
 *   - Explicit user goal statements always outrank inferred goal state.
 *   - Goal state is kept compact and action-oriented — no deep user psychology.
 *   - Stale goal state (no recent turns) is marked explicitly.
 *   - All outputs are safe for IPC serialization.
 */

import type {
    UserGoalState,
    UserGoalAssemblyInput,
    GoalStateConfidence,
    WorldModelSectionMeta,
    WorldModelAvailability,
} from '../../../shared/worldModelTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum characters to extract as the immediate task summary from the current turn.
 */
const MAX_IMMEDIATE_TASK_LENGTH = 120;

/**
 * Maximum characters for a project focus summary.
 */
const MAX_PROJECT_FOCUS_LENGTH = 80;

/**
 * Keywords that indicate an explicit goal statement in the user's turn text.
 */
const EXPLICIT_GOAL_KEYWORDS = [
    'my goal is',
    'i want to',
    'i need to',
    'i am working on',
    "i'm working on",
    'my task is',
    'i am trying to',
    "i'm trying to",
    'focus on',
    'help me with',
    'please help me',
];

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * UserGoalStateBuilder
 *
 * Produces a UserGoalState from the current turn text, recent turn summaries,
 * and optional profile-derived direction data.
 *
 * Explicit goal statements (detected by keyword matching) outrank all inferred state.
 * Stale state is marked explicitly when no recent turn data is available.
 */
export class UserGoalStateBuilder {
    /**
     * Builds a UserGoalState from the provided assembly input.
     *
     * @param input - Current turn text, recent summaries, and profile direction.
     * @returns UserGoalState suitable for inclusion in TalaWorldModel.
     */
    public build(input: UserGoalAssemblyInput): UserGoalState {
        const now = new Date().toISOString();
        const {
            currentTurnText,
            recentTurnSummaries = [],
            profileDirection,
            hasExplicitGoalStatement,
        } = input;

        let immediateTask: string | undefined;
        let immediateTaskConfidence: GoalStateConfidence = 'low';
        let currentProjectFocus: string | undefined;
        let projectFocusConfidence: GoalStateConfidence = 'low';
        let hasExplicitGoal = hasExplicitGoalStatement ?? false;
        let availability: WorldModelAvailability = 'unavailable';
        let isStale = true;

        // ── Immediate task from current turn ─────────────────────────────────
        if (currentTurnText && currentTurnText.trim().length > 0) {
            const detectedExplicit = this._hasExplicitGoalStatement(currentTurnText);
            if (detectedExplicit) hasExplicitGoal = true;

            immediateTask = this._summarizeTask(currentTurnText);
            immediateTaskConfidence = hasExplicitGoal ? 'high' : 'medium';
            isStale = false;
            availability = 'available';
        }

        // ── Project focus from recent turns ───────────────────────────────────
        if (recentTurnSummaries.length > 0) {
            currentProjectFocus = this._inferProjectFocus(recentTurnSummaries);
            projectFocusConfidence = 'medium';
            isStale = false;
            if (availability === 'unavailable') availability = 'partial';
        }

        // ── Stable direction from profile ─────────────────────────────────────
        const stableDirection = profileDirection?.trim() || undefined;

        // If only profile direction is available, we have partial state.
        if (!immediateTask && !currentProjectFocus && stableDirection) {
            availability = 'partial';
            isStale = false;
        }

        // If nothing is available.
        if (!immediateTask && !currentProjectFocus && !stableDirection) {
            availability = 'unavailable';
            isStale = true;
        }

        const meta: WorldModelSectionMeta = {
            assembledAt: now,
            freshness: isStale ? 'stale' : 'fresh',
            availability,
            degradedReason: isStale ? 'No recent turn data to infer goal state' : undefined,
        };

        return {
            meta,
            immediateTask,
            immediateTaskConfidence,
            currentProjectFocus,
            projectFocusConfidence,
            stableDirection,
            hasExplicitGoal,
            isStale,
            lastInferredAt: now,
        };
    }

    /**
     * Builds an empty/unavailable UserGoalState.
     */
    public buildUnavailable(reason?: string): UserGoalState {
        const now = new Date().toISOString();
        return {
            meta: {
                assembledAt: now,
                freshness: 'unknown',
                availability: 'unavailable',
                degradedReason: reason ?? 'No user context available',
            },
            immediateTaskConfidence: 'low',
            projectFocusConfidence: 'low',
            hasExplicitGoal: false,
            isStale: true,
        };
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _hasExplicitGoalStatement(text: string): boolean {
        const lower = text.toLowerCase();
        return EXPLICIT_GOAL_KEYWORDS.some((kw) => lower.includes(kw));
    }

    private _summarizeTask(text: string): string {
        // Trim to first sentence or max length — keep it compact.
        const trimmed = text.trim();
        const firstSentenceEnd = trimmed.search(/[.!?\n]/);
        const summary =
            firstSentenceEnd > 0 && firstSentenceEnd < MAX_IMMEDIATE_TASK_LENGTH
                ? trimmed.slice(0, firstSentenceEnd)
                : trimmed.slice(0, MAX_IMMEDIATE_TASK_LENGTH);
        return summary.trim();
    }

    private _inferProjectFocus(recentSummaries: string[]): string | undefined {
        if (recentSummaries.length === 0) return undefined;
        // Use the most recent summary — it's the most relevant project context.
        const recent = recentSummaries[0].trim();
        if (!recent) return undefined;
        return recent.slice(0, MAX_PROJECT_FOCUS_LENGTH).trim();
    }
}

/** Module-level singleton. */
export const userGoalStateBuilder = new UserGoalStateBuilder();
