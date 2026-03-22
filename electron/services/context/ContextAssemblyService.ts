/**
 * ContextAssemblyService.ts
 *
 * Backend-owned context assembly service for the TALA context preparation layer.
 *
 * Responsibilities:
 *   1. Resolve the active MemoryPolicy from the ContextAssemblyRequest via
 *      MemoryPolicyService.
 *   2. Call RetrievalOrchestrator using the resolved retrieval mode and scope.
 *   3. Map NormalizedSearchResult items into ContextAssemblyItem with full
 *      citation/provenance metadata preserved.
 *   4. Enforce budget: cap evidence items; move overflow to latent.
 *   5. Classify items as 'evidence' (injected) or 'latent' (overflow).
 *   6. Return a structured ContextAssemblyResult.
 *   7. Provide renderPromptBlocks() for deterministic prompt string rendering.
 *
 * DESIGN PRINCIPLES (P7B):
 *   - Evidence-first: evidence items are always selected before any other class.
 *   - Deterministic: same inputs always produce the same outputs (P7B).
 *     - Candidates are scored by ContextScoringService and sorted with a
 *       total-order comparator before budget selection is applied.
 *     - No selection drift from insertion order, Map/Set iteration, or
 *       undifferentiated retrieval ordering.
 *   - Graph context via GraphTraversalService: graph_context items are derived
 *     from evidence seeds by GraphTraversalService and inserted after evidence
 *     mapping but before budget enforcement. Empty when traversal is disabled.
 *   - Affective context via AffectiveGraphService: optional affective graph_context
 *     items (selectionClass: 'graph_context', metadata.affective: true) are added
 *     after structural graph traversal, subject to policy.affectiveModulation. In
 *     strict mode or when the service is absent, behavior is unchanged.
 *   - No silent discards: overflow evidence moves to 'latent', not dropped.
 *   - Decision records: every candidate considered produces a ContextDecision
 *     with explicit reason codes.
 *   - Citation/provenance metadata survives from retrieval into assembled context.
 *   - Backend-owned: this service must not be imported by renderer code.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type { RetrievalOrchestrator } from '../retrieval/RetrievalOrchestrator';
import type { NormalizedSearchResult } from '../../../shared/retrieval/retrievalTypes';
import type {
  ContextAssemblyRequest,
  ContextAssemblyResult,
  ContextAssemblyItem,
  MemoryPolicy,
  MemorySelectionClass,
  GraphEdgeType,
  EdgeTrustLevel,
  AffectiveModulationPolicy,
} from '../../../shared/policy/memoryPolicyTypes';
import type {
  ContextCandidate,
  RankedContextCandidate,
  ContextDecision,
  ContextDecisionReason,
  ContextAssemblyDiagnostics,
  ContextLayerBudget,
  TieBreakRecord,
  ConflictResolutionRecord,
} from '../../../shared/context/contextDeterminismTypes';
import type { AffectiveState } from '../../../shared/context/affectiveWeightingTypes';
import type { MemoryAuthorityTier } from '../../../shared/memory/authorityTypes';
import { MemoryPolicyService } from '../policy/MemoryPolicyService';
import { GraphTraversalService } from '../graph/GraphTraversalService';
import { AffectiveGraphService } from '../graph/AffectiveGraphService';
import { ContextScoringService } from './ContextScoringService';
import { AffectiveWeightingService } from './AffectiveWeightingService';
import { applyDeterministicTieBreak, compareContextCandidates } from './contextCandidateComparator';
import { resolveMemoryAuthorityConflict } from './authorityConflictResolver';

// ─── Approximate token estimator ─────────────────────────────────────────────
// Rough 4-chars-per-token heuristic. Sufficient for soft budget enforcement.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Default graph hop depth assigned to graph_context items that originated from
 * evidence co-occurrence derivation (GraphTraversalService one-hop expansion).
 * This assumption holds until multi-hop traversal is introduced, at which point
 * items should carry their actual hop depth from the traversal.
 */
const DEFAULT_GRAPH_HOP_DEPTH = 1;

// ─── Authority tier derivation from edge trust ────────────────────────────────

function deriveAuthorityTierFromEdgeTrust(
  trust: string | null | undefined,
): MemoryAuthorityTier | null {
  switch (trust) {
    case 'canonical':
    case 'explicit':
      return 'canonical';
    case 'derived':
    case 'inferred_high':
      return 'verified_derived';
    case 'inferred_low':
      return 'transient';
    case 'session_only':
      return 'speculative';
    default:
      return null;
  }
}

// ─── Item ↔ Candidate conversion helpers ─────────────────────────────────────

function itemToCandidate(
  item: ContextAssemblyItem,
  idx: number,
): ContextCandidate {
  const isGraphContext = item.selectionClass === 'graph_context';
  const layer: 'evidence' | 'graph_context' = isGraphContext ? 'graph_context' : 'evidence';

  // Use sourceKey as stable ID; fall back to URI, title, or positional key
  const id = item.sourceKey ?? item.uri ?? item.title ?? `${layer}-${idx}`;
  const authorityTier: MemoryAuthorityTier | null = isGraphContext
    ? deriveAuthorityTierFromEdgeTrust(item.graphEdgeTrust)
    : null; // evidence items: null = neutral (scoring treats as 0.5)
  const timestamp = (item.metadata?.fetchedAt as string | undefined) ?? null;
  const graphHopDepth = isGraphContext ? DEFAULT_GRAPH_HOP_DEPTH : 0;

  // P7D: Derive source layer and canonical flag.
  const sourceLayer = isGraphContext ? 'graph' : 'rag';
  const isCanonical = authorityTier === 'canonical';
  const canonicalId = (item.metadata?.canonicalId as string | undefined) ?? undefined;

  return {
    id,
    content: item.content,
    title: item.title,
    uri: item.uri,
    sourceType: item.sourceType ?? undefined,
    sourceKey: item.sourceKey ?? undefined,
    selectionClass: item.selectionClass,
    layerAssignment: layer,
    estimatedTokens: estimateTokens(item.content),
    score: item.score ?? null,
    authorityTier,
    timestamp,
    graphHopDepth,
    graphEdgeType: item.graphEdgeType ?? null,
    graphEdgeTrust: item.graphEdgeTrust ?? null,
    metadata: item.metadata,
    sourceLayer,
    isCanonical,
    canonicalId,
  };
}

