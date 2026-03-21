/**
 * memoryPolicyTypes.ts
 *
 * Canonical memory policy contracts for the TALA context assembly layer.
 *
 * This module defines the policy types that govern:
 *   - Which retrieval modes are permitted
 *   - How grounding is enforced (strict vs. exploratory)
 *   - What scope boundary applies (notebook vs. global)
 *   - How graph-linked memory is constrained before context assembly
 *   - How context budget is allocated across memory selection classes
 *
 * ARCHITECTURE NOTES:
 *   - This is a POLICY layer, NOT a retrieval layer. It sits above retrieval
 *     and before context assembly.
 *   - Graph traversal types are defined here to support future graph-aware
 *     memory behavior ("vibe graphing"). The graph runtime does NOT need to
 *     exist for these types to be used.
 *   - RetrievalMode and ScopeType are re-exported from retrievalTypes.ts
 *     to avoid duplicate definitions while preserving a single import path
 *     for policy consumers.
 *   - Policy is backend-owned. Do NOT import this module into renderer code
 *     that makes runtime policy decisions.
 *
 * Pure TypeScript — no Node.js APIs (process, fs, path).
 * Compiled by both electron/tsconfig.json (Node) and tsconfig.app.json (renderer).
 */

// Import and re-export the retrieval primitives that policy types depend on so
// consumers can import everything they need from a single policy module.
export type { RetrievalMode, RetrievalScopeType as ScopeType } from '../retrieval/retrievalTypes';
import type { RetrievalMode, RetrievalScopeType } from '../retrieval/retrievalTypes';

// ─── Grounding ────────────────────────────────────────────────────────────────

/**
 * Controls how strictly Tala must ground its response to retrieved evidence.
 *
 * - 'strict'          — responses must be grounded in retrieved evidence;
 *                       speculative or unsupported claims are blocked.
 * - 'graph_assisted'  — retrieved evidence is primary, but graph-linked context
 *                       may supplement it under explicit traversal constraints.
 * - 'exploratory'     — broader context window allowed; evidence is preferred
 *                       but the model may draw on latent knowledge.
 */
export type GroundingMode = 'strict' | 'graph_assisted' | 'exploratory';

// ─── Graph Node & Edge Types ──────────────────────────────────────────────────

/**
 * The canonical set of node types in the TALA memory graph.
 *
 * These types describe what kind of knowledge unit a node represents.
 * Used for per-type budget limits and traversal filtering.
 */
export type GraphNodeType =
  | 'notebook'
  | 'source_document'
  | 'document_chunk'
  | 'entity'
  | 'topic'
  | 'task'
  | 'artifact'
  | 'policy'
  | 'session_memory'
  | 'summary';

/**
 * The canonical set of edge (relationship) types in the TALA memory graph.
 *
 * These describe how two nodes are related. Used for traversal filtering and
 * trust-level enforcement.
 */
export type GraphEdgeType =
  | 'contains'
  | 'cites'
  | 'mentions'
  | 'about'
  | 'related_to'
  | 'supports'
  | 'contradicts'
  | 'derived_from'
  | 'belongs_to'
  | 'depends_on'
  | 'references'
  | 'governs'
  | 'same_as';

/**
 * The trust level assigned to a graph edge.
 *
 * Higher trust levels indicate edges whose relationships are well-established
 * or explicitly authored. Lower trust levels indicate inferred or ephemeral links.
 *
 * - 'canonical'      — authoritative, manually curated edge.
 * - 'explicit'       — authored by the user or a trusted agent action.
 * - 'derived'        — produced by a deterministic rule or extraction pipeline.
 * - 'inferred_high'  — inferred by a model with high confidence.
 * - 'inferred_low'   — inferred by a model with low confidence.
 * - 'session_only'   — valid only within the current session; not persisted.
 */
export type EdgeTrustLevel =
  | 'canonical'
  | 'explicit'
  | 'derived'
  | 'inferred_high'
  | 'inferred_low'
  | 'session_only';

// ─── Memory Selection Class ───────────────────────────────────────────────────

