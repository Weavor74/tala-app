/**
 * contextDeterminismTypes.ts — P7B Context Determinism shared contracts
 *
 * Defines the types that make context assembly deterministic, explainable,
 * and reproducible. These types support:
 *
 *   A. Fixed token budgets per context layer (ContextLayerName, ContextLayerBudget)
 *   B. Deterministic scoring formulas (ScoreBreakdown, ContextCandidate, RankedContextCandidate)
 *   C. Traceable inclusion/exclusion (ContextDecision, ContextDecisionReason)
 *   D. Context assembly diagnostics (ContextAssemblyDiagnostics)
 *   E. Explicit tie-breaking (TieBreakRecord)
 *   F. Conflict resolution records (ConflictResolutionRecord)
 *
 * IMPORT CONSTRAINTS:
 *   This module imports ONLY from shared/memory/authorityTypes.ts.
 *   It does NOT import from memoryPolicyTypes.ts to avoid circular dependencies.
 *   Fields that would reference memoryPolicyTypes unions use string types with
 *   explicit documentation of the valid values.
 *
 * Pure TypeScript — no Node.js APIs. Compiled by both tsconfig targets.
 */

import type { MemoryAuthorityTier } from '../memory/authorityTypes';

// ─── A. Context Layer Budgets ────────────────────────────────────────────────

/**
 * Named context layers in the assembly pipeline.
 *
 * Priority order (descending — higher priority filled first):
 *   system > canonical_memory > evidence > graph_context > conversation > task_state > policy_block
 */
export type ContextLayerName =
  | 'system'           // System/core instructions
  | 'conversation'     // Recent conversation history
  | 'canonical_memory' // Canonical memory items from the authority layer
  | 'graph_context'    // Graph-derived structural + affective context
  | 'evidence'         // Retrieved evidence / RAG
  | 'task_state'       // Current task state
  | 'policy_block';    // Mode/policy blocks

/**
 * Per-layer token and item budget.
 *
 * Each layer has an explicit budget. The assembler fills higher-priority layers
 * first (lower priority number = filled first). Overflow is handled according
 * to overflowPolicy.
 */
export interface ContextLayerBudget {
  /** The layer this budget governs. */
  layer: ContextLayerName;

  /** Maximum number of items this layer may contribute. */
  maxItems: number;

  /**
   * Optional soft token cap for this layer.
   * When set, the assembler stops adding items once the layer's estimated
   * token count reaches this value. Token estimation is approximate (4 chars/token).
   */
  maxTokens?: number;

  /**
   * Fill priority. Lower number = higher priority (filled first).
   * Must be unique per layer in a given budget configuration.
   */
  priority: number;

  /**
   * What to do when this layer's budget is exceeded:
   * - 'truncate'           — include partial content to fit budget
   * - 'overflow_to_latent' — move over-budget items to latent class
   * - 'drop'               — silently exclude (decision record still created)
   */
  overflowPolicy: 'truncate' | 'overflow_to_latent' | 'drop';

  /**
   * When true, this layer may borrow unused budget from lower-priority layers.
   * Borrowing is only applied after all lower-priority layers have been filled.
   * Defaults to false.
   */
  canBorrow?: boolean;
}

// ─── B. Scoring ──────────────────────────────────────────────────────────────

/**
 * Full deterministic score breakdown for a context candidate.
 *
 * Each component is explicit, numeric, and independently testable.
 * No LLM/ML scoring — all values derived from deterministic formulas.
 *
 * finalScore is the weighted composite of all components.
 * normalizedScore is the cross-layer normalized score used for ranking
 * (P7D Feed 2: finalScore × sourceWeight × tokenEfficiency).
 */
export interface ScoreBreakdown {
  /** Base semantic/retrieval similarity score [0, 1]. Comes from retrieval provider. */
  semanticScore: number;

