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
 *   4. Enforce policy budget rules (maxItems, maxItemsPerClass, max chunks per doc).
 *   5. Classify items as 'evidence' (injected) or 'latent' (overflow).
 *   6. Return a structured ContextAssemblyResult.
 *   7. Provide renderPromptBlocks() for deterministic prompt string rendering.
 *
 * DESIGN PRINCIPLES:
 *   - Evidence-first: evidence items are always selected before any other class.
 *   - Deterministic: same inputs always produce the same outputs.
 *   - No graph fabrication: graph_context section is structurally supported but
 *     always empty in this pass (graph runtime does not exist yet).
 *   - No silent discards: overflow evidence moves to 'latent', not dropped.
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
} from '../../../shared/policy/memoryPolicyTypes';
import { MemoryPolicyService } from '../policy/MemoryPolicyService';

// ─── Approximate token estimator ─────────────────────────────────────────────
// Rough 4-chars-per-token heuristic. Sufficient for soft budget enforcement.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── ContextAssemblyService ───────────────────────────────────────────────────

export class ContextAssemblyService {
  constructor(
    private readonly orchestrator: RetrievalOrchestrator,
    private readonly policyService: MemoryPolicyService = new MemoryPolicyService(),
  ) {}

  // ─── Primary Entry Point ─────────────────────────────────────────────────

  /**
   * Assemble context for a single turn.
   *
   * Steps:
   *   1. Resolve the active MemoryPolicy.
   *   2. Retrieve candidates via RetrievalOrchestrator.
   *   3. Map retrieval results to ContextAssemblyItems with full provenance.
   *   4. Enforce budget: cap evidence items; move overflow to latent.
   *   5. Build the ContextAssemblyResult.
   */
  async assemble(request: ContextAssemblyRequest): Promise<ContextAssemblyResult> {
    const startMs = Date.now();
    const warnings: string[] = [];

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
    const candidates = retrievalResults.map((result, index) =>
      this._mapResultToItem(result, index),
    );

    // 4. Enforce evidence budget and produce latent overflow.
    const { injected, latent } = this._selectItems(candidates, policy, warnings);

    // 5. Combine injected (evidence) + latent items.
    const allItems: ContextAssemblyItem[] = [...injected, ...latent];

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

    return {
      items: allItems,
      policy,
      totalItems: allItems.length,
      itemCountByClass,
      estimatedTokens,
      durationMs: Date.now() - startMs,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ─── Prompt Block Renderer ────────────────────────────────────────────────

  /**
   * Render assembled context into a deterministic prompt string.
   *
   * Sections produced:
   *   [PRIMARY EVIDENCE]         — injected evidence items with source labels.
   *   [DIRECT GRAPH CONTEXT]     — omitted when no graph_context items exist.
   *   [POLICY CONSTRAINTS]       — groundingMode, retrievalMode, scope summary.
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

    // DIRECT GRAPH CONTEXT
    const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
    if (graphItems.length > 0) {
      const lines = graphItems.map((item, idx) => {
        const label = item.title ? `[G${idx + 1}] ${item.title}` : `[G${idx + 1}]`;
        const edge = item.graphEdgeType ? ` (edge: ${item.graphEdgeType})` : '';
        return `${label}${edge}\n${item.content}`;
      });
      sections.push(`[DIRECT GRAPH CONTEXT]\n${lines.join('\n\n')}`);
    }

    // POLICY CONSTRAINTS
    const policy = result.policy;
    const scopeLine = policy.notebookId
      ? `scope: ${policy.scope} (notebookId: ${policy.notebookId})`
      : `scope: ${policy.scope}`;
    const policyLines = [
      `groundingMode: ${policy.groundingMode}`,
      `retrievalMode: ${policy.retrievalMode}`,
      scopeLine,
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
   */
  private _selectItems(
    candidates: ContextAssemblyItem[],
    policy: MemoryPolicy,
    warnings: string[],
  ): { injected: ContextAssemblyItem[]; latent: ContextAssemblyItem[] } {
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

    for (const item of candidates) {
      if (injected.length >= evidenceCap) {
        // Budget exhausted — move to latent.
        latent.push({ ...item, selectionClass: 'latent' });
        continue;
      }

      // Check per-document chunk cap.
      const docId = (item.metadata?.documentId as string | undefined) ?? null;
      if (docId) {
        const used = chunksPerDoc.get(docId) ?? 0;
        if (used >= maxChunksPerDoc) {
          latent.push({ ...item, selectionClass: 'latent' });
          continue;
        }
        chunksPerDoc.set(docId, used + 1);
      }

      injected.push(item);
    }

    if (latent.length > 0) {
      warnings.push(
        `${latent.length} overflow item${latent.length === 1 ? '' : 's'} retained as latent memory due to policy budget limits.`,
      );
    }

    return { injected, latent };
  }
}
