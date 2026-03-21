/**
 * defaultMemoryPolicies.ts
 *
 * Canonical default MemoryPolicy definitions for the TALA context assembly layer.
 *
 * Three baseline policies are provided, one per GroundingMode:
 *   - DEFAULT_STRICT_POLICY       — strict evidence-only grounding, no graph traversal.
 *   - DEFAULT_GRAPH_ASSISTED_POLICY — evidence-first with future graph traversal enabled.
 *   - DEFAULT_EXPLORATORY_POLICY  — broader context window with multi-hop graph traversal.
 *
 * USAGE:
 *   MemoryPolicyService selects the appropriate base policy by groundingMode, then
 *   deep-merges any caller-supplied overrides from the ContextAssemblyRequest.
 *
 * NOTES:
 *   - These policies use 'global' scope by default. MemoryPolicyService overrides
 *     scope to 'notebook' when a notebookId is present in the request.
 *   - graph_assisted and exploratory policies have graphTraversal.enabled = true,
 *     but graph context items will remain empty until the graph runtime exists.
 *   - All policies set evidencePriority = true — evidence-first grounding is the TALA default.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { MemoryPolicy, AffectiveModulationPolicy } from '../../../shared/policy/memoryPolicyTypes';

// ─── Affective Modulation Defaults ────────────────────────────────────────────

/**
 * Affective modulation disabled.
 * Used by STRICT policy — no emotional/astro influence on any context assembly.
 */
const AFFECTIVE_STRICT: AffectiveModulationPolicy = {
  enabled: false,
  maxAffectiveNodes: 0,
  allowToneModulation: false,
  allowGraphOrderingInfluence: false,
  allowGraphExpansionInfluence: false,
  allowEvidenceReordering: false,
  affectiveWeight: 0,
  requireLabeling: true,
};

/**
 * Affective modulation for graph-assisted mode.
 * Emotional/astro state may lightly modulate graph_context ordering and tone
 * descriptor; evidence ordering and content are never affected.
 */
const AFFECTIVE_GRAPH_ASSISTED: AffectiveModulationPolicy = {
  enabled: true,
  maxAffectiveNodes: 2,
  allowToneModulation: true,
  allowGraphOrderingInfluence: true,
  allowGraphExpansionInfluence: false,
  allowEvidenceReordering: false,
  affectiveWeight: 0.1,
  requireLabeling: true,
};

/**
 * Affective modulation for exploratory mode.
 * Broader affective influence on graph_context ordering and optional expansion;
 * evidence ordering and content remain protected.
 */
const AFFECTIVE_EXPLORATORY: AffectiveModulationPolicy = {
  enabled: true,
  maxAffectiveNodes: 4,
  allowToneModulation: true,
  allowGraphOrderingInfluence: true,
  allowGraphExpansionInfluence: true,
  allowEvidenceReordering: false,
  affectiveWeight: 0.2,
  requireLabeling: true,
};

// ─── Strict ───────────────────────────────────────────────────────────────────

/**
 * Strict grounding policy.
 *
 * - Responses must be grounded in retrieved evidence.
 * - No graph traversal. Graph context items are never added.
 * - Conservative budgets to keep context tight.
 */
export const DEFAULT_STRICT_POLICY: MemoryPolicy = {
  groundingMode: 'strict',
  retrievalMode: 'hybrid',
  scope: 'global',
  graphTraversal: {
    enabled: false,
    maxHopDepth: 0,
    maxRelatedNodes: 0,
    maxNodesPerType: {},
  },
  contextBudget: {
    maxItems: 10,
    maxTokens: 4096,
    maxItemsPerClass: {
      evidence: 8,
      graph_context: 0,
      summary: 2,
      latent: 0,
    },
    evidencePriority: true,
  },
  affectiveModulation: AFFECTIVE_STRICT,
};

// ─── Graph-Assisted ───────────────────────────────────────────────────────────

/**
 * Graph-assisted grounding policy.
 *
 * - Evidence is primary; graph-linked context may supplement when available.
 * - graphTraversal.enabled = true but graph context items will be structurally
 *   empty until the graph runtime is available.
 * - Bounded traversal: maxHopDepth 1, minEdgeTrustLevel 'derived'.
 * - Moderate budgets; evidence-first.
 */
export const DEFAULT_GRAPH_ASSISTED_POLICY: MemoryPolicy = {
  groundingMode: 'graph_assisted',
  retrievalMode: 'hybrid',
  scope: 'global',
  graphTraversal: {
    enabled: true,
    maxHopDepth: 1,
    maxRelatedNodes: 10,
    maxNodesPerType: {
      entity: 4,
      topic: 4,
      document_chunk: 4,
    },
    minEdgeTrustLevel: 'derived',   // edges must be at least derived (rule-based) to traverse
    allowedEdgeTypes: ['supports', 'cites', 'related_to', 'mentions', 'about'],
  },
  contextBudget: {
    maxItems: 15,
    maxTokens: 6144,
    maxItemsPerClass: {
      evidence: 8,
      graph_context: 5,
      summary: 2,
      latent: 5,
    },
    evidencePriority: true,
  },
  affectiveModulation: AFFECTIVE_GRAPH_ASSISTED,
};

// ─── Exploratory ──────────────────────────────────────────────────────────────

/**
 * Exploratory grounding policy.
 *
 * - Broader context window; evidence is preferred but multi-hop graph traversal
 *   is allowed when the graph runtime is available.
 * - maxHopDepth 2, minEdgeTrustLevel 'inferred_low' — more permissive traversal.
 * - Larger budgets; still evidence-first.
 */
export const DEFAULT_EXPLORATORY_POLICY: MemoryPolicy = {
  groundingMode: 'exploratory',
  retrievalMode: 'hybrid',
  scope: 'global',
  graphTraversal: {
    enabled: true,
    maxHopDepth: 2,
    maxRelatedNodes: 20,
    maxNodesPerType: {
      entity: 6,
      topic: 6,
      document_chunk: 6,
    },
    minEdgeTrustLevel: 'inferred_low', // permissive: allow low-confidence inferred edges in exploratory mode
    allowedEdgeTypes: [
      'supports',
      'cites',
      'related_to',
      'mentions',
      'about',
      'derived_from',
      'references',
    ],
  },
  contextBudget: {
    maxItems: 20,
    maxTokens: 8192,
    maxItemsPerClass: {
      evidence: 10,
      graph_context: 8,
      summary: 4,
      latent: 8,
    },
    evidencePriority: true,
  },
  affectiveModulation: AFFECTIVE_EXPLORATORY,
};