  /**
   * Recency score [0, 1].
   * Items with a newer timestamp score higher.
   * Items with no timestamp receive 0.5 (neutral).
   */
  recencyScore: number;

  /**
   * Authority tier weight [0, 1].
   * Maps MemoryAuthorityTier to numeric weight:
   *   canonical: 1.0, verified_derived: 0.75, transient: 0.25, speculative: 0.0
   * Null-tier (no authority info) maps to 0.5 (neutral).
   */
  authorityScore: number;

  /**
   * Source-type weight [0, 1].
   * P7D Feed 2: Derived from the candidate's sourceLayer using SOURCE_WEIGHT constants.
   * Prevents any single source type from dominating cross-layer ranking.
   * Examples: canonical_memory=1.0, conversation=0.95, mem0=0.9, graph=0.85, rag=0.8.
   * Falls back to 1.0 when sourceLayer is absent or unknown.
   * Also used as a component weight within the finalScore weighted sum.
   */
  sourceWeight: number;

  /**
   * Graph depth penalty [-0.5, 0].
   * Applied to graph_context items to prefer closer evidence nodes.
   * Penalty = -(hopDepth × GRAPH_DEPTH_PENALTY_PER_HOP).
   * Direct evidence (no hops) receives 0.
   */
  graphDepthPenalty: number;

  /**
   * Affective adjustment [0, MAX_AFFECTIVE_BOOST].
   * Bounded keyword-overlap boost applied to structural graph_context items
   * when allowGraphOrderingInfluence is true.
   * Hard-capped per policy to prevent affective signals from dominating.
   */
  affectiveAdjustment: number;

  /**
   * Final composite score (base score).
   * Computed as the weighted sum of all components above.
   * Range approximately [−0.25, 1.0] depending on component values.
   * Use normalizedScore for cross-layer ranking (P7D Feed 2).
   */
  finalScore: number;

  /**
   * P7D Feed 2: Token efficiency factor [0, 1].
   * Penalizes high token-cost candidates to maximise context diversity.
   * Formula: 1 / (1 + estimatedTokens × TOKEN_PENALTY_FACTOR).
   * Higher token counts yield lower efficiency scores.
   */
  tokenEfficiency: number;

  /**
   * P7D Feed 2: Cross-layer normalized score.
   * The primary ranking signal for cross-layer comparison.
   * Formula: finalScore × sourceWeight × tokenEfficiency.
   * Prevents any source type from dominating due to scale or bias.
   * Range approximately [0, 1.0].
   */
  normalizedScore: number;
}

/**
 * A context candidate normalized for the assembly pipeline.
 *
 * Used as the internal working type during context assembly.
 * Carries all fields needed for scoring, ranking, and decision-making.
 */
export interface ContextCandidate {
  /**
   * Stable candidate identifier.
   * Typically derived from NormalizedSearchResult.itemKey or a graph node ID.
   * Used as final tie-break key — must be unique within an assembly pass.
   */
  id: string;

  /** The content to include in the prompt context block. */
  content: string;

  /** Human-readable title or heading. */
  title?: string;

  /** Canonical URI of the source document or node. */
  uri?: string;

  /** Source category (e.g. 'notebook_item', 'graph_node', 'document_chunk'). */
  sourceType?: string;

  /** Stable source key from the originating retrieval result. */
  sourceKey?: string;

  /**
   * MemorySelectionClass value as a string to avoid circular imports.
   * Valid values: 'evidence' | 'graph_context' | 'summary' | 'latent'
   */
  selectionClass: string;

  /** Assigned context layer for this candidate. */
  layerAssignment: ContextLayerName;

  /** Estimated token cost for this candidate (4 chars/token heuristic). */
  estimatedTokens: number;

  /**
   * Raw retrieval score from the originating provider.
   * May be null for graph_context and latent items without a retrieval score.
   */
  score?: number | null;

  /**
   * Authority tier assigned to this candidate.
   * Null when no authority information is available (treated as neutral in scoring).
   */
  authorityTier: MemoryAuthorityTier | null;