/**
 * Classification of a memory item for context assembly priority and budgeting.
 *
 * - 'evidence'       — retrieved source content that directly grounds the response.
 *                      Highest priority. Must never be suppressed by graph policy.
 * - 'graph_context'  — nodes reachable via graph traversal that supplement evidence.
 *                      Allowed only when GroundingMode is 'graph_assisted' or
 *                      'exploratory' and GraphTraversalPolicy.enabled === true.
 * - 'summary'        — condensed or summarized memory (e.g., episode summaries).
 * - 'latent'         — background knowledge or priors without direct retrieval source.
 */
export type MemorySelectionClass = 'evidence' | 'graph_context' | 'summary' | 'latent';

// ─── Graph Traversal Policy ───────────────────────────────────────────────────

/**
 * Governs if and how graph-linked memory nodes may be traversed when assembling
 * context.
 *
 * The graph runtime does NOT need to exist for this policy to be evaluated.
 * When enabled === false, no graph traversal is attempted regardless of other
 * fields. This allows callers to configure traversal constraints in advance of
 * the graph runtime being available.
 */
export interface GraphTraversalPolicy {
  /** Whether graph traversal is permitted at all for this request. */
  enabled: boolean;

  /**
   * Maximum number of relationship hops to follow from a seed node.
   * 0 means only the seed node itself; 1 means its direct neighbors, etc.
   * Ignored when enabled === false.
   */
  maxHopDepth: number;

  /**
   * Maximum total number of related nodes that may be included across all
   * traversal paths. Acts as an absolute cap after per-type limits are applied.
   * Ignored when enabled === false.
   */
  maxRelatedNodes: number;

  /**
   * Per-node-type cap on how many nodes of each type may enter context.
   * Types omitted from the map have no per-type limit (subject to maxRelatedNodes).
   * Ignored when enabled === false.
   */
  maxNodesPerType: Partial<Record<GraphNodeType, number>>;

  /**
   * The minimum edge trust level required for an edge to be traversed.
   * Edges below this level are skipped during traversal.
   * Defaults to 'derived' when not specified.
   * Ignored when enabled === false.
   */
  minEdgeTrustLevel?: EdgeTrustLevel;

  /**
   * When set, only edges whose type appears in this list will be traversed.
   * When omitted, all edge types are eligible (subject to minEdgeTrustLevel).
   * Ignored when enabled === false.
   */
  allowedEdgeTypes?: GraphEdgeType[];
}

// ─── Context Budget Policy ────────────────────────────────────────────────────

/**
 * Governs how the context window is budgeted across memory selection classes.
 *
 * All token and item limits are soft limits — the assembler will respect them
 * best-effort but will always include at least one evidence item when evidence
 * is available, regardless of budget constraints.
 */
export interface ContextBudgetPolicy {
  /**
   * Maximum number of context items to include in the assembled context,
   * across all selection classes combined.
   */
  maxItems: number;

  /**
   * Optional soft token budget for the assembled context block.
   * When set, the assembler will stop adding items once estimated token count
   * reaches this value. Token estimation is approximate.
   */
  maxTokens?: number;

  /**
   * Per-selection-class item limits. Keys omitted use the remaining budget
   * after higher-priority classes have been filled.
   *
   * Priority order (highest to lowest): evidence → summary → graph_context → latent.
   */
  maxItemsPerClass?: Partial<Record<MemorySelectionClass, number>>;

  /**
   * When true, evidence items are always included up to their class limit
   * before any tokens are allocated to other classes.
   * Defaults to true — evidence-first grounding is the TALA default.
   */
  evidencePriority?: boolean;
}

// ─── Memory Policy ────────────────────────────────────────────────────────────

/**
 * The top-level memory policy that governs a single context assembly pass.
 *
 * MemoryPolicy is the primary input to the context assembly layer. It describes
 * WHAT is allowed into context, under WHAT constraints, and with WHAT budget.
 *
 * Backend services create a MemoryPolicy before calling ContextAssembler.
 * The policy is never authored by the renderer.
 */
export interface MemoryPolicy {
  /** How strictly the assembled context must be grounded in retrieved evidence. */
  groundingMode: GroundingMode;

  /**
   * The retrieval strategy to apply when fetching candidate memory items.
   * Imported from retrievalTypes.ts — see RetrievalMode for full documentation.
   */
  retrievalMode: RetrievalMode;

  /**
   * The source boundary for retrieval.
   * Imported from retrievalTypes.ts — see RetrievalScopeType for full documentation.
   */
  scope: RetrievalScopeType;

