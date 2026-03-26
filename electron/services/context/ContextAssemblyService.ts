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
  ContextLayerName,
} from '../../../shared/context/contextDeterminismTypes';
import type { AffectiveState } from '../../../shared/context/affectiveWeightingTypes';
import type { MemoryAuthorityTier } from '../../../shared/memory/authorityTypes';
import {
  ContextStrategyMode,
  ContextStrategyResolution,
} from '../../../shared/context/contextStrategyTypes';
import { MemoryPolicyService } from '../policy/MemoryPolicyService';
import { GraphTraversalService } from '../graph/GraphTraversalService';
import { AffectiveGraphService } from '../graph/AffectiveGraphService';
import { ContextScoringService } from './ContextScoringService';
import { AffectiveWeightingService } from './AffectiveWeightingService';
import { ContextStrategyResolver } from './ContextStrategyResolver';
import { applyDeterministicTieBreak, compareContextCandidates } from './contextCandidateComparator';
import { resolveMemoryAuthorityConflict } from './authorityConflictResolver';
import { NOTEBOOK_GROUNDING_CONTRACT_TEXT } from '../plan/notebookGroundingContract';

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
    sourceType: rc.sourceType ?? undefined,
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
  private readonly _strategyResolver = new ContextStrategyResolver();

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

    // 1. Resolve active base policy.
    const basePolicy = this.policyService.resolvePolicy(request);

    // P7E: Resolve Adaptive Context Strategy.
    const strategy = this._strategyResolver.resolveContextStrategy(basePolicy);

    // P7E: Apply strategy-aware budget adjustments to a cloned policy.
    const policy = this._applyStrategyBudgetAdjustments(basePolicy, strategy);

    // 2. Retrieve candidates.
    let retrievalResults: NormalizedSearchResult[] = [];
    try {
      const response = await this.orchestrator.retrieve({
        query: request.query,
        mode: policy.retrievalMode,
        scope: policy.scope,
        notebookId: policy.notebookId,
        explicitSources: policy.explicitSources,
        topK: (policy.contextBudget.maxItems + 5) * 3, // over-fetch with strategy headroom
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

    // 3.5. Expand structural graph context from evidence candidates.
    let structuralGraphItems: ContextAssemblyItem[] = [];
    if (policy.graphTraversal.enabled && policy.groundingMode !== 'strict') {
      try {
        structuralGraphItems = await this.graphTraversalService.expandFromEvidence({
          evidenceItems: rawCandidates,
          policy,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Graph traversal failed: ${msg}`);
      }
    }

    // 3.6. Affective context.
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

    // P7C: Build AffectiveState.
    const affectiveState = this._buildAffectiveStateFromItems(affectiveItems);

    // 3.7. Merge structural and affective graph_context items.
    const mergedGraphCandidates = this._mergeGraphContextItems(
      structuralGraphItems,
      affectiveItems,
    );

    // P7D: Score and sort ALL candidates in ONE unified pass.
    const allRawItems = [...rawCandidates, ...mergedGraphCandidates];
    const { rankedAll, tieBreaks } = this._scoreAndRankCandidates({
      items: allRawItems,
      affectiveState,
      policy,
      weightMultipliers: strategy.appliedWeightMultipliers,
    });
    allTieBreaks.push(...tieBreaks);

    // Split unified ranked pool by layer assignment for diagnostics.
    const rankedEvidence = rankedAll.filter(rc => rc.layerAssignment === 'evidence');
    const rankedGraph = rankedAll.filter(rc => rc.layerAssignment === 'graph_context');

    // P7D: Global competitive selection.
    const {
      injected,
      graphContextItems,
      latent,
      decisions: selectionDecisions,
      conflictRecords,
    } = this._selectItemsGlobal(rankedAll, policy, warnings);
    allDecisions.push(...selectionDecisions);
    conflictResolutionRecords.push(...conflictRecords);

    // 5. Combine results.
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
      strategy,
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

  // ─── Notebook Strict Grounding Contract ─────────────────────────────────────

  /**
   * Strict grounding contract injected at the top of notebook-scoped prompts.
   *
   * Sourced from the shared constant so the text lives in a single place.
   * Placed before [CANON NOTEBOOK CONTEXT — STRICT] so the model reads the rules
   * before processing any evidence. Uses OVERRIDE language to take precedence over
   * all other style and behaviour directives in the broader system prompt.
   */
  private static readonly NOTEBOOK_GROUNDING_CONTRACT = NOTEBOOK_GROUNDING_CONTRACT_TEXT;

  // ─── Prompt Block Renderer ────────────────────────────────────────────────

  /**
   * Render assembled context into a deterministic prompt string.
   *
   * Notebook strict mode (groundingMode === 'strict' + scope === 'notebook'):
   *   - Prepends [NOTEBOOK GROUNDING CONTRACT — MANDATORY] before any evidence.
   *   - Labels evidence as [CANON NOTEBOOK CONTEXT — STRICT] with explicit source URIs.
   *   - Omits [DIRECT GRAPH CONTEXT] and [AFFECTIVE CONTEXT] (both are disabled by
   *     DEFAULT_STRICT_POLICY, so they will not be present at this point; the guard
   *     here is a belt-and-suspenders safeguard).
   */
  renderPromptBlocks(result: ContextAssemblyResult): string {
    const sections: string[] = [];
    const policy = result.policy;
    const isNotebookStrict =
      policy.groundingMode === 'strict' && policy.scope === 'notebook';

    // NOTEBOOK GROUNDING CONTRACT (injected first so the model reads rules before evidence)
    if (isNotebookStrict) {
      sections.push(
        `[NOTEBOOK GROUNDING CONTRACT — MANDATORY]\n${ContextAssemblyService.NOTEBOOK_GROUNDING_CONTRACT}`,
      );
    }

    // EVIDENCE BLOCK — label differs between notebook-strict and standard modes
    const evidenceItems = result.items.filter(i => i.selectionClass === 'evidence');
    if (evidenceItems.length > 0) {
      const lines = evidenceItems.map((item, idx) => {
        const label = item.title ? `[${idx + 1}] ${item.title}` : `[${idx + 1}]`;
        const source = item.uri ?? item.metadata?.sourcePath ?? item.sourceKey ?? '';
        const sourceLabel = source ? ` (${source})` : '';
        return `${label}${sourceLabel}\n${item.content}`;
      });
      const blockHeader = isNotebookStrict
        ? '[CANON NOTEBOOK CONTEXT — STRICT]'
        : '[PRIMARY EVIDENCE]';
      sections.push(`${blockHeader}\n${lines.join('\n\n')}`);
    }

    // DIRECT GRAPH CONTEXT — omitted in notebook strict mode (belt-and-suspenders guard)
    if (!isNotebookStrict) {
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
    }

    // AFFECTIVE CONTEXT — omitted in notebook strict mode (belt-and-suspenders guard)
    if (!isNotebookStrict) {
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
    }

    // POLICY CONSTRAINTS
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
   * Map a NormalizedSearchResult to a ContextAssemblyItem.
   */
  private _mapResultToItem(
    result: NormalizedSearchResult,
    rank: number,
  ): ContextAssemblyItem {
    const meta = result.metadata ?? {};
    const content = (meta.chunkContent as string | undefined) ?? result.snippet ?? '';
    const enrichedMetadata: Record<string, unknown> = {
      ...meta,
      rank,
      providerId: result.providerId,
      contentHash: result.contentHash ?? null,
      sourcePath: result.sourcePath ?? null,
      externalId: result.externalId ?? null,
      chunkId: (meta.chunkId as string | undefined) ?? null,
      documentId: (meta.documentId as string | undefined) ?? null,
      charStart: (meta.charStart as number | undefined) ?? null,
      charEnd: (meta.charEnd as number | undefined) ?? null,
      sectionLabel: (meta.sectionLabel as string | undefined) ?? null,
      pageNumber: (meta.pageNumber as number | undefined) ?? null,
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
   * P7D Feed 3: Select items using a single global budget.
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
    const maxChunksPerDoc = Math.max(1, Math.ceil(globalItemCap / 2));

    const mustIncludeIds = new Set<string>();
    if (minCanonical > 0) {
      const canonicals = rankedAll.filter(rc => rc.authorityTier === 'canonical');
      const floorCount = Math.min(minCanonical, canonicals.length);
      for (let i = 0; i < floorCount; i++) {
        mustIncludeIds.add(canonicals[i]!.id);
      }
    }

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

      if (isConflictLoser) {
        decisions.push({
          candidateId: rc.id,
          sourceType: rc.sourceType,
          authorityTier: rc.authorityTier,
          finalScore: rc.scoreBreakdown.finalScore,
          estimatedTokens: tokenCost,
          status: 'excluded',
          layerAssignment: rc.layerAssignment,
          reasons: [isSupporting ? 'excluded.superseded_by_canonical' : 'excluded.authority_conflict'],
          conflictResolved: true,
          affectiveAdjustment: rc.scoreBreakdown.affectiveAdjustment || null,
          affectiveReasonCode: rc.affectiveReasonCode ?? null,
        });
        continue;
      }

      const budgetExhausted =
        !isMustInclude &&
        (totalIncluded >= globalItemCap ||
          (globalTokenCap !== Infinity && totalTokensUsed + tokenCost > globalTokenCap));

      if (budgetExhausted) {
        if (isEvidence) {
          latent.push({ ...rankedCandidateToItem(rc), selectionClass: 'latent' });
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

      const item = rankedCandidateToItem(rc);
      if (isEvidence) {
        injected.push(item);
        const docId = (rc.metadata?.documentId as string | undefined) ?? null;
        if (docId) chunksPerDoc.set(docId, (chunksPerDoc.get(docId) ?? 0) + 1);
      } else {
        graphContextItems.push(item);
      }

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
   * P7E: Score and sort a unified list of ContextAssemblyItems.
   */
  private _scoreAndRankCandidates(params: {
    items: ContextAssemblyItem[];
    affectiveState: AffectiveState | null;
    policy: MemoryPolicy;
    weightMultipliers: Record<string, number>;
  }): { rankedAll: RankedContextCandidate[]; tieBreaks: TieBreakRecord[] } {
    const { items, affectiveState, policy, weightMultipliers } = params;

    const itemToCandidate = (item: ContextAssemblyItem, rank: number): RankedContextCandidate => {
      const isAffective = !!item.metadata?.affective;
      const isMemory = item.sourceType === 'session_memory' || item.sourceType === 'summary';
      const isGraph = item.sourceType === 'graph_node';
      
      const layerAssignment: ContextLayerName = isAffective || isGraph ? 'graph_context' : (isMemory ? 'canonical_memory' : 'evidence');
      const sourceLayer = (isGraph || isAffective) ? 'graph' : (isMemory ? 'canonical_memory' : 'rag');
      const id = item.sourceKey ?? `unknown-${rank}`;
      
      // Map authority from metadata or graphEdgeTrust
      const authorityTier = (item.metadata?.authorityTier as MemoryAuthorityTier | undefined) 
        || deriveAuthorityTierFromEdgeTrust(item.graphEdgeTrust);

      const candidate: RankedContextCandidate = {
        id,
        content: item.content,
        title: item.title,
        uri: item.uri,
        sourceType: item.sourceType ?? undefined,
        sourceKey: item.sourceKey,
        timestamp: (item.metadata?.fetchedAt as string | undefined) ?? undefined,
        authorityTier,
        isCanonical: authorityTier === 'canonical',
        score: item.score ?? 0,
        sourceLayer,
        estimatedTokens: estimateTokens(item.content),
        graphHopDepth: (item.metadata?.graphHopDepth as number | undefined) ?? 0,
        canonicalId: item.metadata?.canonicalId as string | undefined,
        selectionClass: item.selectionClass,
        layerAssignment,
        graphEdgeType: item.graphEdgeType ?? null,
        graphEdgeTrust: item.graphEdgeTrust ?? null,
        metadata: item.metadata,
        scoreBreakdown: {} as any, // Will be filled in map
        rank: 0,
      };

      return candidate;
    };

    const unranked: RankedContextCandidate[] = items.map((item, idx) => {
      const candidate = itemToCandidate(item, idx);
      const affectEnabled = candidate.layerAssignment === 'graph_context'
        ? policy.affectiveModulation?.enabled
        : (policy.affectiveModulation?.enabled && policy.affectiveModulation?.allowEvidenceReordering);
      
      const result = this._affectiveWeightingService.computeAdjustment(
        `${candidate.title ?? ''} ${candidate.content}`.toLowerCase(),
        affectiveState,
        policy.affectiveModulation ?? null,
        candidate.layerAssignment as 'evidence' | 'graph_context',
      );
      const affectiveAdjustment = affectEnabled ? result.adjustment : 0;
      const affectiveReasonCode = result.reasonCode;
      const scoreBreakdown = this._scoringService.computeCandidateScore(candidate, affectiveAdjustment, undefined, weightMultipliers);

      return { ...candidate, scoreBreakdown, rank: 0, affectiveReasonCode };
    });

    const { sorted, tieBreakRecords } = applyDeterministicTieBreak(unranked);
    for (let i = 0; i < sorted.length; i++) {
      sorted[i]!.rank = i + 1;
    }
    return { rankedAll: sorted, tieBreaks: tieBreakRecords };
  }

  /**
   * P7E: Apply strategy-aware budget adjustments to a cloned policy.
   */
  private _applyStrategyBudgetAdjustments(
    basePolicy: MemoryPolicy,
    strategy: ContextStrategyResolution,
  ): MemoryPolicy {
    const policy = JSON.parse(JSON.stringify(basePolicy)) as MemoryPolicy;
    const budget = policy.contextBudget;

    Object.entries(strategy.appliedBudgetAdjustments).forEach(([layerName, adjustment]) => {
      // 1. Apply global budget adjustments (only if 'evidence' layer is adjusted)
      if (layerName === 'evidence') {
        const currentItems = budget.maxItems ?? 10;
        const currentTokens = budget.maxTokens ?? 4000;

        if (adjustment.maxTokensMod && adjustment.maxTokensMod !== 0) {
          budget.maxTokens = Math.max(1000, Math.min(128000, currentTokens + adjustment.maxTokensMod));
        }
        if (adjustment.maxItemsMod && adjustment.maxItemsMod !== 0) {
          budget.maxItems = Math.max(1, Math.min(100, currentItems + adjustment.maxItemsMod));
        }
      }

      // 2. Apply per-class adjustments
      const classMap: Record<string, MemorySelectionClass> = {
        'evidence': 'evidence',
        'graph_context': 'graph_context',
        'canonical_memory': 'summary', // Mapped based on _buildLayerBudgets usage
        'summary': 'summary',
      };

      const targetClass = classMap[layerName];
      if (targetClass && adjustment.maxItemsMod && adjustment.maxItemsMod !== 0) {
        if (!budget.maxItemsPerClass) budget.maxItemsPerClass = {};
        const currentClassLimit = budget.maxItemsPerClass[targetClass] ?? (layerName === 'evidence' ? budget.maxItems : 5);
        budget.maxItemsPerClass[targetClass] = Math.max(0, currentClassLimit + adjustment.maxItemsMod);
      }
    });

    return policy;
  }

  private _buildLayerBudgets(policy: MemoryPolicy): ContextLayerBudget[] {
    const budget = policy.contextBudget;
    return [
      { layer: 'evidence', maxItems: budget.maxItems, maxTokens: budget.maxTokens, priority: 1, overflowPolicy: 'overflow_to_latent' },
      { layer: 'graph_context', maxItems: budget.maxItems, priority: 2, overflowPolicy: 'drop' },
      { layer: 'canonical_memory', maxItems: budget.maxItemsPerClass?.summary ?? 0, priority: 3, overflowPolicy: 'drop' },
    ];
  }

  /**
   * P7E: Build diagnostics including strategy trace.
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
    strategy: ContextStrategyResolution;
  }): ContextAssemblyDiagnostics {
    const { policy, rankedAll, decisions, tieBreakRecords, conflictResolutionRecords, graphContextItems, injected, latent, strategy } = args;
    const layerBudgets = this._buildLayerBudgets(policy);
    const crossLayerRankingOrder = rankedAll.map(rc => rc.id);
    const candidateById = new Map(rankedAll.map(candidate => [candidate.id, candidate]));

    const includedCandidates: string[] = [];
    const excludedCandidates: string[] = [];
    const truncatedCandidates: string[] = [];
    const latentCandidates: string[] = [];
    const perSourceInclusionCounts: Record<string, number> = {};
    const exclusionReasonsBySource: Record<string, Record<string, number>> = {};

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

    const normalizationBreakdown = rankedAll.map(candidate => ({
      candidateId: candidate.id,
      sourceLayer: candidate.sourceLayer ?? undefined,
      finalScore: candidate.scoreBreakdown.finalScore,
      sourceWeight: candidate.scoreBreakdown.sourceWeight,
      tokenEfficiency: candidate.scoreBreakdown.tokenEfficiency,
      normalizedScore: candidate.scoreBreakdown.normalizedScore,
    }));

    const finalTokenUsageByLayer: Partial<Record<ContextLayerName, number>> = {};
    const evidenceTokens = injected.reduce((s, i) => s + estimateTokens(i.content), 0);
    if (evidenceTokens > 0) finalTokenUsageByLayer['evidence'] = evidenceTokens;
    const graphTokens = graphContextItems.reduce((s, i) => s + estimateTokens(i.content), 0);
    if (graphTokens > 0) finalTokenUsageByLayer['graph_context'] = graphTokens;
    const latentTokens = latent.reduce((s, i) => s + estimateTokens(i.content), 0);
    if (latentTokens > 0) finalTokenUsageByLayer['canonical_memory'] = latentTokens;

    return {
      assemblyMode: policy.groundingMode,
      layerBudgets,
      candidatePoolByLayer: {
        evidence: rankedAll.filter(rc => rc.layerAssignment === 'evidence'),
        graph_context: rankedAll.filter(rc => rc.layerAssignment === 'graph_context'),
      },
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
      crossLayerCandidatePool: rankedAll,
      crossLayerRankingOrder,
      authorityConflicts: conflictResolutionRecords,
      perSourceCounts: this._computePerSourceCounts(rankedAll),
      exclusionBreakdown: this._computeExclusionBreakdown(decisions),
      normalizationDetails: this._computeNormalizationDetails(rankedAll),
      strategyResolution: strategy,
      strategyMode: strategy.profile.mode,
    };
  }

  private _computePerSourceCounts(pool: RankedContextCandidate[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const rc of pool) {
      const source = rc.sourceLayer ?? 'unknown';
      counts[source] = (counts[source] ?? 0) + 1;
    }
    return counts;
  }

  private _computeExclusionBreakdown(decisions: ContextDecision[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const d of decisions) {
      if (d.status === 'excluded' || d.status === 'latent' || d.status === 'truncated') {
        const primaryReason = d.reasons[0] ?? 'unknown';
        counts[primaryReason] = (counts[primaryReason] ?? 0) + 1;
      }
    }
    return counts;
  }

  private _computeNormalizationDetails(pool: RankedContextCandidate[]): Record<string, any> {
    if (pool.length === 0) return { min: 0, max: 0, avg: 0 };
    let min = Infinity; let max = -Infinity; let sum = 0;
    for (const rc of pool) {
      const s = rc.scoreBreakdown.normalizedScore;
      if (s < min) min = s; if (s > max) max = s; sum += s;
    }
    return { min, max, avg: sum / pool.length, candidateCount: pool.length };
  }

  private _mergeGraphContextItems(structuralItems: ContextAssemblyItem[], affectiveItems: ContextAssemblyItem[]): ContextAssemblyItem[] {
    if (affectiveItems.length === 0) return structuralItems;
    if (structuralItems.length === 0) return affectiveItems;
    return [...affectiveItems, ...structuralItems];
  }

  private _buildAffectiveStateFromItems(affectiveItems: ContextAssemblyItem[]): AffectiveState | null {
    const moodVector: Record<string, number> = {};
    let dominantMood: string | undefined;
    let highestIntensity = -1;

    for (const item of affectiveItems) {
      const moodLabel = item.metadata?.moodLabel as string | undefined;
      if (moodLabel && typeof moodLabel === 'string' && moodLabel.trim().length > 0) {
        const key = moodLabel.trim().toLowerCase();
        const intensity = typeof item.score === 'number' ? item.score : 0.5;
        moodVector[key] = intensity;
        if (intensity > highestIntensity) { highestIntensity = intensity; dominantMood = moodLabel.trim(); }
      }
      if (item.metadata?.affectiveNodeType === 'astro_state') {
        const rawState = item.metadata?.rawAstroState as { emotional_vector?: Record<string, number> } | null | undefined;
        if (rawState?.emotional_vector) {
          for (const [key, value] of Object.entries(rawState.emotional_vector)) {
            if (typeof value === 'number' && value > 0) { moodVector[key.toLowerCase()] = value; }
          }
        }
      }
    }
    if (Object.keys(moodVector).length === 0) return null;
    return { moodVector, dominantMood };
  }
}