  /**
   * ISO-8601 timestamp of the source record.
   * Used for recency scoring. Null or absent items receive neutral recency score.
   */
  timestamp?: string | null;

  /**
   * Number of graph hops from the evidence seed to this node.
   * 0 for direct evidence. Affects graphDepthPenalty in scoring.
   * Only meaningful for graph_context candidates.
   */
  graphHopDepth?: number;

  /**
   * GraphEdgeType value as a string to avoid circular imports.
   * Valid values: see GraphEdgeType union in memoryPolicyTypes.ts.
   */
  graphEdgeType?: string | null;

  /**
   * EdgeTrustLevel value as a string to avoid circular imports.
   * Valid values: 'canonical' | 'explicit' | 'derived' | 'inferred_high' | 'inferred_low' | 'session_only'
   */
  graphEdgeTrust?: string | null;

  /** Preserved metadata from the originating item. */
  metadata?: Record<string, unknown>;

  // ─── P7D: Unified Candidate Arena ──────────────────────────────────────────

  /**
   * P7D: Source layer this candidate originated from.
   * Carries context-source provenance for the unified candidate arena.
   * Examples: 'rag', 'graph', 'canonical_memory', 'mem0', 'conversation', 'task'
   */
  sourceLayer?: string;

  /**
   * P7D: True when this candidate has canonical memory authority tier.
   * Convenience flag derived from authorityTier === 'canonical'.
   */
  isCanonical?: boolean;

  /**
   * P7D: Optional reference to the canonical record this candidate is derived from
   * or the canonical source of this candidate's information.
   */
  canonicalId?: string;
}

/**
 * A context candidate that has been scored and ranked.
 *
 * Produced by the scoring pipeline after computing ScoreBreakdown
 * and sorting with the total-order comparator.
 */
export interface RankedContextCandidate extends ContextCandidate {
  /** Full deterministic score breakdown for this candidate. */
  scoreBreakdown: ScoreBreakdown;

  /** 1-indexed rank within the candidate's layer. Lower rank = higher priority. */
  rank: number;

  /**
   * P7C: Affective weighting reason code, when AffectiveWeightingService was
   * invoked for this candidate. See AffectiveReasonCode in affectiveWeightingTypes.ts
   * for valid values. Null when affective weighting was not applied.
   */
  affectiveReasonCode?: string | null;
}

// ─── C. Traceable Inclusion / Exclusion ──────────────────────────────────────

/**
 * Reason codes for context inclusion, exclusion, or truncation decisions.
 *
 * Every candidate considered during assembly must produce one or more
 * reason codes explaining why it was included, excluded, or truncated.
 */
