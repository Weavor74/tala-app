/**
 * ContextStrategyResolver.ts — P7E Deterministic Strategy Selection
 *
 * Implements the deterministic layer that selects an adaptive strategy profile
 * based on explicit, observable signals from the context assembly request.
 *
 * Rationale:
 *   Adaptation must be explainable and reproducible. This service uses
 *   static mapping logic (policy flags -> profile) to ensure that the same
 *   request always results in the same strategy selection.
 *
 * Safety Guardrails:
 *   - No LLM/fuzzy logic in selection.
 *   - Budget adjustments are additive and clamped.
 *   - Weight multipliers are bounded to prevent extreme ranking shifts.
 */

import type { MemoryPolicy } from '../../../shared/policy/memoryPolicyTypes';
import type { ContextLayerName } from '../../../shared/context/contextDeterminismTypes';
import {
  ContextStrategyMode,
  ContextStrategyProfile,
  ContextStrategyResolution,
  StrategyBudgetAdjustment,
} from '../../../shared/context/contextStrategyTypes';

/**
 * Static strategy profiles defining the behavior of each mode.
 */
const STRATEGY_PROFILES: Record<ContextStrategyMode, ContextStrategyProfile> = {
  balanced: {
    mode: 'balanced',
    description: 'Default balanced strategy; follows base policy.',
    budgetAdjustments: [],
    weightAdjustments: [],
  },
  recall_strict: {
    mode: 'recall_strict',
    description: 'Prioritizes canonical floor and higher-authority sources.',
    budgetAdjustments: [
      { layer: 'canonical_memory', maxItemsMod: 2 },
      { layer: 'evidence', maxItemsMod: -1 }, // Squeeze evidence to favor canonical
    ],
    weightAdjustments: [
      { sourceLayer: 'canonical_memory', multiplier: 1.2 },
      { sourceLayer: 'rag', multiplier: 0.8 },
    ],
  },
  recall_exploratory: {
    mode: 'recall_exploratory',
    description: 'Expands budget for derived/speculative sources.',
    budgetAdjustments: [
      { layer: 'evidence', maxItemsMod: 5 },
      { layer: 'graph_context', maxItemsMod: 3 },
    ],
    weightAdjustments: [
      { sourceLayer: 'mem0', multiplier: 1.1 },
      { sourceLayer: 'graph', multiplier: 1.1 },
    ],
  },
  evidence_first: {
    mode: 'evidence_first',
    description: 'Maximizes RAG budget; sacrifices conversation history.',
    budgetAdjustments: [
      { layer: 'evidence', maxItemsMod: 10 },
      { layer: 'conversation', maxItemsMod: -2 },
    ],
    weightAdjustments: [
      { sourceLayer: 'rag', multiplier: 1.5 },
      { sourceLayer: 'conversation', multiplier: 0.75 },
    ],
  },
  graph_exploratory: {
    mode: 'graph_exploratory',
    description: 'Prioritizes graph traversal and depth over semantic similarity.',
    budgetAdjustments: [
      { layer: 'graph_context', maxItemsMod: 10 },
    ],
    weightAdjustments: [
      { sourceLayer: 'graph', multiplier: 1.5 },
      { sourceLayer: 'rag', multiplier: 0.9 },
    ],
    policyOverrides: {
      enableGraphWeighting: true,
    },
  },
  conversation_continuity: {
    mode: 'conversation_continuity',
    description: 'Prioritize recent turns and session history.',
    budgetAdjustments: [
      { layer: 'conversation', maxItemsMod: 5 },
    ],
    weightAdjustments: [
      { sourceLayer: 'conversation', multiplier: 1.3 },
    ],
  },
  task_execution: {
    mode: 'task_execution',
    description: 'Maximize task state and current notebook context.',
    budgetAdjustments: [
      { layer: 'task_state', maxItemsMod: 5 },
      { layer: 'canonical_memory', maxItemsMod: 2 },
    ],
    weightAdjustments: [
      { sourceLayer: 'task', multiplier: 1.5 },
    ],
  },
  diagnostic_trace: {
    mode: 'diagnostic_trace',
    description: 'Balanced but include full metadata and latent candidates.',
    budgetAdjustments: [],
    weightAdjustments: [],
    policyOverrides: {
      emitFullTrace: true,
    },
  },
};

export class ContextStrategyResolver {
  /**
   * Resolve the active strategy profile based on policy signals.
   *
   * @param policy The active MemoryPolicy for the assembly pass.
   */
  resolveContextStrategy(policy: MemoryPolicy): ContextStrategyResolution {
    const reasons: string[] = [];
    let selectedMode: ContextStrategyMode = 'balanced';

    // ─── 1. Resolve Mode from Grounding Mode ─────────────────────────────────
    if (policy.groundingMode === 'strict') {
      selectedMode = 'recall_strict';
      reasons.push("policy.groundingMode === 'strict'");
    } else if (policy.groundingMode === 'exploratory') {
      selectedMode = 'recall_exploratory';
      reasons.push("policy.groundingMode === 'exploratory'");
    }

    // ─── 2. Refine Mode from Retrieval Mode (Subordinate to Grounding) ────────
    if (selectedMode === 'balanced') {
      if (policy.retrievalMode === 'hybrid') {
        selectedMode = 'balanced'; // Keep default for hybrid
      } else if (policy.retrievalMode === 'keyword') {
        selectedMode = 'recall_strict';
        reasons.push("policy.retrievalMode === 'keyword'");
      } else if (policy.retrievalMode === 'graph') {
        selectedMode = 'graph_exploratory';
        reasons.push("policy.retrievalMode === 'graph'");
      }
    }

    // ─── 3. Refine Mode from Scope ───────────────────────────────────────────
    if (policy.scope === 'notebook') {
      // task_execution is prioritized over graph_exploratory/exploratory for notebooks
      if (selectedMode === 'balanced' || selectedMode === 'graph_exploratory' || selectedMode === 'recall_exploratory') {
        selectedMode = 'task_execution';
        reasons.push("policy.scope === 'notebook' (prioritized)");
      }
    }

    const profile = STRATEGY_PROFILES[selectedMode] || STRATEGY_PROFILES.balanced;
    
    // Map adjustments into record for easy consumption
    const appliedBudgetAdjustments: Record<ContextLayerName, StrategyBudgetAdjustment> = {} as any;
    profile.budgetAdjustments.forEach(adj => {
      appliedBudgetAdjustments[adj.layer] = adj;
    });

    const appliedWeightMultipliers: Record<string, number> = {};
    profile.weightAdjustments.forEach(adj => {
      appliedWeightMultipliers[adj.sourceLayer] = adj.multiplier;
    });

    return {
      profile,
      selectionReasons: reasons,
      appliedBudgetAdjustments,
      appliedWeightMultipliers,
    };
  }
}
