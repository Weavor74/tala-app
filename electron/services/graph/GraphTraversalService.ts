/**
 * GraphTraversalService.ts
 *
 * Minimal graph runtime layer for TALA context assembly (Step 6A).
 *
 * Responsibilities:
 *   1. Accept evidence ContextAssemblyItems as seed nodes.
 *   2. Derive a bounded set of related graph_context candidates from those seeds.
 *   3. Enforce policy.graphTraversal constraints: enabled, maxHopDepth,
 *      maxRelatedNodes, maxNodesPerType, minEdgeTrustLevel, allowedEdgeTypes.
 *   4. Return graph_context items ready for insertion into ContextAssemblyService
 *      before budget enforcement.
 *
 * DESIGN PRINCIPLES:
 *   - No separate graph database. Traversal is derived from evidence item metadata.
 *   - Evidence-anchored only: every graph_context item traces back to an evidence
 *     seed. No fabrication of unrelated or invented nodes.
 *   - Deterministic: same evidence + policy inputs always produce the same candidates.
 *   - Notebook boundary is the primary scope constraint. Evidence items are already
 *     retrieved within the active scope, so cross-scope expansion is never attempted.
 *   - Each graph_context item preserves edge type and trust level for prompt
 *     rendering and downstream diagnostics.
 *   - This is Step 6A. When a graph DB becomes available, expandFromEvidence()
 *     will route to it first and fall back to provenance-derived expansion when
 *     the DB is unavailable.
 *
 * Graph_context derivation in this pass (no DB):
 *   - Document co-occurrence: when 2+ evidence items share the same documentId,
 *     the source document is a graph node related to all of them via a 'contains'
 *     edge. One graph_context item is created per such document. Edge trust: 'derived'
 *     (rule-based inference from shared metadata, not explicit authoring).
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type {
  MemoryPolicy,
  ContextAssemblyItem,
  GraphEdgeType,
  EdgeTrustLevel,
  GraphTraversalPolicy,
  GraphNodeType,
} from '../../../shared/policy/memoryPolicyTypes';

// ─── Trust Level Ordering ─────────────────────────────────────────────────────

/**
 * Ordered from lowest to highest trust. Used for minEdgeTrustLevel filtering.
 * An edge passes the filter when its trust level is at or above the minimum.
 */
const TRUST_LEVEL_ORDER: EdgeTrustLevel[] = [
  'session_only',
  'inferred_low',
  'inferred_high',
  'derived',
  'explicit',
  'canonical',
];

// ─── GraphTraversalService ────────────────────────────────────────────────────