export type ContextDecisionReason =
  // ── Inclusion reasons ──────────────────────────────────────────────────────
  /** Item included because it has canonical authority tier. */
  | 'included.high_authority'
  /** Item included as top-ranked within the available budget. */
  | 'included.top_ranked_within_budget'
  /** Item included because it is canonical memory (P7A authority lock). */
  | 'included.canonical_memory_priority'
  // ── Exclusion reasons ──────────────────────────────────────────────────────
  /** Item excluded because the layer's item or token budget was exhausted. */
  | 'excluded.layer_budget_exceeded'
  /** Item excluded because a canonical memory item outranked it. */
  | 'excluded.lower_rank_than_canonical'
  /** Item excluded because it lost a deterministic tie-break. */
  | 'excluded.tie_break_lost'
  /** Item excluded because its score fell below the minimum threshold. */
  | 'excluded.below_min_score'
  /** Item excluded because it lost a canonical-vs-derived authority conflict resolution. */
  | 'excluded.authority_conflict_lost'
  // ── Per-document cap ───────────────────────────────────────────────────────
  /** Item excluded because the per-document chunk cap was already reached. */
  | 'excluded.per_document_cap'
  // ── Truncation reasons ─────────────────────────────────────────────────────
  /** Item content was truncated to fit within the layer's token budget. */
  | 'truncated.to_fit_budget'
  // ── Overflow / latent ──────────────────────────────────────────────────────
  /** Item moved to the latent class because evidence budget was exhausted. */
  | 'overflow.to_latent'
  // ── P7D Feed 3: Cross-layer competitive selection ─────────────────────────
  /** Item included as the cross-layer top-ranked candidate within the global budget. */
  | 'included.cross_layer_top_rank'
  /** Item excluded because the global item or token budget was exhausted. */
  | 'excluded.cross_layer_budget_exceeded'
  /** Item excluded because higher-ranked candidates consumed the available global budget. */
  | 'excluded.outcompeted_by_higher_rank'
  // ── P7D Feed 4: Cross-layer authority enforcement ─────────────────────────
  /** Derived item excluded because a canonical candidate with the same canonicalId was selected. */
  | 'excluded.superseded_by_canonical'
  /** Derived item included as supporting context alongside or in place of its canonical counterpart. */
  | 'included.supporting_derived'
  /** Item excluded because a higher-authority-layer candidate for the same canonicalId won the conflict. */
  | 'excluded.authority_conflict';

/**
 * Decision record for a single context candidate.
 *
 * Every candidate that enters the assembly pipeline must produce a decision
 * record — no candidate may disappear without explanation.
 */
export interface ContextDecision {
  /** Stable candidate ID that this decision refers to. */
  candidateId: string;

  /** Source category of this candidate. */
  sourceType?: string;

  /** Authority tier of this candidate at decision time. */
  authorityTier: MemoryAuthorityTier | null;

  /** Final composite score at the time the decision was made. */
  finalScore: number;

  /** Estimated token cost of this candidate. */
  estimatedTokens: number;

  /** Outcome of the decision. */
  status: 'included' | 'excluded' | 'truncated' | 'latent';

  /** Layer this candidate was assigned to. */
  layerAssignment: ContextLayerName;

  /** One or more reason codes explaining this decision. */
  reasons: ContextDecisionReason[];

  /** True when a tie-break comparator was invoked to settle equal scores. */
  tieBreakApplied?: boolean;

  /** When tieBreakApplied is true: true if this candidate won the tie-break. */
  tieBreakWinner?: boolean;

  /**
   * True when this candidate was involved in a canonical-vs-derived conflict
   * and the conflict was resolved in its favour or against it.
   */
  conflictResolved?: boolean;

  /**
   * P7C: Non-zero when affective weighting influenced this candidate's finalScore.
   * Mirrors ScoreBreakdown.affectiveAdjustment. Included here for convenience
   * so diagnostic consumers do not need to walk candidatePoolByLayer.
   * Null or absent when affective weighting was not applied.
   */
  affectiveAdjustment?: number | null;

  /**
   * P7C: Affective weighting reason code explaining why the adjustment was
   * applied or skipped. See AffectiveReasonCode in affectiveWeightingTypes.ts.
   * Null when affective weighting was not invoked for this candidate.
   */
  affectiveReasonCode?: string | null;
}

// ─── E. Tie-Break Records ─────────────────────────────────────────────────────

/**
 * Records a tie-break event that occurred during ranking.
 *
 * Produced whenever two or more candidates had equal scores at one or more
 * stages of the total-order comparator.
 */
export interface TieBreakRecord {
  /** IDs of all candidates involved in the tie at this stage. */
  candidateIds: string[];

  /** The score value at which the tie occurred. */
  tiedScore: number;

  /** The candidate ID that won the tie-break. */
  winnerCandidateId: string;

  /**
   * Human-readable description of the tie-break criterion that was applied.
   * Example: "token_cost:asc", "timestamp:desc", "lexical_id:asc"
   */
  tieBreakCriteria: string;
}