  /**
   * Notebook to restrict retrieval to when scope === 'notebook'.
   * Must be provided when scope is 'notebook'; ignored otherwise.
   */
  notebookId?: string;

  /**
   * Explicit source URIs or paths to restrict retrieval to when
   * scope === 'explicit_sources'. Must be provided when scope is
   * 'explicit_sources'; ignored otherwise.
   */
  explicitSources?: string[];

  /**
   * Graph traversal constraints applied after retrieval to optionally enrich
   * context with graph-linked nodes. Has no effect if graphTraversal.enabled
   * is false or if the graph runtime is unavailable.
   */
  graphTraversal: GraphTraversalPolicy;

  /** Budget constraints for the assembled context block. */
  contextBudget: ContextBudgetPolicy;
}

// ─── Context Assembly ─────────────────────────────────────────────────────────

/**
 * A single item in the assembled context, ready for inclusion in the prompt.
 *
 * Each item carries its selection class, source attribution, and relevance score
 * so that downstream consumers (e.g., ContextAssembler, logging, telemetry) can
 * reason about why each item was included and under what policy class.
 */
export interface ContextAssemblyItem {
  /** The content to include in the prompt context block. */
  content: string;

  /** Classification that determined this item's priority and budget slot. */
  selectionClass: MemorySelectionClass;

  /**
   * Source category (e.g., 'notebook_item', 'graph_node', 'observation',
   * 'document_chunk'). Mirrors NormalizedSearchResult.sourceType when the item
   * originates from a retrieval result.
   */
  sourceType?: string;

  /**
   * Stable identifier for deduplication and provenance tracking.
   * Typically the NormalizedSearchResult.itemKey of the originating result,
   * or a graph node ID when the item came from graph traversal.
   */
  sourceKey?: string;

  /** Human-readable title or heading for the item. */
  title?: string;

  /** Canonical URI of the source document or node. */
  uri?: string;

  /**
   * Relevance score as produced by the retrieval provider.
   * May be null for graph_context and latent items without a retrieval score.
   */
  score?: number | null;

  /**
   * For graph_context items: the graph edge type that linked this node to
   * the retrieval seed. Null for non-graph items.
   */
  graphEdgeType?: GraphEdgeType | null;

  /**
   * For graph_context items: the trust level of the edge that introduced this
   * node into context. Null for non-graph items.
   */
  graphEdgeTrust?: EdgeTrustLevel | null;

  /** Arbitrary metadata preserved for downstream diagnostics. */
  metadata?: Record<string, unknown>;
}

/**
 * A context assembly request issued by the agent context update path.
 *
 * This is the primary input to the context assembler. It combines the raw
 * query with the governing MemoryPolicy and any session context needed to
 * resolve the scope.
 */
export interface ContextAssemblyRequest {
  /** The raw query or intent string used to retrieve and rank memory items. */
  query: string;

  /** The memory policy governing this assembly pass. */
  policy: MemoryPolicy;

  /**
   * Optional session ID for session-scoped graph context and telemetry.
   * Does not affect retrieval scope — use policy.scope for that.
   */
  sessionId?: string;

  /**
   * Optional turn ID for telemetry and audit trail correlation.
   */
  turnId?: string;
}

/**
 * The result produced by the context assembler for a single assembly pass.
 *
 * Contains the ordered list of items selected for inclusion in context, along
 * with the effective policy and diagnostics for observability.
 */
export interface ContextAssemblyResult {
  /** The assembled context items, ordered by priority (evidence first). */
  items: ContextAssemblyItem[];

  /** The policy that governed this assembly pass. */
  policy: MemoryPolicy;

  /** Total number of items selected (equal to items.length). */
  totalItems: number;

  /**
   * Per-selection-class counts for observability and budget enforcement audit.
   */
  itemCountByClass: Partial<Record<MemorySelectionClass, number>>;

  /**
   * Estimated token count for the assembled context block.
   * Null when token estimation was not performed.
   */
  estimatedTokens?: number | null;

  /** Wall-clock milliseconds elapsed during context assembly. */
  durationMs: number;

  /**
   * Non-fatal warnings produced during assembly (e.g., graph traversal
   * skipped because runtime was unavailable, budget truncation applied).
   * The result is still usable when warnings are present.
   */
  warnings?: string[];
}
