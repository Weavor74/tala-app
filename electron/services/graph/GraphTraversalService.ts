/**
 * GraphTraversalService.ts
 *
 * Local graph runtime layer for TALA context assembly (Step 6A + 6B).
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
 *   - When a graph DB becomes available, expandFromEvidence() will route to it
 *     first and fall back to provenance-derived expansion when unavailable.
 *
 * Graph_context derivation strategies (no DB):
 *
 *   Step 6A — Document co-occurrence (hop depth ≥ 1):
 *     When 2+ evidence items share the same documentId, the source document is a
 *     graph node related to all of them via a 'contains' edge. One graph_context
 *     item is created per such document. Edge trust: 'derived'.
 *     graphNodeType: 'source_document'.
 *
 *   Step 6B — Section co-occurrence (hop depth ≥ 1):
 *     When 2+ evidence items share the same non-empty sectionLabel in their
 *     metadata, the shared section is a graph node related to those chunks via
 *     an 'about' edge. One graph_context item is created per such section.
 *     Edge trust: 'derived'. graphNodeType: 'document_chunk'.
 *
 *   Step 6B — Title keyword overlap (hop depth ≥ 2):
 *     Significant words (3+ characters, not stop words) are extracted from each
 *     evidence item's title. When 2+ items share the same significant keyword,
 *     a topic node is emitted for that keyword via a 'related_to' edge.
 *     One graph_context item is created per shared keyword.
 *     Edge trust: 'derived'. graphNodeType: 'topic'.
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

// ─── Title Stop Words ─────────────────────────────────────────────────────────

/**
 * Common English stop words excluded from title keyword extraction.
 * Keeping this list minimal and stable ensures deterministic, explainable output.
 */