// ─── Conflict Resolution Records ─────────────────────────────────────────────

/**
 * Records a canonical-vs-derived memory conflict that was resolved during assembly.
 *
 * Per the P7A authority rule: canonical always wins.
 * This record makes that resolution traceable in diagnostics.
 */
export interface ConflictResolutionRecord {
  /** Candidate ID of the canonical item that won. */
  canonicalCandidateId: string;

  /** Candidate ID of the derived item that lost. */
  derivedCandidateId: string;

  /**
   * The winner of this conflict.
   * 'canonical' — a canonical candidate (isCanonical=true / authorityTier='canonical') won.
   * 'higher_authority_layer' — a non-canonical candidate from a higher-priority source layer
   *   won (used when no canonical candidate exists in the conflict group; e.g. mem0 beats rag).
   */
  winner: 'canonical' | 'higher_authority_layer';

  /** Human-readable explanation of why the conflict was detected and resolved. */
  reason: string;
}

// ─── D. Context Assembly Diagnostics ─────────────────────────────────────────

/**
 * Full diagnostics for a single context assembly pass.
 *
 * Diagnostics are deterministic: the same inputs always produce the same
 * diagnostic output. They are suitable for test assertions and observability.
 *
 * ContextAssemblyResult.diagnostics carries this object when the assembler
 * is configured to emit diagnostics (always in this implementation).
 */
export interface ContextAssemblyDiagnostics {
  /**
   * GroundingMode value as a string to avoid circular imports.
   * Valid values: 'strict' | 'graph_assisted' | 'exploratory'
   */
  assemblyMode: string;

  /** The layer budgets that governed this assembly pass. */
  layerBudgets: ContextLayerBudget[];

  /** All ranked candidates grouped by their assigned layer. */
  candidatePoolByLayer: Partial<Record<ContextLayerName, RankedContextCandidate[]>>;

  /** Complete decision record — one entry per candidate considered. */
  decisions: ContextDecision[];

  /** Candidate IDs of items that were included in the final context. */
  includedCandidates: string[];

  /** Candidate IDs of items that were excluded (budget exceeded or conflict lost). */
  excludedCandidates: string[];

  /** Candidate IDs of items whose content was truncated. */
  truncatedCandidates: string[];

  /** Candidate IDs of items moved to the latent class. */
  latentCandidates: string[];

  /** Estimated token usage per layer for the included items. */
  finalTokenUsageByLayer: Partial<Record<ContextLayerName, number>>;

  /** All tie-break events that occurred during this pass. */
  tieBreakRecords: TieBreakRecord[];

  /** All canonical-vs-derived conflict resolutions that occurred. */
  conflictResolutionRecords: ConflictResolutionRecord[];

  /** Total number of candidates that entered the assembly pipeline. */
  totalCandidatesConsidered: number;

  /** Total number of candidates included in the final context. */
  totalIncluded: number;

  // ─── P7D Feed 5: Cross-layer Explainability ────────────────────────────────

  /**
   * The complete unified candidate pool BEFORE global selection.
   * Includes all candidates (evidence + graph_context) with their full
   * score breakdowns and rankings.
   */
  crossLayerCandidatePool: RankedContextCandidate[];

  /** IDs of ALL candidates in their final deterministic ranking order. */
  crossLayerRankingOrder: string[];

  /** Count of candidates grouped by their sourceLayer. */
  perSourceCounts: Record<string, number>;

  /** Count of candidates grouped by their final ContextDecisionReason code. */
  exclusionBreakdown: Record<string, number>;

  /**
   * Alias for conflictResolutionRecords (for P7D Feed 5 naming consistency).
   * All canonical-vs-derived conflicts resolved in this pass.
   */
  authorityConflicts: ConflictResolutionRecord[];

  /**
   * Statistical details for normalizedScore across the pool.
   * Includes min, max, and average normalizedScore.
   */
  normalizationDetails: Record<string, any>;
}
