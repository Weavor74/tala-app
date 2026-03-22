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
import type { MemoryAuthorityTier } from '../../../shared/memory/authorityTypes';
import { MemoryPolicyService } from '../policy/MemoryPolicyService';
import { GraphTraversalService } from '../graph/GraphTraversalService';
import { AffectiveGraphService } from '../graph/AffectiveGraphService';
import { ContextScoringService } from './ContextScoringService';
import { applyDeterministicTieBreak, compareContextCandidates } from './contextCandidateComparator';

// ─── Approximate token estimator ─────────────────────────────────────────────
// Rough 4-chars-per-token heuristic. Sufficient for soft budget enforcement.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Timestamp parser helper ──────────────────────────────────────────────────
function parseTimestampMs(ts: string | null | undefined): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return isNaN(ms) ? 0 : ms;
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
  layer: 'evidence' | 'graph_context',
  idx: number,
): ContextCandidate {
  // Use sourceKey as stable ID; fall back to URI, title, or positional key
  const id = item.sourceKey ?? item.uri ?? item.title ?? `${layer}-${idx}`;
  const authorityTier: MemoryAuthorityTier | null =
    item.selectionClass === 'graph_context'
      ? deriveAuthorityTierFromEdgeTrust(item.graphEdgeTrust)
      : null; // evidence items: null = neutral (scoring treats as 0.5)
  const timestamp = (item.metadata?.fetchedAt as string | undefined) ?? null;
  const graphHopDepth = item.selectionClass === 'graph_context' ? DEFAULT_GRAPH_HOP_DEPTH : 0;

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
 * Hard upper bound on affectiveWeight used when applying keyword-overlap boosts
 * to structural graph_context items. Shared with the clamping in AffectiveGraphService.
 */
const MAX_AFFECTIVE_WEIGHT = 0.3;

/**
 * Fraction of the clamped affectiveWeight applied as the maximum boost per
 * structural graph_context item when allowGraphOrderingInfluence is true.
 * Keeps affective signals from dominating structural provenance scoring.
 * E.g. affectiveWeight=0.1 → max boost = 0.05 per item.
 */
const AFFECTIVE_BOOST_FACTOR = 0.5;

/**
 * Score increment applied per matched keyword when computing the affective
 * ordering boost for structural graph_context items. Multiple keyword matches
 * accumulate, but the total is capped at AFFECTIVE_BOOST_FACTOR * clampedWeight.
 */
const KEYWORD_BOOST_INCREMENT = 0.05;

export class ContextAssemblyService {
  private readonly _scoringService = new ContextScoringService();

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
   * P7B deterministic pipeline stages:
   *   1.  Resolve the active MemoryPolicy.
   *   2.  Retrieve candidates via RetrievalOrchestrator.
   *   3.  Map retrieval results to ContextAssemblyItems with full provenance.
   *   3P. Score and sort evidence candidates with total-order comparator (P7B).
   *   3.5 Expand structural graph context via GraphTraversalService.
   *   3.6 Add affective graph context via AffectiveGraphService (optional).
   *   3.7 Merge structural + affective graph_context; score and sort deterministically.
   *   4.  Enforce evidence budget: cap evidence items; move overflow to latent.
   *       Record inclusion/exclusion decisions for every candidate.
   *   5.  Combine injected (evidence) + graph_context + latent items.
   *   6.  Build class counts.
   *   7.  Estimate tokens.
   *   8.  Build P7B diagnostics.
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

    // 3P. P7B: Score and sort evidence candidates deterministically before selection.
    //     This replaces reliance on retrieval order and eliminates selection drift.
    const { ranked: rankedEvidence, tieBreaks: evidenceTieBreaks } =
      this._rankItems(rawCandidates, 'evidence');
    allTieBreaks.push(...evidenceTieBreaks);
    const sortedEvidenceCandidates = rankedEvidence.map(rankedCandidateToItem);

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

    // 3.7. Merge structural and affective graph_context items; score and sort
    //      deterministically before applying the graph_context class budget cap.
    const graphCap = policy.contextBudget.maxItemsPerClass?.graph_context ?? 0;
    const mergedGraphCandidates = this._mergeGraphContextItems(
      structuralGraphItems,
      affectiveItems,
      policy,
    );

    // P7B: Score and sort the merged graph candidates with total-order comparator.
    const { ranked: rankedGraph, tieBreaks: graphTieBreaks } =
      this._rankItems(mergedGraphCandidates, 'graph_context');
    allTieBreaks.push(...graphTieBreaks);
    const sortedGraphItems = rankedGraph.map(rankedCandidateToItem);

    // Apply graph_context cap. Candidates beyond the cap are recorded as excluded.
    const graphContextItems = sortedGraphItems.slice(0, graphCap);
    for (const rc of rankedGraph.slice(0, graphCap)) {
      allDecisions.push({
        candidateId: rc.id,
        sourceType: rc.sourceType,
        authorityTier: rc.authorityTier,
        finalScore: rc.scoreBreakdown.finalScore,
        estimatedTokens: rc.estimatedTokens,
        status: 'included',
        layerAssignment: 'graph_context',
        reasons: ['included.top_ranked_within_budget'],
      });
    }
    for (const rc of rankedGraph.slice(graphCap)) {
      allDecisions.push({
        candidateId: rc.id,
        sourceType: rc.sourceType,
        authorityTier: rc.authorityTier,
        finalScore: rc.scoreBreakdown.finalScore,
        estimatedTokens: rc.estimatedTokens,
        status: 'excluded',
        layerAssignment: 'graph_context',
        reasons: ['excluded.layer_budget_exceeded'],
      });
    }

    // 4. Enforce evidence budget and produce latent overflow.
    //    Input is now deterministically sorted (step 3P).
    const { injected, latent, decisions: evidenceDecisions } = this._selectItems(
      sortedEvidenceCandidates,
      rankedEvidence,
      policy,
      warnings,
    );
    allDecisions.push(...evidenceDecisions);

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
      rankedEvidence,
      rankedGraph,
      decisions: allDecisions,
      tieBreakRecords: allTieBreaks,
      conflictResolutionRecords,
      graphCap,
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
   * P7B: Score and sort a list of ContextAssemblyItems deterministically.
   *
   * Pipeline:
   *   1. Convert items to ContextCandidates.
   *   2. Score each with ContextScoringService.
   *   3. Wrap in RankedContextCandidates.
   *   4. Sort with applyDeterministicTieBreak (total-order comparator).
   *   5. Assign 1-indexed ranks.
   *
   * Returns the ranked (sorted) candidates and any tie-break records.
   */
  private _rankItems(
    items: ContextAssemblyItem[],
    layer: 'evidence' | 'graph_context',
  ): { ranked: RankedContextCandidate[]; tieBreaks: TieBreakRecord[] } {
    if (items.length === 0) return { ranked: [], tieBreaks: [] };

    // Convert to ContextCandidates and score each one.
    const unranked: RankedContextCandidate[] = items.map((item, idx) => {
      const candidate = itemToCandidate(item, layer, idx);
      const scoreBreakdown = this._scoringService.computeCandidateScore(candidate);
      return { ...candidate, scoreBreakdown, rank: 0 };
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
   */
  private _buildLayerBudgets(policy: MemoryPolicy): ContextLayerBudget[] {
    const budget = policy.contextBudget;
    return [
      {
        layer: 'evidence',
        maxItems: budget.maxItemsPerClass?.evidence ?? budget.maxItems,
        maxTokens: budget.maxTokens,
        priority: 1,
        overflowPolicy: 'overflow_to_latent',
      },
      {
        layer: 'graph_context',
        maxItems: budget.maxItemsPerClass?.graph_context ?? 0,
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
    rankedEvidence: RankedContextCandidate[];
    rankedGraph: RankedContextCandidate[];
    decisions: ContextDecision[];
    tieBreakRecords: TieBreakRecord[];
    conflictResolutionRecords: ConflictResolutionRecord[];
    graphCap: number;
    injected: ContextAssemblyItem[];
    latent: ContextAssemblyItem[];
  }): ContextAssemblyDiagnostics {
    const {
      policy, rankedEvidence, rankedGraph,
      decisions, tieBreakRecords, conflictResolutionRecords,
      graphCap, injected, latent,
    } = args;

    const layerBudgets = this._buildLayerBudgets(policy);

    // Build candidate pool by layer.
    const candidatePoolByLayer: ContextAssemblyDiagnostics['candidatePoolByLayer'] = {};
    if (rankedEvidence.length > 0) candidatePoolByLayer['evidence'] = rankedEvidence;
    if (rankedGraph.length > 0) candidatePoolByLayer['graph_context'] = rankedGraph;

    // Partition included/excluded/truncated/latent candidate IDs.
    const includedCandidates: string[] = [];
    const excludedCandidates: string[] = [];
    const truncatedCandidates: string[] = [];
    const latentCandidates: string[] = [];
    for (const d of decisions) {
      if (d.status === 'included') includedCandidates.push(d.candidateId);
      else if (d.status === 'excluded') excludedCandidates.push(d.candidateId);
      else if (d.status === 'truncated') truncatedCandidates.push(d.candidateId);
      else if (d.status === 'latent') latentCandidates.push(d.candidateId);
    }

    // Compute final token usage by layer.
    const finalTokenUsageByLayer: ContextAssemblyDiagnostics['finalTokenUsageByLayer'] = {};
    const evidenceTokens = injected.reduce((s, i) => s + estimateTokens(i.content), 0);
    if (evidenceTokens > 0) finalTokenUsageByLayer['evidence'] = evidenceTokens;
    const graphTokens = rankedGraph
      .slice(0, graphCap)
      .reduce((s, rc) => s + rc.estimatedTokens, 0);
    if (graphTokens > 0) finalTokenUsageByLayer['graph_context'] = graphTokens;
    const latentTokens = latent.reduce((s, i) => s + estimateTokens(i.content), 0);
    if (latentTokens > 0) finalTokenUsageByLayer['canonical_memory'] = latentTokens;

    return {
      assemblyMode: policy.groundingMode,
      layerBudgets,
      candidatePoolByLayer,
      decisions,
      includedCandidates,
      excludedCandidates,
      truncatedCandidates,
      latentCandidates,
      finalTokenUsageByLayer,
      tieBreakRecords,
      conflictResolutionRecords,
      totalCandidatesConsidered: rankedEvidence.length + rankedGraph.length,
      totalIncluded: includedCandidates.length,
    };
  }

  /**
   * Merge structural and affective graph_context items into a single ordered list.
   *
   * Ordering rules:
   *   - When allowGraphOrderingInfluence is false (default):
   *       Affective items appear first (bounded), then structural items in their
   *       original order. Evidence ordering is never touched.
   *   - When allowGraphOrderingInfluence is true:
   *       Affective items remain first. Structural graph_context items receive a
   *       small, bounded score boost when their title/content overlaps with active
   *       affective keywords (mood labels, astro tag words). Structural items are
   *       then sorted by boosted score descending.
   *       The boost is capped at affectiveWeight × 0.5 (max 0.15) to prevent
   *       affective signals from dominating structural provenance.
   *
   * Evidence items are never touched by this method.
   */
  private _mergeGraphContextItems(
    structuralItems: ContextAssemblyItem[],
    affectiveItems: ContextAssemblyItem[],
    policy: MemoryPolicy,
  ): ContextAssemblyItem[] {
    if (affectiveItems.length === 0) {
      return structuralItems;
    }
    if (structuralItems.length === 0) {
      return affectiveItems;
    }

    const ap = policy.affectiveModulation;
    if (!ap?.allowGraphOrderingInfluence) {
      // Simple placement: affective items first, then structural items unchanged.
      return [...affectiveItems, ...structuralItems];
    }

    // allowGraphOrderingInfluence: apply keyword-overlap boost to structural items.
    const affectiveKeywords = this._extractAffectiveKeywords(affectiveItems);
    const clampedWeight = Math.min(ap.affectiveWeight, MAX_AFFECTIVE_WEIGHT);
    const maxBoostPerItem = clampedWeight * AFFECTIVE_BOOST_FACTOR;

    const boostedStructural = structuralItems.map(item => {
      if (affectiveKeywords.size === 0) return item;
      const itemText = `${item.title ?? ''} ${item.content}`.toLowerCase();
      let boost = 0;
      for (const kw of affectiveKeywords) {
        if (itemText.includes(kw)) {
          boost += KEYWORD_BOOST_INCREMENT;
        }
      }
      if (boost === 0) return item;
      const baseScore = item.score ?? 0;
      return { ...item, score: baseScore + Math.min(boost, maxBoostPerItem) };
    });

    // P7B: Sort structural items using a deterministic total-order comparator.
    // Replaces the previous simple (b.score ?? 0) - (a.score ?? 0) which
    // left ties unresolved. The comparator applies: score desc → tokenCost asc →
    // timestamp desc → lexical sourceKey asc.
    const sortedStructural = boostedStructural
      .slice()
      .sort((a, b) => {
        const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const tokenDiff = estimateTokens(a.content) - estimateTokens(b.content);
        if (tokenDiff !== 0) return tokenDiff;
        const tsA = parseTimestampMs(a.metadata?.fetchedAt as string | undefined);
        const tsB = parseTimestampMs(b.metadata?.fetchedAt as string | undefined);
        const tsDiff = tsB - tsA;
        if (tsDiff !== 0) return tsDiff;
        return (a.sourceKey ?? '') < (b.sourceKey ?? '') ? -1 : 1;
      });
    return [...affectiveItems, ...sortedStructural];
  }

  /**
   * Extract simple lowercase keywords from affective items for overlap scoring.
   *
   * Sources:
   *   - metadata.moodLabel (e.g., "Urgency" → "urgency", "urgent")
   *   - title suffix after ':' (e.g., "Mood: Calm" → "calm")
   *
   * Only words of 3+ characters are included. This is intentionally minimal:
   * no stemming, no ML — just deterministic keyword presence checks.
   */
  private _extractAffectiveKeywords(affectiveItems: ContextAssemblyItem[]): Set<string> {
    const keywords = new Set<string>();
    for (const item of affectiveItems) {
      const moodLabel = item.metadata?.moodLabel as string | undefined;
      if (moodLabel) {
        keywords.add(moodLabel.toLowerCase());
        for (const word of moodLabel.toLowerCase().split(/\s+/)) {
          if (word.length >= 3) keywords.add(word);
        }
      }
      // Extract from title format "Mood: <label>" or "Affective state (astro)"
      const title = item.title ?? '';
      const colonIdx = title.indexOf(':');
      if (colonIdx !== -1) {
        const part = title.slice(colonIdx + 1).trim().toLowerCase();
        if (part.length >= 3) keywords.add(part);
        for (const word of part.split(/\s+/)) {
          if (word.length >= 3) keywords.add(word);
        }
      }
    }
    return keywords;
  }
}
