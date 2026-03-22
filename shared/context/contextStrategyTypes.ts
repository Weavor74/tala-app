/**
 * contextStrategyTypes.ts — P7E Adaptive Context Strategy shared contracts
 *
 * Defines the types for the deterministic strategy layer that adapts
 * context assembly behavior based on task, mode, or intent.
 *
 * This layer sits above the deterministic pipeline and influences:
 *   - Context layer budget allocations (item/token counts)
 *   - Source weighting modifiers (multipliers on base source weights)
 *   - Policy toggles (expansion control, truncation preferences)
 *
 * Pure TypeScript — no Node.js APIs.
 */

import type { ContextLayerName } from './contextDeterminismTypes';

/**
 * High-level adaptive strategy modes.
 *
 * These represent the "intent" of the assembly pass.
 */
export type ContextStrategyMode =
  | 'balanced'             // Default; follow base policy precisely
  | 'recall_strict'        // Prioritize canonical floor and higher-authority sources
  | 'recall_exploratory'   // Expand budget for derived/speculative sources
  | 'evidence_first'       // Maximize RAG budget; sacrifice conversation history
  | 'graph_exploratory'    // Prioritize graph traversal and depth over semantic similarity
  | 'conversation_continuity' // Prioritize recent turns and session history
  | 'task_execution'       // Maximize task state and current notebook context
  | 'diagnostic_trace';    // Balanced but include full metadata and latent candidates

/**
 * Budget adjustment for a specific context layer.
 *
 * Modifier values are additive/relative to the base policy budget.
 */
export interface StrategyBudgetAdjustment {
  layer: ContextLayerName;
  /** Additive modifier for maxItems (e.g. +2, -1). Final value clamped to [0, MAX]. */
  maxItemsMod?: number;
  /** Additive modifier for maxTokens (approximate). */
  maxTokensMod?: number;
}

/**
 * Weight multiplier for a specific source layer.
 *
 * Applied to the base SOURCE_WEIGHT in ContextScoringService.
 */
export interface StrategyWeightAdjustment {
  sourceLayer: string; // rag, graph, mem0, task, etc.
  /** Multiplier for the base source weight (e.g. 1.2, 0.8). Clamped to [0.1, 2.0]. */
  multiplier: number;
}

/**
 * Immutable strategy profile defining the behavior of a specific mode.
 */
export interface ContextStrategyProfile {
  mode: ContextStrategyMode;
  /** High-level description of when this profile is active. */
  description: string;
  /** Budget overrides for specific layers. */
  budgetAdjustments: StrategyBudgetAdjustment[];
  /** Weight multipliers for specific source layers. */
  weightAdjustments: StrategyWeightAdjustment[];
  /** Optional policy flag overrides (e.g. enable graph weighting). */
  policyOverrides?: Record<string, boolean | number | string>;
}

/**
 * Output of the ContextStrategyResolver.
 *
 * Traceable result of strategy selection for diagnostics.
 */
export interface ContextStrategyResolution {
  /** The selected strategy profile. */
  profile: ContextStrategyProfile;
  /** Reasons why this profile was selected (e.g. policy.groundingMode === 'strict'). */
  selectionReasons: string[];
  /** The final calculated adjustments (after applying profiles). */
  appliedBudgetAdjustments: Record<ContextLayerName, StrategyBudgetAdjustment>;
  /** The final calculated weight multipliers. */
  appliedWeightMultipliers: Record<string, number>;
}