export class GraphTraversalService {

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Expand a set of evidence items into a bounded list of graph_context candidates.
   *
   * Returns an empty array when:
   *   - policy.graphTraversal.enabled is false.
   *   - policy.groundingMode is 'strict' (graph context is never added in strict mode).
   *   - evidenceItems is empty (no seed nodes to expand from).
   *
   * All returned items have selectionClass 'graph_context', a non-null graphEdgeType,
   * and a non-null graphEdgeTrust. Items are bounded by policy.graphTraversal caps
   * before being returned.
   */
  async expandFromEvidence(args: {
    evidenceItems: ContextAssemblyItem[];
    policy: MemoryPolicy;
  }): Promise<ContextAssemblyItem[]> {
    const { evidenceItems, policy } = args;
    const gt = policy.graphTraversal;

    // Guard: traversal disabled, strict mode, or no seeds.
    if (!gt.enabled || policy.groundingMode === 'strict' || evidenceItems.length === 0) {
      return [];
    }

    const candidates: ContextAssemblyItem[] = [];

    // ── Document co-occurrence expansion (hop depth ≥ 1) ─────────────────────
    // When multiple evidence chunks share the same documentId, the containing
    // document is an implicit graph node connected to all of them via 'contains'.
    // We emit one graph_context item per such document.
    if (gt.maxHopDepth >= 1) {
      const docNodes = this._deriveDocumentCooccurrenceNodes(evidenceItems);
      candidates.push(...docNodes);
    }

    // ── Edge type filter ──────────────────────────────────────────────────────
    const edgeFiltered = this._applyEdgeTypeFilter(candidates, gt.allowedEdgeTypes);

    // ── Trust level filter ────────────────────────────────────────────────────
    const trustFiltered = this._applyTrustFilter(edgeFiltered, gt.minEdgeTrustLevel);

    // ── Per-type and total node caps ──────────────────────────────────────────
    const bounded = this._applyNodeCaps(trustFiltered, gt);

    return bounded;
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Derive document-level graph_context nodes from evidence co-occurrence.
   *
   * For each unique documentId that appears on 2 or more evidence items, emit
   * one graph_context item representing the containing document. The item's
   * content is a structured listing of the evidence anchors found in that
   * document — no content is fabricated.
   *
   * graphEdgeType: 'contains' — the document contains the evidence chunks.
   * graphEdgeTrust: 'derived' — inferred from shared metadata, not explicit authoring.
   * graphNodeType: 'source_document'.
   */
  private _deriveDocumentCooccurrenceNodes(
    evidenceItems: ContextAssemblyItem[],
  ): ContextAssemblyItem[] {
    // Group evidence items by documentId.
    const byDoc = new Map<string, ContextAssemblyItem[]>();
    for (const item of evidenceItems) {
      const docId = (item.metadata?.documentId as string | undefined) ?? null;
      if (!docId) continue;
      const group = byDoc.get(docId) ?? [];
      group.push(item);
      byDoc.set(docId, group);
    }

    const results: ContextAssemblyItem[] = [];

    for (const [docId, members] of byDoc) {
      // Only create a graph_context node when 2 or more evidence chunks share
      // the same document. A single chunk does not imply a traversal relationship.
      if (members.length < 2) continue;

      const anchorItem = members[0];
      const docTitle = anchorItem.title ?? anchorItem.uri ?? docId;

      // Content is derived entirely from the anchor items' own metadata.
      const anchorList = members
        .map((m, i) => `  [${i + 1}] ${m.title ?? m.sourceKey ?? '(untitled)'}`)
        .join('\n');

      const content =
        `Source document contains ${members.length} evidence chunks:\n` +
        `Document: ${docTitle}\n` +
        `Evidence anchors:\n${anchorList}`;

      results.push({
        content,
        selectionClass: 'graph_context',
        sourceType: anchorItem.sourceType,
        sourceKey: docId,
        title: docTitle,
        uri: anchorItem.uri,
        score: null,
        graphEdgeType: 'contains',
        graphEdgeTrust: 'derived',
        metadata: {
          graphNodeType: 'source_document' satisfies GraphNodeType,
          anchorCount: members.length,
          anchorKeys: members.map(m => m.sourceKey).filter(Boolean),
          documentId: docId,
          derivedFrom: 'evidence_cooccurrence',
          hopDepth: 1,
        },
      });
    }

    return results;
  }

  /**
   * Filter graph_context candidates to only include items whose graphEdgeType
   * appears in allowedEdgeTypes. When allowedEdgeTypes is undefined or empty,
   * all edge types pass.
   */
  private _applyEdgeTypeFilter(
    items: ContextAssemblyItem[],
    allowedEdgeTypes?: GraphEdgeType[],
  ): ContextAssemblyItem[] {
    if (!allowedEdgeTypes || allowedEdgeTypes.length === 0) return items;
    return items.filter(
      item => item.graphEdgeType != null && allowedEdgeTypes.includes(item.graphEdgeType),
    );
  }

  /**
   * Filter graph_context candidates to only include items whose graphEdgeTrust
   * is at or above minTrustLevel in the TRUST_LEVEL_ORDER ranking. When
   * minTrustLevel is undefined, all trust levels pass.
   */
  private _applyTrustFilter(
    items: ContextAssemblyItem[],
    minTrustLevel?: EdgeTrustLevel,
  ): ContextAssemblyItem[] {
    if (!minTrustLevel) return items;
    const minIdx = TRUST_LEVEL_ORDER.indexOf(minTrustLevel);
    if (minIdx === -1) return items;
    return items.filter(item => {
      if (!item.graphEdgeTrust) return false;
      const itemIdx = TRUST_LEVEL_ORDER.indexOf(item.graphEdgeTrust);
      return itemIdx >= minIdx;
    });
  }

  /**
   * Apply maxNodesPerType and maxRelatedNodes caps to the candidate list.
   *
   * maxRelatedNodes is the hard total cap across all node types.
   * maxNodesPerType applies an additional per-type cap for types explicitly
   * listed in the policy. Types not in maxNodesPerType are subject only to
   * the total cap.
   *
   * Candidates are processed in input order (already ranked by derivation order).
   */
  private _applyNodeCaps(
    items: ContextAssemblyItem[],
    gt: GraphTraversalPolicy,
  ): ContextAssemblyItem[] {
    const typeCounters = new Map<string, number>();
    const result: ContextAssemblyItem[] = [];

    for (const item of items) {
      if (result.length >= gt.maxRelatedNodes) break;

      const nodeType =
        (item.metadata?.graphNodeType as string | undefined) ?? 'unknown';
      const typeCap = gt.maxNodesPerType[nodeType as GraphNodeType];

      if (typeCap !== undefined) {
        const used = typeCounters.get(nodeType) ?? 0;
        if (used >= typeCap) continue;
        typeCounters.set(nodeType, used + 1);
      }

      result.push(item);
    }

    return result;
  }
}