const TITLE_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'its', 'our', 'your', 'their', 'they',
  'you', 'all', 'can', 'will', 'would', 'could', 'should', 'may', 'might',
  'how', 'when', 'what', 'which', 'who', 'why', 'where', 'then', 'than',
  'about', 'into', 'after', 'also', 'more', 'over', 'such', 'each', 'there',
]);

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
   *
   * Expansion strategies, applied in priority order (6A first, then 6B):
   *   1. Document co-occurrence   (hop ≥ 1): 'contains' edge, 'source_document' node
   *   2. Section co-occurrence    (hop ≥ 1): 'about'     edge, 'document_chunk'  node
   *   3. Title keyword overlap    (hop ≥ 2): 'related_to' edge, 'topic'           node
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

    if (gt.maxHopDepth >= 1) {
      // ── 6A: Document co-occurrence (hop depth ≥ 1) ─────────────────────────
      // When multiple evidence chunks share the same documentId, the containing
      // document is an implicit graph node connected to all of them via 'contains'.
      // We emit one graph_context item per such document.
      const docNodes = this._deriveDocumentCooccurrenceNodes(evidenceItems);
      candidates.push(...docNodes);

      // ── 6B: Section co-occurrence (hop depth ≥ 1) ──────────────────────────
      // When multiple evidence chunks share the same sectionLabel, the section
      // is a document_chunk node related to those chunks via 'about'.
      // We emit one graph_context item per shared section label.
      const sectionNodes = this._deriveSectionCooccurrenceNodes(evidenceItems);
      candidates.push(...sectionNodes);
    }

    if (gt.maxHopDepth >= 2) {
      // ── 6B: Title keyword overlap (hop depth ≥ 2) ──────────────────────────
      // Significant words extracted from evidence titles are used to identify
      // implicit topic nodes. When 2+ items share the same keyword, a topic node
      // is emitted via a 'related_to' edge.
      const keywordNodes = this._deriveTitleKeywordNodes(evidenceItems);
      candidates.push(...keywordNodes);
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
   * Step 6B: Derive section-level graph_context nodes from shared sectionLabel.
   *
   * For each unique non-empty sectionLabel that appears on 2 or more evidence items,
   * emit one graph_context item representing the shared section. The item's content
   * lists the evidence anchors found in that section — no content is fabricated.
   *
   * graphEdgeType: 'about'    — the evidence chunks are about this section.
   * graphEdgeTrust: 'derived' — inferred from shared metadata, not explicit authoring.
   * graphNodeType: 'document_chunk'.
   */
  private _deriveSectionCooccurrenceNodes(
    evidenceItems: ContextAssemblyItem[],
  ): ContextAssemblyItem[] {
    // Group evidence items by sectionLabel.
    const bySection = new Map<string, ContextAssemblyItem[]>();
    for (const item of evidenceItems) {
      const label = (item.metadata?.sectionLabel as string | undefined) ?? null;
      if (!label) continue;
      const group = bySection.get(label) ?? [];
      group.push(item);
      bySection.set(label, group);
    }

    const results: ContextAssemblyItem[] = [];

    for (const [sectionLabel, members] of bySection) {
      // Only create a graph_context node when 2 or more chunks share the section.
      if (members.length < 2) continue;

      const anchorItem = members[0];
      const anchorList = members
        .map((m, i) => `  [${i + 1}] ${m.title ?? m.sourceKey ?? '(untitled)'}`)
        .join('\n');

      const content =
        `Section shared by ${members.length} evidence chunks:\n` +
        `Section: ${sectionLabel}\n` +
        `Evidence anchors:\n${anchorList}`;

      results.push({
        content,
        selectionClass: 'graph_context',
        sourceType: anchorItem.sourceType,
        sourceKey: `section:${sectionLabel}`,
        title: sectionLabel,
        uri: anchorItem.uri,
        score: null,
        graphEdgeType: 'about',
        graphEdgeTrust: 'derived',
        metadata: {
          graphNodeType: 'document_chunk' satisfies GraphNodeType,
          anchorCount: members.length,
          anchorKeys: members.map(m => m.sourceKey).filter(Boolean),
          sectionLabel,
          derivedFrom: 'section_cooccurrence',
          hopDepth: 1,
        },
      });
    }

    return results;
  }

  /**
   * Step 6B: Derive topic-level graph_context nodes from shared title keywords.
   *
   * Significant words (3+ characters, not stop words) are extracted from each
   * evidence item's title. When 2 or more items share the same keyword, a topic
   * node is emitted for that keyword, representing an implicit topical link
   * across the evidence set.
   *
   * One graph_context item is produced per unique shared keyword. Content lists
   * the evidence titles that contributed the keyword — no content is fabricated.
   *
   * graphEdgeType: 'related_to' — evidence items are related via a shared topic.
   * graphEdgeTrust: 'derived'   — inferred from title text, not explicit authoring.
   * graphNodeType: 'topic'.
   */
  private _deriveTitleKeywordNodes(
    evidenceItems: ContextAssemblyItem[],
  ): ContextAssemblyItem[] {
    // Group evidence items by each significant keyword found in their title.
    const byKeyword = new Map<string, ContextAssemblyItem[]>();
    for (const item of evidenceItems) {
      const title = item.title ?? '';
      if (!title) continue;
      const keywords = this._extractTitleKeywords(title);
      for (const kw of keywords) {
        const group = byKeyword.get(kw) ?? [];
        // Avoid adding the same item twice for the same keyword.
        if (!group.includes(item)) {
          group.push(item);
        }
        byKeyword.set(kw, group);
      }
    }

    const results: ContextAssemblyItem[] = [];

    for (const [keyword, members] of byKeyword) {
      // Only create a topic node when 2 or more distinct items share the keyword.
      if (members.length < 2) continue;

      const anchorList = members
        .map((m, i) => `  [${i + 1}] ${m.title ?? m.sourceKey ?? '(untitled)'}`)
        .join('\n');

      const content =
        `Topic keyword shared by ${members.length} evidence items:\n` +
        `Keyword: ${keyword}\n` +
        `Evidence items sharing this keyword:\n${anchorList}`;

      results.push({
        content,
        selectionClass: 'graph_context',
        sourceType: undefined,
        sourceKey: `topic:${keyword}`,
        title: keyword,
        uri: undefined,
        score: null,
        graphEdgeType: 'related_to',
        graphEdgeTrust: 'derived',
        metadata: {
          graphNodeType: 'topic' satisfies GraphNodeType,
          anchorCount: members.length,
          anchorKeys: members.map(m => m.sourceKey).filter(Boolean),
          keyword,
          derivedFrom: 'title_keyword_overlap',
          hopDepth: 2,
        },
      });
    }

    return results;
  }

  /**
   * Extract significant keywords from a title string.
   *
   * Rules:
   *   - Lowercase all tokens.
   *   - Keep tokens that are 3 or more characters.
   *   - Remove common English stop words that carry no topical signal.
   *   - Return deduplicated keyword list in encountered order.
   */
  private _extractTitleKeywords(title: string): string[] {
    const tokens = title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3);

    const seen = new Set<string>();
    const result: string[] = [];
    for (const token of tokens) {
      if (!TITLE_STOP_WORDS.has(token) && !seen.has(token)) {
        seen.add(token);
        result.push(token);
      }
    }
    return result;
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