function rankedCandidateToItem(rc: RankedContextCandidate): ContextAssemblyItem {
  return {
    content: rc.content,
    selectionClass: rc.selectionClass as MemorySelectionClass,
    sourceType: rc.sourceType ?? null,
    sourceKey: rc.sourceKey ?? undefined,
    title: rc.title,
    uri: rc.uri,
    score: rc.score ?? null,
    graphEdgeType: (rc.graphEdgeType ?? null) as GraphEdgeType | null,
    graphEdgeTrust: (rc.graphEdgeTrust ?? null) as EdgeTrustLevel | null,
    metadata: rc.metadata,
  };
}

// ─── ContextAssemblyService ───────────────────────────────────────────────────

/**
 * Hard upper bound on affectiveWeight. Shared with AffectiveGraphService and
 * AffectiveWeightingService to enforce a consistent policy cap.
 */
const MAX_AFFECTIVE_WEIGHT = 0.3;

export class ContextAssemblyService {
  private readonly _scoringService = new ContextScoringService();
  private readonly _affectiveWeightingService = new AffectiveWeightingService();

  constructor(
    private readonly orchestrator: RetrievalOrchestrator,
    private readonly policyService: MemoryPolicyService = new MemoryPolicyService(),
    private readonly graphTraversalService: GraphTraversalService = new GraphTraversalService(),
    private readonly affectiveGraphService: AffectiveGraphService | null = null,
  ) {}

  // ─── Primary Entry Point ─────────────────────────────────────────────────

  /**
   * Assemble context for a single turn.
   *
   * P7B+P7C+P7D deterministic pipeline stages:
   *   1.  Resolve the active MemoryPolicy.
   *   2.  Retrieve candidates via RetrievalOrchestrator.
   *   3.  Map retrieval results to ContextAssemblyItems with full provenance.
   *   3.5 Expand structural graph context via GraphTraversalService.
   *   3.6 Add affective graph context via AffectiveGraphService (optional).
   *   3P. P7C: Build AffectiveState from affective items for keyword-overlap scoring.
   *   3.7 Merge structural + affective graph_context items.
   *   3D. P7D: Collect ALL candidates (evidence + graph_context) into ONE unified
   *       competitive pool. Score and sort ALL candidates in a single pass with
   *       ContextScoringService, AffectiveWeightingService (P7C gates per-layer),
   *       and total-order comparator. No layer is ranked independently.
   *       Split unified ranked pool by layerAssignment for budget enforcement.
   *   4.  Enforce evidence budget: cap evidence items; move overflow to latent.
   *       Enforce graph_context budget cap. Record decisions for every candidate.
   *   5.  Combine injected (evidence) + graph_context + latent items.
   *   6.  Build class counts.
   *   7.  Estimate tokens.
   *   8.  Build diagnostics (P7B/P7C/P7D fields).
   *   9.  Return ContextAssemblyResult.
   */
  async assemble(request: ContextAssemblyRequest): Promise<ContextAssemblyResult> {
    const startMs = Date.now();
    const warnings: string[] = [];
    const allDecisions: ContextDecision[] = [];
    const allTieBreaks: TieBreakRecord[] = [];
    const conflictResolutionRecords: ConflictResolutionRecord[] = [];

    // 1. Resolve active policy.
    const policy = this.policyService.resolvePolicy(request);

    // 2. Retrieve candidates.
    let retrievalResults: NormalizedSearchResult[] = [];
    try {
      const response = await this.orchestrator.retrieve({
        query: request.query,
        mode: policy.retrievalMode,
        scope: policy.scope,
        notebookId: policy.notebookId,
        explicitSources: policy.explicitSources,
        topK: policy.contextBudget.maxItems * 3, // over-fetch to allow budget selection
      });
      retrievalResults = response.results ?? [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Retrieval failed: ${msg}`);
    }

    // 3. Map retrieval results to ContextAssemblyItems (all are evidence candidates).
    const rawCandidates = retrievalResults.map((result, index) =>
      this._mapResultToItem(result, index),
    );

    // 3.5. Expand structural graph context from evidence candidates (when traversal is enabled).
    //      Runs after evidence mapping but before budget enforcement so that
    //      graph_context items can be capped independently from evidence items.
    let structuralGraphItems: ContextAssemblyItem[] = [];
    if (policy.graphTraversal.enabled && policy.groundingMode !== 'strict') {
      try {
        structuralGraphItems = await this.graphTraversalService.expandFromEvidence({
          evidenceItems: rawCandidates, // pass original (unsorted) for seed extraction
          policy,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Graph traversal failed: ${msg}`);
      }
    }

    // 3.6. Affective context (bounded, labeled, non-authoritative graph_context items).
    //      Only runs when AffectiveGraphService is provided, affectiveModulation is
    //      enabled, and the grounding mode is not 'strict'. Degrades gracefully on
    //      service failure — a warning is added but assembly continues.
    let affectiveItems: ContextAssemblyItem[] = [];
    const affectivePolicy = policy.affectiveModulation;
    if (
      this.affectiveGraphService &&
      affectivePolicy?.enabled &&
      policy.groundingMode !== 'strict'
    ) {
      try {
        affectiveItems = await this.affectiveGraphService.getActiveAffectiveContext({
          policy,
          notebookId: policy.notebookId,
          queryText: request.query,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Affective context unavailable: ${msg}`);
      }
    }

    // P7C: Build AffectiveState from the collected affective items so that
    //      AffectiveWeightingService can compute keyword-overlap adjustments for
    //      both graph_context and evidence candidates. Null when no affective items.
    const affectiveState = this._buildAffectiveStateFromItems(affectiveItems);

    // 3.7. Merge structural and affective graph_context items into a single list.
    //      Ordering within the merged list is determined by the unified ranking pass below.
    const mergedGraphCandidates = this._mergeGraphContextItems(
      structuralGraphItems,
      affectiveItems,
    );

    // P7D: Collect ALL candidates (evidence + graph_context) into a single competitive
    //      pool. Score and sort ALL candidates in ONE unified pass so that no layer is
    //      ranked independently before scoring.
    //      P7B+P7C: AffectiveWeightingService gates are applied per-candidate based on
    //               each candidate's layerAssignment ('evidence' vs 'graph_context').
    const allRawItems = [...rawCandidates, ...mergedGraphCandidates];
    const { ranked: rankedAll, tieBreaks: unifiedTieBreaks } =
      this._rankItems(allRawItems, affectiveState, affectivePolicy);
    allTieBreaks.push(...unifiedTieBreaks);

    // Split unified ranked pool by layer assignment for diagnostics.
    const rankedEvidence = rankedAll.filter(rc => rc.layerAssignment === 'evidence');
    const rankedGraph = rankedAll.filter(rc => rc.layerAssignment === 'graph_context');

    // P7D Feed 3: Global competitive selection — all candidates compete under ONE budget.
    // Per-layer quota enforcement is replaced by a single global token + item budget.
    // P7D Feed 4: Cross-layer authority conflict resolution is applied before the greedy pass.
    const {
      injected,
      graphContextItems,
      latent,
      decisions: selectionDecisions,
      conflictRecords,
    } = this._selectItemsGlobal(rankedAll, policy, warnings);
    allDecisions.push(...selectionDecisions);
    conflictResolutionRecords.push(...conflictRecords);

    // 5. Combine injected (evidence) + graph_context + latent items.
    const allItems: ContextAssemblyItem[] = [...injected, ...graphContextItems, ...latent];

    // 6. Build class counts.
    const itemCountByClass: Partial<Record<MemorySelectionClass, number>> = {};
    for (const item of allItems) {
      itemCountByClass[item.selectionClass] =
        (itemCountByClass[item.selectionClass] ?? 0) + 1;
    }

    // 7. Estimate tokens.
    const estimatedTokens = allItems.reduce(
      (sum, item) => sum + estimateTokens(item.content),
      0,
    );

    // 8. Build P7B diagnostics.
    const diagnostics = this._buildDiagnostics({
      policy,
      rankedAll,
      rankedEvidence,
      rankedGraph,
      decisions: allDecisions,
      tieBreakRecords: allTieBreaks,
      conflictResolutionRecords,
      graphContextItems,
      injected,
      latent,
    });

    return {
      items: allItems,
      policy,
      totalItems: allItems.length,
      itemCountByClass,
      estimatedTokens,
      durationMs: Date.now() - startMs,
      warnings: warnings.length > 0 ? warnings : undefined,
      diagnostics,
    };
  }

  // ─── Prompt Block Renderer ────────────────────────────────────────────────

  /**
   * Render assembled context into a deterministic prompt string.
   *
   * Sections produced:
   *   [PRIMARY EVIDENCE]         — injected evidence items with source labels.
   *   [DIRECT GRAPH CONTEXT]     — non-affective graph_context items; omitted when absent.
   *   [AFFECTIVE CONTEXT]        — affective graph_context items (metadata.affective===true);
   *                                omitted when absent. Clearly labeled as non-authoritative.
   *   [POLICY CONSTRAINTS]       — groundingMode, retrievalMode, scope summary;
   *                                includes affective modulation status.
   *   [LATENT MEMORY SUMMARY]    — brief note when latent items were retained.
   */
  renderPromptBlocks(result: ContextAssemblyResult): string {
    const sections: string[] = [];

    // PRIMARY EVIDENCE
    const evidenceItems = result.items.filter(i => i.selectionClass === 'evidence');
    if (evidenceItems.length > 0) {
      const lines = evidenceItems.map((item, idx) => {
        const label = item.title ? `[${idx + 1}] ${item.title}` : `[${idx + 1}]`;
        const source = item.uri ?? item.metadata?.sourcePath ?? item.sourceKey ?? '';
        const sourceLabel = source ? ` (${source})` : '';
        return `${label}${sourceLabel}\n${item.content}`;
      });
      sections.push(`[PRIMARY EVIDENCE]\n${lines.join('\n\n')}`);
    }

    // DIRECT GRAPH CONTEXT — structural (non-affective) graph_context items only
    const graphItems = result.items.filter(
      i => i.selectionClass === 'graph_context' && !i.metadata?.affective,
    );
    if (graphItems.length > 0) {
      const lines = graphItems.map((item, idx) => {
        const label = item.title ? `[G${idx + 1}] ${item.title}` : `[G${idx + 1}]`;
        const edge = item.graphEdgeType ? ` (edge: ${item.graphEdgeType})` : '';
        return `${label}${edge}\n${item.content}`;
      });
      sections.push(`[DIRECT GRAPH CONTEXT]\n${lines.join('\n\n')}`);
    }

    // AFFECTIVE CONTEXT — affective graph_context items; clearly labeled non-authoritative
    const affectiveItems = result.items.filter(
      i => i.selectionClass === 'graph_context' && i.metadata?.affective === true,
    );
    if (affectiveItems.length > 0) {
      const lines = affectiveItems.map(item => {
        const nodeType = item.metadata?.affectiveNodeType as string | undefined;
        if (nodeType === 'astro_state') {
          return `- Current Astro State: ${item.content}`;
        }
        if (nodeType === 'emotion_tag') {
          const moodLabel = item.metadata?.moodLabel as string | undefined;
          return `- Emotion Tag: ${moodLabel ?? item.content}`;
        }
        return `- ${item.title ?? item.content}`;
      });
      sections.push(
        `[AFFECTIVE CONTEXT]\n${lines.join('\n')}\n` +
        `These signals may influence tone or graph-context emphasis, but do not change factual grounding.`,
      );
    }

    // POLICY CONSTRAINTS
    const policy = result.policy;
    const scopeLine = policy.notebookId
      ? `scope: ${policy.scope} (notebookId: ${policy.notebookId})`
      : `scope: ${policy.scope}`;
    const ap = policy.affectiveModulation;
    const affectiveLine = ap
      ? `affectiveModulation: ${ap.enabled ? 'enabled' : 'disabled'}`
      : `affectiveModulation: not configured`;
    const policyLines = [
      `groundingMode: ${policy.groundingMode}`,
      `retrievalMode: ${policy.retrievalMode}`,
      scopeLine,
      affectiveLine,
    ];
    sections.push(`[POLICY CONSTRAINTS]\n${policyLines.join('\n')}`);

    // LATENT MEMORY SUMMARY
    const latentItems = result.items.filter(i => i.selectionClass === 'latent');
    if (latentItems.length > 0) {
      sections.push(
        `[LATENT MEMORY SUMMARY]\n` +
        `Additional relevant items were retained as latent memory due to policy budget limits. ` +
        `(${latentItems.length} item${latentItems.length === 1 ? '' : 's'})`,
      );
    }

    return sections.join('\n\n');
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Map a NormalizedSearchResult to a ContextAssemblyItem with full provenance.
   *
   * Citation fields preserved:
   *   title, uri, sourcePath, providerId, externalId, contentHash,
   *   chunkId, documentId, charStart, charEnd, sectionLabel, pageNumber,
   *   citationLabel, displayDomain, fetchedAt.
   */
  private _mapResultToItem(
    result: NormalizedSearchResult,
    rank: number,
  ): ContextAssemblyItem {
    const meta = result.metadata ?? {};

    // Prefer chunk content from metadata; fall back to snippet; then empty.
    const content =
      (meta.chunkContent as string | undefined) ??
      result.snippet ??
      '';

    // Build enriched metadata with all available citation/provenance fields.
    const enrichedMetadata: Record<string, unknown> = {
      ...meta,
      rank,
      providerId: result.providerId,
      contentHash: result.contentHash ?? null,
      sourcePath: result.sourcePath ?? null,
      externalId: result.externalId ?? null,
      // Chunk and document provenance
      chunkId: (meta.chunkId as string | undefined) ?? null,
      documentId: (meta.documentId as string | undefined) ?? null,
      charStart: (meta.charStart as number | undefined) ?? null,
      charEnd: (meta.charEnd as number | undefined) ?? null,
      sectionLabel: (meta.sectionLabel as string | undefined) ?? null,
      pageNumber: (meta.pageNumber as number | undefined) ?? null,
      // Citation display fields
      citationLabel: (meta.citationLabel as string | undefined) ?? result.title ?? null,
      displayDomain: (meta.displayDomain as string | undefined) ?? null,
      fetchedAt: (meta.fetchedAt as string | undefined) ?? null,
    };

    return {
      content,
      selectionClass: 'evidence',
      sourceType: result.sourceType ?? undefined,
      sourceKey: result.itemKey,
      title: result.title,
      uri: result.uri ?? undefined,
      score: result.score ?? null,
      graphEdgeType: null,
      graphEdgeTrust: null,
      metadata: enrichedMetadata,
    };
  }

  /**
   * Select injected (evidence) items and produce latent overflow.
   *
   * Input must be pre-sorted deterministically (P7B: step 3P in assemble()).
   *
   * Rules (applied in order):
   *   1. Evidence items are always selected first (evidencePriority).
   *   2. Total injected count is capped by contextBudget.maxItems.
   *   3. Evidence class cap is applied via contextBudget.maxItemsPerClass.evidence
   *      when set; falls back to contextBudget.maxItems.
   *   4. Per-document chunk cap is applied via metadata.documentId when set.
   *      Cap value: contextBudget.maxItemsPerClass.evidence / 2 (rounded up),
   *      minimum 1.
   *   5. All items that do not fit the budget become 'latent', preserving
   *      ranked order and full metadata.
   *   6. P7B: A ContextDecision record is produced for every candidate.
   */
  private _selectItems(
    candidates: ContextAssemblyItem[],
    rankedCandidates: RankedContextCandidate[],
    policy: MemoryPolicy,
    warnings: string[],
  ): { injected: ContextAssemblyItem[]; latent: ContextAssemblyItem[]; decisions: ContextDecision[] } {
    const budget = policy.contextBudget;
    const maxTotal = budget.maxItems;
    const evidenceClassCap = budget.maxItemsPerClass?.evidence ?? maxTotal;
    const evidenceCap = Math.min(maxTotal, evidenceClassCap);

    // Derive per-document chunk cap from evidence cap.
    // Per-document chunk cap: ceil(evidenceCap / 2).
    // Dividing by 2 ensures no single document consumes more than half the
    // evidence budget, preventing one large document from crowding out all
    // other sources while still allowing meaningful multi-chunk representation.
    const maxChunksPerDoc = Math.max(1, Math.ceil(evidenceCap / 2));

    const injected: ContextAssemblyItem[] = [];
    const latent: ContextAssemblyItem[] = [];
    const chunksPerDoc = new Map<string, number>();
    const decisions: ContextDecision[] = [];

    // Build a map from sourceKey → RankedContextCandidate for decision enrichment.
    const rankedById = new Map<string, RankedContextCandidate>();
    for (const rc of rankedCandidates) {
      rankedById.set(rc.id, rc);
    }

    for (const item of candidates) {
      const candidateId = item.sourceKey ?? item.uri ?? item.title ?? '';
      const rc = rankedById.get(candidateId);
      const finalScore = rc?.scoreBreakdown.finalScore ?? (item.score ?? 0);
      const tokenCost = estimateTokens(item.content);

      if (injected.length >= evidenceCap) {
        // Budget exhausted — move to latent.
        latent.push({ ...item, selectionClass: 'latent' });
        decisions.push({
          candidateId,
          sourceType: item.sourceType ?? undefined,
          authorityTier: rc?.authorityTier ?? null,
          finalScore,
          estimatedTokens: tokenCost,
          status: 'latent',
          layerAssignment: 'evidence',
          reasons: ['overflow.to_latent'],
          affectiveAdjustment: rc?.scoreBreakdown.affectiveAdjustment || null,
          affectiveReasonCode: rc?.affectiveReasonCode ?? null,
        });
        continue;
      }

      // Check per-document chunk cap.
      const docId = (item.metadata?.documentId as string | undefined) ?? null;
      if (docId) {
        const used = chunksPerDoc.get(docId) ?? 0;
        if (used >= maxChunksPerDoc) {
          latent.push({ ...item, selectionClass: 'latent' });
          decisions.push({
            candidateId,
            sourceType: item.sourceType ?? undefined,
            authorityTier: rc?.authorityTier ?? null,
            finalScore,
            estimatedTokens: tokenCost,
            status: 'latent',
            layerAssignment: 'evidence',
            reasons: ['excluded.per_document_cap', 'overflow.to_latent'],
            affectiveAdjustment: rc?.scoreBreakdown.affectiveAdjustment || null,
            affectiveReasonCode: rc?.affectiveReasonCode ?? null,
          });
          continue;
        }
        chunksPerDoc.set(docId, used + 1);
      }

      injected.push(item);
      const reasons: ContextDecisionReason[] =
        rc?.authorityTier === 'canonical'
          ? ['included.high_authority', 'included.canonical_memory_priority']
          : ['included.top_ranked_within_budget'];
      decisions.push({
        candidateId,
        sourceType: item.sourceType ?? undefined,
        authorityTier: rc?.authorityTier ?? null,
        finalScore,
        estimatedTokens: tokenCost,
        status: 'included',
        layerAssignment: 'evidence',
        reasons,
        affectiveAdjustment: rc?.scoreBreakdown.affectiveAdjustment || null,
        affectiveReasonCode: rc?.affectiveReasonCode ?? null,
      });
    }

    if (latent.length > 0) {
      warnings.push(
        `${latent.length} overflow item${latent.length === 1 ? '' : 's'} retained as latent memory due to policy budget limits.`,
      );
    }

    return { injected, latent, decisions };
  }

  /**
   * P7D Feed 3: Select items using a single global budget across ALL layers.
   *
   * Replaces per-layer quota enforcement with one greedy pass over ALL ranked
   * candidates (evidence + graph_context) in rank order. A candidate is included
   * when the global item and token budgets allow it; otherwise it is excluded or
   * moved to latent.
   *
   * P7D Feed 4: Before the greedy pass, runs resolveMemoryAuthorityConflict() to
   * detect and mark candidates that share the same canonicalId. The canonical
   * candidate always wins. Derived candidates are either:
   *   - Included as supporting context ('included.supporting_derived')
   *   - Excluded when superseded by a canonical candidate ('excluded.superseded_by_canonical')
   *   - Excluded when they lost a non-canonical authority conflict ('excluded.authority_conflict')
   *
   * Rules (applied in order):
   *   1. Run cross-layer authority conflict resolution (P7D Feed 4).
   *   2. Iterate over ALL candidates in descending rank order (highest rank first).
   *   3. Always exclude conflict losers with 'excluded.authority_conflict'.
   *   4. Include a candidate when:
   *        - Global item cap has not been reached, AND
   *        - Global token cap (if set) has room for this candidate's token cost, AND
   *        - Per-document chunk cap has not been reached (evidence only).
   *   5. Evidence candidates that do not fit are moved to 'latent' (not dropped),
   *      preserving their metadata and ranked order.
   *   6. Graph_context candidates that do not fit are excluded with a decision record.
   *   7. Optional minimum canonical floor: the top-ranked canonical candidates are
   *      guaranteed inclusion even when the global item budget would otherwise
   *      exclude them (see policy.contextBudget.minCanonicalItems).
   *   8. A ContextDecision record is produced for every candidate.
   *   9. Reason codes:
   *        included  → 'included.cross_layer_top_rank' (+ 'included.high_authority'
   *                    when authorityTier === 'canonical')
   *                  → 'included.supporting_derived' (when candidate is a derived
   *                    member of a canonicalId conflict group)
   *        excluded  → 'excluded.cross_layer_budget_exceeded' (global cap hit)
   *                  → 'excluded.superseded_by_canonical' (derived candidate excluded
   *                    because canonical counterpart was selected and budget exhausted)
   *                  → 'excluded.authority_conflict' (non-canonical conflict loser)
   *        latent    → 'excluded.cross_layer_budget_exceeded' + 'overflow.to_latent'
   *                  → 'excluded.superseded_by_canonical' + 'overflow.to_latent'
   *        per-doc   → 'excluded.per_document_cap' + 'excluded.outcompeted_by_higher_rank'
   *                    + 'overflow.to_latent' (higher-ranked chunk from same doc took the slot)
   */
  private _selectItemsGlobal(
    rankedAll: RankedContextCandidate[],
    policy: MemoryPolicy,
    warnings: string[],
  ): {
    injected: ContextAssemblyItem[];
    graphContextItems: ContextAssemblyItem[];
    latent: ContextAssemblyItem[];
    decisions: ContextDecision[];
    conflictRecords: ConflictResolutionRecord[];
  } {
    const budget = policy.contextBudget;
    const globalItemCap = budget.maxItems;
    const globalTokenCap = budget.maxTokens ?? Infinity;
    const minCanonical = budget.minCanonicalItems ?? 0;

    // Per-document chunk cap for evidence items.
    // Use the global item cap as the base so that no single document consumes
    // more than half the global budget.
    const maxChunksPerDoc = Math.max(1, Math.ceil(globalItemCap / 2));

    // P7D Feed 3: Optional minimum canonical memory floor.
    // The comparator already places canonical items at the top of rankedAll
    // (authority tier is step 1). The floor only activates when the policy
    // explicitly requires more canonical items than the global cap would allow.
    const mustIncludeIds = new Set<string>();
    if (minCanonical > 0) {
      const canonicals = rankedAll.filter(rc => rc.authorityTier === 'canonical');
      const floorCount = Math.min(minCanonical, canonicals.length);
      for (let i = 0; i < floorCount; i++) {
        mustIncludeIds.add(canonicals[i]!.id);
      }
    }

    // P7D Feed 4: Detect and resolve cross-layer authority conflicts BEFORE selection.
    // affective weighting must NOT override authority — conflicts are resolved here
    // purely by the authority hierarchy, independently of any score component.
    const {
      supportingIds,
      conflictLoserIds,
      canonicalWinnerIds,
      records: conflictRecords,
    } = resolveMemoryAuthorityConflict(rankedAll);

    const injected: ContextAssemblyItem[] = [];
    const graphContextItems: ContextAssemblyItem[] = [];
    const latent: ContextAssemblyItem[] = [];
    const decisions: ContextDecision[] = [];
    const chunksPerDoc = new Map<string, number>();
    let totalIncluded = 0;
    let totalTokensUsed = 0;

    for (const rc of rankedAll) {
      const isEvidence = rc.layerAssignment === 'evidence';
      const isMustInclude = mustIncludeIds.has(rc.id);
      const tokenCost = rc.estimatedTokens;
      const isConflictLoser = conflictLoserIds.has(rc.id);
      const isSupporting = supportingIds.has(rc.id);
      const isCanonicalWinner = canonicalWinnerIds.has(rc.id);

      // P7D Feed 4: Always exclude authority-conflict losers regardless of budget.
      if (isConflictLoser) {
        decisions.push({
          candidateId: rc.id,
          sourceType: rc.sourceType,
          authorityTier: rc.authorityTier,
          finalScore: rc.scoreBreakdown.finalScore,
          estimatedTokens: tokenCost,
          status: 'excluded',
          layerAssignment: rc.layerAssignment,
          reasons: ['excluded.authority_conflict'],
          conflictResolved: true,
          affectiveAdjustment: rc.scoreBreakdown.affectiveAdjustment || null,
          affectiveReasonCode: rc.affectiveReasonCode ?? null,
        });
        continue;
      }

      // Check global budget. Must-include canonical items bypass the cap.
      const budgetExhausted =
        !isMustInclude &&
        (totalIncluded >= globalItemCap ||
          (globalTokenCap !== Infinity && totalTokensUsed + tokenCost > globalTokenCap));

      if (budgetExhausted) {
        if (isEvidence) {
          latent.push({ ...rankedCandidateToItem(rc), selectionClass: 'latent' });
          // P7D Feed 4: Use superseded_by_canonical for supporting candidates excluded
          // due to budget exhaustion; use standard budget_exceeded reason otherwise.
          const budgetExclusionReason: ContextDecisionReason = isSupporting
            ? 'excluded.superseded_by_canonical'
            : 'excluded.cross_layer_budget_exceeded';
          decisions.push({
            candidateId: rc.id,
            sourceType: rc.sourceType,
            authorityTier: rc.authorityTier,
            finalScore: rc.scoreBreakdown.finalScore,
            estimatedTokens: tokenCost,
            status: 'latent',
            layerAssignment: rc.layerAssignment,
            reasons: [budgetExclusionReason, 'overflow.to_latent'],
            conflictResolved: isSupporting || isCanonicalWinner,
            affectiveAdjustment: rc.scoreBreakdown.affectiveAdjustment || null,
            affectiveReasonCode: rc.affectiveReasonCode ?? null,
          });
        } else {
          // P7D Feed 4: Use superseded_by_canonical for supporting candidates excluded
          // due to budget exhaustion; use standard budget_exceeded reason otherwise.
          const budgetExclusionReason: ContextDecisionReason = isSupporting
            ? 'excluded.superseded_by_canonical'
            : 'excluded.cross_layer_budget_exceeded';
          decisions.push({
            candidateId: rc.id,
            sourceType: rc.sourceType,
            authorityTier: rc.authorityTier,
            finalScore: rc.scoreBreakdown.finalScore,
            estimatedTokens: tokenCost,
            status: 'excluded',
            layerAssignment: rc.layerAssignment,
            reasons: [budgetExclusionReason],
            conflictResolved: isSupporting || isCanonicalWinner,
            affectiveAdjustment: rc.scoreBreakdown.affectiveAdjustment || null,
            affectiveReasonCode: rc.affectiveReasonCode ?? null,
          });
        }
        continue;
      }

      // Check per-document chunk cap for evidence items.
      if (isEvidence && !isMustInclude) {
        const docId = (rc.metadata?.documentId as string | undefined) ?? null;
        if (docId) {
          const used = chunksPerDoc.get(docId) ?? 0;
          if (used >= maxChunksPerDoc) {
            latent.push({ ...rankedCandidateToItem(rc), selectionClass: 'latent' });
            decisions.push({
              candidateId: rc.id,
              sourceType: rc.sourceType,
              authorityTier: rc.authorityTier,
              finalScore: rc.scoreBreakdown.finalScore,
              estimatedTokens: tokenCost,
              status: 'latent',
              layerAssignment: rc.layerAssignment,
              reasons: ['excluded.per_document_cap', 'excluded.outcompeted_by_higher_rank', 'overflow.to_latent'],
              affectiveAdjustment: rc.scoreBreakdown.affectiveAdjustment || null,
              affectiveReasonCode: rc.affectiveReasonCode ?? null,
            });
            continue;
          }
        }
      }

      // Include this candidate.
      const item = rankedCandidateToItem(rc);
      if (isEvidence) {
        injected.push(item);
        // Track per-document chunk count.
        const docId = (rc.metadata?.documentId as string | undefined) ?? null;
        if (docId) chunksPerDoc.set(docId, (chunksPerDoc.get(docId) ?? 0) + 1);
      } else {
        graphContextItems.push(item);
      }

      // P7D Feed 4: Choose the correct inclusion reason.
      // - isSupporting → 'included.supporting_derived' (derived candidate included
      //   as supporting context alongside or instead of its canonical counterpart)
      // - canonical authority → 'included.high_authority' co-emitted
      // - default → 'included.cross_layer_top_rank'
      const reasons: ContextDecisionReason[] = isSupporting
        ? ['included.supporting_derived']
        : rc.authorityTier === 'canonical'
          ? ['included.high_authority', 'included.cross_layer_top_rank']
          : ['included.cross_layer_top_rank'];

      decisions.push({
        candidateId: rc.id,
        sourceType: rc.sourceType,
        authorityTier: rc.authorityTier,
        finalScore: rc.scoreBreakdown.finalScore,
        estimatedTokens: tokenCost,
        status: 'included',
        layerAssignment: rc.layerAssignment,
        reasons,
        conflictResolved: isSupporting || isCanonicalWinner,
        affectiveAdjustment: rc.scoreBreakdown.affectiveAdjustment || null,
        affectiveReasonCode: rc.affectiveReasonCode ?? null,
      });

      totalIncluded++;
      totalTokensUsed += tokenCost;
    }

    if (latent.length > 0) {
      warnings.push(
        `${latent.length} overflow item${latent.length === 1 ? '' : 's'} retained as latent memory due to policy budget limits.`,
      );
    }

    return { injected, graphContextItems, latent, decisions, conflictRecords };
  }

  /**
   * P7B+P7C+P7D: Score and sort a unified list of ContextAssemblyItems deterministically.
   *
   * P7D change: The `layer` parameter has been removed. All items from all layers
   * (evidence, graph_context, etc.) are scored and sorted in a single pass. Each
   * item's layer is derived from its selectionClass via itemToCandidate(). The
   * AffectiveWeightingService layer-eligibility gates are applied per-candidate
   * based on the candidate's derived layerAssignment.
   *
   * Pipeline:
   *   1. Convert items to ContextCandidates (P7D: layer derived from selectionClass).
   *   2. Score each with ContextScoringService.
   *      P7C: When affectiveState and affectivePolicy are provided, compute an
   *           affective keyword-overlap adjustment via AffectiveWeightingService
   *           and pass it to computeCandidateScore(). Adjustment is clamped and
   *           bounded — it does not override canonical authority.
   *   3. Wrap in RankedContextCandidates (including P7C affectiveReasonCode).
   *   4. Sort with applyDeterministicTieBreak (total-order comparator).
   *   5. Assign 1-indexed ranks.
   *
   * Returns the ranked (sorted) candidates and any tie-break records.
   *
   * @param affectiveState   Optional normalized affective state for P7C weighting.
   *                         Pass null to skip affective adjustment (backward compat).
   * @param affectivePolicy  Required when affectiveState is non-null. Provides
   *                         layer eligibility gates and affectiveWeight.
   */
  private _rankItems(
    items: ContextAssemblyItem[],
    affectiveState?: AffectiveState | null,
    affectivePolicy?: AffectiveModulationPolicy | null,
  ): { ranked: RankedContextCandidate[]; tieBreaks: TieBreakRecord[] } {
    if (items.length === 0) return { ranked: [], tieBreaks: [] };

    // Convert to ContextCandidates, score each one, and wrap in RankedContextCandidate.
    // P7D: Layer is derived from each item's selectionClass inside itemToCandidate().
    const unranked: RankedContextCandidate[] = items.map((item, idx) => {
      const candidate = itemToCandidate(item, idx);

      // P7C: Compute affective adjustment when state and policy are available.
      // P7D: Use each candidate's own layerAssignment for the eligibility gate so that
      //      evidence and graph_context items are gated correctly within the unified pool.
      let affectiveAdjustment = 0;
      let affectiveReasonCode: string | null = null;
      if (affectiveState) {
        const candidateText = `${candidate.title ?? ''} ${candidate.content}`.toLowerCase();
        const targetLayer = candidate.layerAssignment as 'evidence' | 'graph_context';
        const result = this._affectiveWeightingService.computeAdjustment(
          candidateText,
          affectiveState,
          affectivePolicy ?? null,
          targetLayer,
        );
        affectiveAdjustment = result.adjustment;
        affectiveReasonCode = result.reasonCode;
      }

      const scoreBreakdown = this._scoringService.computeCandidateScore(candidate, affectiveAdjustment);
      return { ...candidate, scoreBreakdown, rank: 0, affectiveReasonCode };
    });

    // Apply deterministic total-order sort.
    const { sorted, tieBreakRecords } = applyDeterministicTieBreak(unranked);

    // Assign 1-indexed ranks in sorted order.
    for (let i = 0; i < sorted.length; i++) {
      sorted[i]!.rank = i + 1;
    }

    return { ranked: sorted, tieBreaks: tieBreakRecords };
  }

  /**
   * Build P7B ContextLayerBudgets from the active policy.
   *
   * P7D Feed 3: Layer budgets now reflect the global single-budget model.
   * Evidence and graph_context layers share the global maxItems cap.
   */
  private _buildLayerBudgets(policy: MemoryPolicy): ContextLayerBudget[] {
    const budget = policy.contextBudget;
    return [
      {
        layer: 'evidence',
        maxItems: budget.maxItems,
        maxTokens: budget.maxTokens,
        priority: 1,
        overflowPolicy: 'overflow_to_latent',
      },
      {
        layer: 'graph_context',
        maxItems: budget.maxItems,
        priority: 2,
        overflowPolicy: 'drop',
      },
      {
        layer: 'canonical_memory',
        maxItems: budget.maxItemsPerClass?.summary ?? 0,
        priority: 3,
        overflowPolicy: 'drop',
      },
    ];
  }

  /**
   * Build P7B ContextAssemblyDiagnostics from the collected pipeline data.
   */
  private _buildDiagnostics(args: {
    policy: MemoryPolicy;
    rankedAll: RankedContextCandidate[];
    rankedEvidence: RankedContextCandidate[];
    rankedGraph: RankedContextCandidate[];
    decisions: ContextDecision[];
    tieBreakRecords: TieBreakRecord[];
    conflictResolutionRecords: ConflictResolutionRecord[];
    graphContextItems: ContextAssemblyItem[];
    injected: ContextAssemblyItem[];
    latent: ContextAssemblyItem[];
  }): ContextAssemblyDiagnostics {
    const {
      policy, rankedAll, rankedEvidence, rankedGraph,
      decisions, tieBreakRecords, conflictResolutionRecords,
      graphContextItems, injected, latent,
    } = args;

    const layerBudgets = this._buildLayerBudgets(policy);

    // Build candidate pool by layer.
    const candidatePoolByLayer: ContextAssemblyDiagnostics['candidatePoolByLayer'] = {};
    if (rankedEvidence.length > 0) candidatePoolByLayer['evidence'] = rankedEvidence;
    if (rankedGraph.length > 0) candidatePoolByLayer['graph_context'] = rankedGraph;

    // Cross-layer diagnostics: unified candidate pool and rank order.
    const crossLayerCandidatePool = rankedAll;
    const crossLayerRankingOrder = rankedAll.map(rc => rc.id);
    const candidateById = new Map(rankedAll.map(candidate => [candidate.id, candidate]));

    // Partition included/excluded/truncated/latent candidate IDs.
    const includedCandidates: string[] = [];
    const excludedCandidates: string[] = [];
    const truncatedCandidates: string[] = [];
    const latentCandidates: string[] = [];
    const perSourceInclusionCounts: ContextAssemblyDiagnostics['perSourceInclusionCounts'] = {};
    const exclusionReasonsBySource: ContextAssemblyDiagnostics['exclusionReasonsBySource'] = {};

    const resolveSourceKey = (candidateId: string, fallback?: string) => {
      const candidate = candidateById.get(candidateId);
      return candidate?.sourceLayer ?? candidate?.sourceType ?? fallback ?? 'unknown';
    };

    for (const d of decisions) {
      if (d.status === 'included') {
        includedCandidates.push(d.candidateId);
        const sourceKey = resolveSourceKey(d.candidateId, d.sourceType);
        perSourceInclusionCounts[sourceKey] = (perSourceInclusionCounts[sourceKey] ?? 0) + 1;
      } else {
        if (d.status === 'excluded') excludedCandidates.push(d.candidateId);
        else if (d.status === 'truncated') truncatedCandidates.push(d.candidateId);
        else if (d.status === 'latent') latentCandidates.push(d.candidateId);

        const sourceKey = resolveSourceKey(d.candidateId, d.sourceType);
        const reasonCounts = exclusionReasonsBySource[sourceKey] ?? {};
        for (const reason of d.reasons) {
          reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
        }
        exclusionReasonsBySource[sourceKey] = reasonCounts;
      }
    }

    // Ensure sources with zero includes are still represented when present in the pool.
    for (const candidate of rankedAll) {
      const sourceKey = candidate.sourceLayer ?? candidate.sourceType ?? 'unknown';
      if (perSourceInclusionCounts[sourceKey] === undefined) {
        perSourceInclusionCounts[sourceKey] = 0;
      }
    }

    const normalizationBreakdown: ContextAssemblyDiagnostics['normalizationBreakdown'] =
      rankedAll.map(candidate => ({
        candidateId: candidate.id,
        sourceLayer: candidate.sourceLayer ?? undefined,
        finalScore: candidate.scoreBreakdown.finalScore,
        sourceWeight: candidate.scoreBreakdown.sourceWeight,
        tokenEfficiency: candidate.scoreBreakdown.tokenEfficiency,
        normalizedScore: candidate.scoreBreakdown.normalizedScore,
      }));

    // Compute final token usage by layer.
    const finalTokenUsageByLayer: ContextAssemblyDiagnostics['finalTokenUsageByLayer'] = {};
    const evidenceTokens = injected.reduce((s, i) => s + estimateTokens(i.content), 0);
    if (evidenceTokens > 0) finalTokenUsageByLayer['evidence'] = evidenceTokens;
    const graphTokens = graphContextItems.reduce((s, i) => s + estimateTokens(i.content), 0);
    if (graphTokens > 0) finalTokenUsageByLayer['graph_context'] = graphTokens;
    const latentTokens = latent.reduce((s, i) => s + estimateTokens(i.content), 0);
    if (latentTokens > 0) finalTokenUsageByLayer['canonical_memory'] = latentTokens;

    return {
      assemblyMode: policy.groundingMode,
      layerBudgets,
      candidatePoolByLayer,
      crossLayerCandidatePool,
      crossLayerRankingOrder,
      decisions,
      perSourceInclusionCounts,
      exclusionReasonsBySource,
      authorityConflictRecords: conflictResolutionRecords,
      normalizationBreakdown,
      includedCandidates,
      excludedCandidates,
      truncatedCandidates,
      latentCandidates,
      finalTokenUsageByLayer,
      tieBreakRecords,
      conflictResolutionRecords,
      totalCandidatesConsidered: rankedAll.length,
      totalIncluded: includedCandidates.length,
    };
  }

  /**
   * Merge structural and affective graph_context items into a single ordered list.
   *
   * P7C: The keyword-overlap boost that previously mutated structural item raw scores
   * has been moved into AffectiveWeightingService → _rankItems → affectiveAdjustment
   * component of ScoreBreakdown. This method now simply concatenates the two lists:
   * affective items first, structural items after. The final ordering is determined
   * deterministically by _rankItems() using the total-order comparator.
   *
   * Evidence items are never touched by this method.
   */
  private _mergeGraphContextItems(
    structuralItems: ContextAssemblyItem[],
    affectiveItems: ContextAssemblyItem[],
  ): ContextAssemblyItem[] {
    if (affectiveItems.length === 0) return structuralItems;
    if (structuralItems.length === 0) return affectiveItems;
    // Simple merge: affective items first. Final ordering is handled by _rankItems().
    return [...affectiveItems, ...structuralItems];
  }

  /**
   * P7C: Build a normalized AffectiveState from the affective graph_context items
   * returned by AffectiveGraphService.
   *
   * Sources:
   *   - emotion_tag items: metadata.moodLabel → key in moodVector, item.score → intensity.
   *   - astro_state items: metadata.rawAstroState.emotional_vector → entries in moodVector.
   *
   * Returns null when no affective items are present or no mood data is extractable.
   * The returned AffectiveState is used by AffectiveWeightingService to compute
   * keyword-overlap adjustments for evidence and graph_context candidates.
   */
  private _buildAffectiveStateFromItems(
    affectiveItems: ContextAssemblyItem[],
  ): AffectiveState | null {
    const moodVector: Record<string, number> = {};
    let dominantMood: string | undefined;
    let highestIntensity = -1;

    for (const item of affectiveItems) {
      // emotion_tag items: extract mood label with its intensity (item.score).
      const moodLabel = item.metadata?.moodLabel as string | undefined;
      if (moodLabel && typeof moodLabel === 'string' && moodLabel.trim().length > 0) {
        const key = moodLabel.trim().toLowerCase();
        const intensity = typeof item.score === 'number' ? item.score : 0.5;
        moodVector[key] = intensity;
        if (intensity > highestIntensity) {
          highestIntensity = intensity;
          dominantMood = moodLabel.trim();
        }
      }

      // astro_state items: extract emotional_vector component names as mood keys.
      if (item.metadata?.affectiveNodeType === 'astro_state') {
        const rawState = item.metadata?.rawAstroState as
          | { emotional_vector?: Record<string, number> }
          | null
          | undefined;
        if (rawState?.emotional_vector) {
          for (const [key, value] of Object.entries(rawState.emotional_vector)) {
            if (typeof value === 'number' && value > 0) {
              moodVector[key.toLowerCase()] = value;
            }
          }
        }
      }
    }

    if (Object.keys(moodVector).length === 0) return null;
    return { moodVector, dominantMood };
  }
}
