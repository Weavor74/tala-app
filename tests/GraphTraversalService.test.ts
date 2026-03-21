/**
 * GraphTraversalService.test.ts
 *
 * Unit tests for GraphTraversalService (Step 6A).
 *
 * Validates:
 *   - Returns empty array when graphTraversal.enabled is false.
 *   - Returns empty array in strict grounding mode.
 *   - Returns empty array when evidence items list is empty.
 *   - Returns empty array when no evidence items share a documentId.
 *   - Returns empty array when fewer than 2 items share a documentId.
 *   - Derives document co-occurrence graph_context nodes from 2+ shared-doc items.
 *   - Derived graph_context items have correct edge type ('contains') and trust ('derived').
 *   - Derived graph_context items preserve provenance (sourceKey = documentId, title, uri).
 *   - allowedEdgeTypes filter excludes items whose edge type is not listed.
 *   - allowedEdgeTypes undefined / empty passes all items.
 *   - minEdgeTrustLevel filters out items below the minimum trust rank.
 *   - maxRelatedNodes caps the total number of returned items.
 *   - maxNodesPerType caps per-type counts for types listed in the policy.
 *   - maxHopDepth === 0 suppresses document co-occurrence expansion.
 *   - Multiple documents with 2+ items each produce one node per document.
 *   - Content of derived nodes references actual evidence anchor titles.
 *   - ContextAssemblyService integration: graph_context items appear in result
 *     when groundingMode is 'graph_assisted'.
 *   - ContextAssemblyService integration: no graph_context items when groundingMode
 *     is 'strict'.
 *
 * No real DB or network calls. GraphTraversalService is a pure in-process service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphTraversalService } from '../electron/services/graph/GraphTraversalService';
import { ContextAssemblyService } from '../electron/services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../electron/services/policy/MemoryPolicyService';
import type { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';
import type {
  ContextAssemblyItem,
  MemoryPolicy,
} from '../shared/policy/memoryPolicyTypes';
import type {
  NormalizedSearchResult,
  RetrievalResponse,
  RetrievalScopeResolved,
} from '../shared/retrieval/retrievalTypes';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeEvidenceItem(overrides: Partial<ContextAssemblyItem> & { sourceKey: string }): ContextAssemblyItem {
  return {
    content: 'evidence content',
    selectionClass: 'evidence',
    title: overrides.sourceKey,
    score: 0.8,
    graphEdgeType: null,
    graphEdgeTrust: null,
    metadata: {},
    ...overrides,
  };
}

function makePolicy(overrides: Partial<MemoryPolicy> = {}): MemoryPolicy {
  return {
    groundingMode: 'graph_assisted',
    retrievalMode: 'hybrid',
    scope: 'global',
    graphTraversal: {
      enabled: true,
      maxHopDepth: 1,
      maxRelatedNodes: 10,
      maxNodesPerType: {},
      minEdgeTrustLevel: undefined,
      allowedEdgeTypes: undefined,
    },
    contextBudget: {
      maxItems: 15,
      maxItemsPerClass: {
        evidence: 8,
        graph_context: 5,
        summary: 2,
        latent: 5,
      },
      evidencePriority: true,
    },
    ...overrides,
  } as MemoryPolicy;
}

// ─── GraphTraversalService tests ──────────────────────────────────────────────

describe('GraphTraversalService', () => {
  let service: GraphTraversalService;

  beforeEach(() => {
    service = new GraphTraversalService();
  });

  // ── Guards ─────────────────────────────────────────────────────────────────

  describe('guards', () => {
    it('returns empty array when graphTraversal.enabled is false', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: false,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(0);
    });

    it('returns empty array when groundingMode is strict', async () => {
      const policy = makePolicy({ groundingMode: 'strict' });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(0);
    });

    it('returns empty array when evidenceItems is empty', async () => {
      const policy = makePolicy();
      const result = await service.expandFromEvidence({ evidenceItems: [], policy });
      expect(result).toHaveLength(0);
    });
  });

  // ── Document co-occurrence ─────────────────────────────────────────────────

  describe('document co-occurrence expansion', () => {
    it('returns empty array when no evidence items have a documentId', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'a' }),
        makeEvidenceItem({ sourceKey: 'b' }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(0);
    });

    it('returns empty array when only one item has a given documentId', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc2' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(0);
    });

    it('creates one graph_context node when 2 items share a documentId', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'chunk-1', title: 'Chunk One', metadata: { documentId: 'doc-A' } }),
        makeEvidenceItem({ sourceKey: 'chunk-2', title: 'Chunk Two', metadata: { documentId: 'doc-A' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(1);
    });

    it('creates one graph_context node per document (not per item)', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'a1', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'a2', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'a3', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'b1', metadata: { documentId: 'docB' } }),
        makeEvidenceItem({ sourceKey: 'b2', metadata: { documentId: 'docB' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(2);
    });

    it('graph_context items have selectionClass graph_context', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'x', metadata: { documentId: 'docX' } }),
        makeEvidenceItem({ sourceKey: 'y', metadata: { documentId: 'docX' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result[0].selectionClass).toBe('graph_context');
    });

    it('graph_context items have graphEdgeType contains', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'x', metadata: { documentId: 'docX' } }),
        makeEvidenceItem({ sourceKey: 'y', metadata: { documentId: 'docX' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result[0].graphEdgeType).toBe('contains');
    });

    it('graph_context items have graphEdgeTrust derived', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'x', metadata: { documentId: 'docX' } }),
        makeEvidenceItem({ sourceKey: 'y', metadata: { documentId: 'docX' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result[0].graphEdgeTrust).toBe('derived');
    });

    it('graph_context item sourceKey matches the documentId', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'x', metadata: { documentId: 'my-doc' } }),
        makeEvidenceItem({ sourceKey: 'y', metadata: { documentId: 'my-doc' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result[0].sourceKey).toBe('my-doc');
    });

    it('content references evidence anchor titles', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'x', title: 'First Chunk', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'y', title: 'Second Chunk', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result[0].content).toContain('First Chunk');
      expect(result[0].content).toContain('Second Chunk');
    });

    it('metadata preserves graphNodeType source_document', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'x', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'y', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result[0].metadata?.graphNodeType).toBe('source_document');
    });

    it('metadata preserves anchorCount matching number of evidence items', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'c', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result[0].metadata?.anchorCount).toBe(3);
    });

    it('metadata preserves anchorKeys with sourceKeys of anchors', async () => {
      const policy = makePolicy();
      const items = [
        makeEvidenceItem({ sourceKey: 'chunk-alpha', metadata: { documentId: 'docZ' } }),
        makeEvidenceItem({ sourceKey: 'chunk-beta', metadata: { documentId: 'docZ' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result[0].metadata?.anchorKeys).toEqual(['chunk-alpha', 'chunk-beta']);
    });

    it('returns empty array when maxHopDepth is 0', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 0,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(0);
    });
  });

  // ── Edge type filter ───────────────────────────────────────────────────────

  describe('allowedEdgeTypes filter', () => {
    it('includes graph_context items when allowedEdgeTypes is undefined', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          allowedEdgeTypes: undefined,
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(1);
    });

    it('includes contains items when allowedEdgeTypes includes contains', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          allowedEdgeTypes: ['contains', 'cites'],
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(1);
    });

    it('excludes contains items when allowedEdgeTypes does not include contains', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          allowedEdgeTypes: ['cites', 'mentions'],
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(0);
    });
  });

  // ── Trust level filter ─────────────────────────────────────────────────────

  describe('minEdgeTrustLevel filter', () => {
    it('includes derived items when minEdgeTrustLevel is derived', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          minEdgeTrustLevel: 'derived',
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      // 'derived' items pass a 'derived' minimum filter
      expect(result).toHaveLength(1);
    });

    it('includes derived items when minEdgeTrustLevel is inferred_low', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          minEdgeTrustLevel: 'inferred_low',
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(1);
    });

    it('excludes derived items when minEdgeTrustLevel is explicit', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          minEdgeTrustLevel: 'explicit',
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      // 'derived' does not meet the 'explicit' minimum
      expect(result).toHaveLength(0);
    });

    it('excludes derived items when minEdgeTrustLevel is canonical', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          minEdgeTrustLevel: 'canonical',
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a', metadata: { documentId: 'doc1' } }),
        makeEvidenceItem({ sourceKey: 'b', metadata: { documentId: 'doc1' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(0);
    });
  });

  // ── Node caps ─────────────────────────────────────────────────────────────

  describe('node caps', () => {
    it('caps total results at maxRelatedNodes', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 1, // cap at 1 even though 3 docs qualify
          maxNodesPerType: {},
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a1', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'a2', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'b1', metadata: { documentId: 'docB' } }),
        makeEvidenceItem({ sourceKey: 'b2', metadata: { documentId: 'docB' } }),
        makeEvidenceItem({ sourceKey: 'c1', metadata: { documentId: 'docC' } }),
        makeEvidenceItem({ sourceKey: 'c2', metadata: { documentId: 'docC' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it('caps source_document nodes via maxNodesPerType', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: { source_document: 1 },
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a1', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'a2', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'b1', metadata: { documentId: 'docB' } }),
        makeEvidenceItem({ sourceKey: 'b2', metadata: { documentId: 'docB' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it('allows all source_document nodes when type is not in maxNodesPerType', async () => {
      const policy = makePolicy({
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: { entity: 2 }, // source_document not listed
        },
      });
      const items = [
        makeEvidenceItem({ sourceKey: 'a1', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'a2', metadata: { documentId: 'docA' } }),
        makeEvidenceItem({ sourceKey: 'b1', metadata: { documentId: 'docB' } }),
        makeEvidenceItem({ sourceKey: 'b2', metadata: { documentId: 'docB' } }),
      ];
      const result = await service.expandFromEvidence({ evidenceItems: items, policy });
      expect(result).toHaveLength(2);
    });
  });
});

// ─── Step 6B: Section co-occurrence ──────────────────────────────────────────

describe('GraphTraversalService — Step 6B section co-occurrence', () => {
  let service: GraphTraversalService;

  beforeEach(() => {
    service = new GraphTraversalService();
  });

  it('returns a section node when 2+ items share the same sectionLabel', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'Intro A', metadata: { sectionLabel: 'Introduction' } }),
      makeEvidenceItem({ sourceKey: 'b', title: 'Intro B', metadata: { sectionLabel: 'Introduction' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const sectionNodes = result.filter(i => i.graphEdgeType === 'about');
    expect(sectionNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('section node has selectionClass graph_context', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Methods' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Methods' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const sectionNode = result.find(i => i.graphEdgeType === 'about');
    expect(sectionNode?.selectionClass).toBe('graph_context');
  });

  it('section node has graphEdgeType about and graphEdgeTrust derived', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Results' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Results' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'about');
    expect(node?.graphEdgeType).toBe('about');
    expect(node?.graphEdgeTrust).toBe('derived');
  });

  it('section node has graphNodeType document_chunk', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Discussion' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Discussion' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'about');
    expect(node?.metadata?.graphNodeType).toBe('document_chunk');
  });

  it('section node title matches the sectionLabel', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Conclusion' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Conclusion' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'about');
    expect(node?.title).toBe('Conclusion');
  });

  it('section node sourceKey is prefixed with section:', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Abstract' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Abstract' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'about');
    expect(node?.sourceKey).toBe('section:Abstract');
  });

  it('section node content references the sectionLabel and anchor titles', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'Chunk Alpha', metadata: { sectionLabel: 'Background' } }),
      makeEvidenceItem({ sourceKey: 'b', title: 'Chunk Beta', metadata: { sectionLabel: 'Background' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'about');
    expect(node?.content).toContain('Background');
    expect(node?.content).toContain('Chunk Alpha');
    expect(node?.content).toContain('Chunk Beta');
  });

  it('section node metadata preserves anchorCount and anchorKeys', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'key-1', metadata: { sectionLabel: 'Appendix' } }),
      makeEvidenceItem({ sourceKey: 'key-2', metadata: { sectionLabel: 'Appendix' } }),
      makeEvidenceItem({ sourceKey: 'key-3', metadata: { sectionLabel: 'Appendix' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'about');
    expect(node?.metadata?.anchorCount).toBe(3);
    expect(node?.metadata?.anchorKeys).toEqual(['key-1', 'key-2', 'key-3']);
  });

  it('returns empty when only one item has a given sectionLabel', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Methods' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Results' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const sectionNodes = result.filter(i => i.graphEdgeType === 'about');
    expect(sectionNodes).toHaveLength(0);
  });

  it('returns empty when items have no sectionLabel', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: {} }),
      makeEvidenceItem({ sourceKey: 'b', metadata: {} }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const sectionNodes = result.filter(i => i.graphEdgeType === 'about');
    expect(sectionNodes).toHaveLength(0);
  });

  it('produces one section node per distinct shared sectionLabel', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a1', metadata: { sectionLabel: 'Intro' } }),
      makeEvidenceItem({ sourceKey: 'a2', metadata: { sectionLabel: 'Intro' } }),
      makeEvidenceItem({ sourceKey: 'b1', metadata: { sectionLabel: 'Methods' } }),
      makeEvidenceItem({ sourceKey: 'b2', metadata: { sectionLabel: 'Methods' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const sectionNodes = result.filter(i => i.graphEdgeType === 'about');
    expect(sectionNodes).toHaveLength(2);
  });

  it('section node is suppressed when maxHopDepth is 0', async () => {
    const policy = makePolicy({
      graphTraversal: {
        enabled: true,
        maxHopDepth: 0,
        maxRelatedNodes: 10,
        maxNodesPerType: {},
      },
    });
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Intro' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Intro' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    expect(result).toHaveLength(0);
  });

  it('section node is excluded when allowedEdgeTypes does not include about', async () => {
    const policy = makePolicy({
      graphTraversal: {
        enabled: true,
        maxHopDepth: 1,
        maxRelatedNodes: 10,
        maxNodesPerType: {},
        allowedEdgeTypes: ['contains', 'cites'],
      },
    });
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Intro' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Intro' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const sectionNodes = result.filter(i => i.graphEdgeType === 'about');
    expect(sectionNodes).toHaveLength(0);
  });

  it('section node derivedFrom is section_cooccurrence', async () => {
    const policy = makePolicy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', metadata: { sectionLabel: 'Summary' } }),
      makeEvidenceItem({ sourceKey: 'b', metadata: { sectionLabel: 'Summary' } }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'about');
    expect(node?.metadata?.derivedFrom).toBe('section_cooccurrence');
    expect(node?.metadata?.hopDepth).toBe(1);
  });
});

// ─── Step 6B: Title keyword overlap ──────────────────────────────────────────

describe('GraphTraversalService — Step 6B title keyword overlap', () => {
  let service: GraphTraversalService;

  const makeHop2Policy = (overrides: Partial<MemoryPolicy> = {}): MemoryPolicy =>
    makePolicy({
      graphTraversal: {
        enabled: true,
        maxHopDepth: 2,
        maxRelatedNodes: 20,
        maxNodesPerType: {},
        allowedEdgeTypes: undefined,
      },
      ...overrides,
    });

  beforeEach(() => {
    service = new GraphTraversalService();
  });

  it('returns a topic node when 2+ items share a significant title keyword', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'neural network training' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'neural network architecture' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const topicNodes = result.filter(i => i.graphEdgeType === 'related_to');
    expect(topicNodes.length).toBeGreaterThan(0);
  });

  it('topic node has selectionClass graph_context', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'climate change impact' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'climate change policy' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'related_to');
    expect(node?.selectionClass).toBe('graph_context');
  });

  it('topic node has graphEdgeType related_to and graphEdgeTrust derived', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'quantum computing basics' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'quantum computing applications' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'related_to');
    expect(node?.graphEdgeType).toBe('related_to');
    expect(node?.graphEdgeTrust).toBe('derived');
  });

  it('topic node has graphNodeType topic', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'machine learning overview' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'machine learning techniques' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'related_to');
    expect(node?.metadata?.graphNodeType).toBe('topic');
  });

  it('topic node sourceKey is prefixed with topic:', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'protein folding study' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'protein folding simulation' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'related_to' && i.title === 'protein');
    expect(node?.sourceKey).toBe('topic:protein');
  });

  it('topic node content references the keyword and contributing titles', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'solar energy conversion' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'solar energy storage' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.graphEdgeType === 'related_to' && i.title === 'solar');
    expect(node?.content).toContain('solar');
    expect(node?.content).toContain('solar energy conversion');
    expect(node?.content).toContain('solar energy storage');
  });

  it('topic node metadata preserves keyword, anchorCount, derivedFrom', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'x', title: 'deep learning fundamentals' }),
      makeEvidenceItem({ sourceKey: 'y', title: 'deep learning applications' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const node = result.find(i => i.metadata?.keyword === 'deep');
    expect(node?.metadata?.anchorCount).toBe(2);
    expect(node?.metadata?.derivedFrom).toBe('title_keyword_overlap');
    expect(node?.metadata?.hopDepth).toBe(2);
  });

  it('does not emit a topic node when only one item has a given keyword', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'photosynthesis process' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'neural network training' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    // No keyword appears in both titles.
    const topicNodes = result.filter(i => i.graphEdgeType === 'related_to');
    expect(topicNodes).toHaveLength(0);
  });

  it('does not emit topic nodes when maxHopDepth is 1', async () => {
    const policy = makePolicy({
      graphTraversal: {
        enabled: true,
        maxHopDepth: 1,
        maxRelatedNodes: 20,
        maxNodesPerType: {},
      },
    });
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'neural network training' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'neural network architecture' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const topicNodes = result.filter(i => i.graphEdgeType === 'related_to');
    expect(topicNodes).toHaveLength(0);
  });

  it('excludes stop words from keyword extraction', async () => {
    const policy = makeHop2Policy();
    // "the", "and", "for" are stop words; they should NOT produce topic nodes.
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'the impact for researchers' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'the role for scientists' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    // Stop words "the" and "for" must not produce topic nodes.
    const topicNodes = result.filter(i => i.graphEdgeType === 'related_to');
    const stopWordNodes = topicNodes.filter(
      n => n.title === 'the' || n.title === 'and' || n.title === 'for',
    );
    expect(stopWordNodes).toHaveLength(0);
  });

  it('excludes short tokens (under 3 chars) from keywords', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'AI ML systems' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'AI ML pipeline' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    // "AI" and "ML" are 2 chars — must not produce topic nodes.
    const shortNodes = result.filter(
      i => i.graphEdgeType === 'related_to' && (i.title === 'ai' || i.title === 'ml'),
    );
    expect(shortNodes).toHaveLength(0);
  });

  it('topic nodes are excluded when allowedEdgeTypes does not include related_to', async () => {
    const policy = makePolicy({
      graphTraversal: {
        enabled: true,
        maxHopDepth: 2,
        maxRelatedNodes: 20,
        maxNodesPerType: {},
        allowedEdgeTypes: ['contains', 'about'],
      },
    });
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'solar energy conversion' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'solar energy storage' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const topicNodes = result.filter(i => i.graphEdgeType === 'related_to');
    expect(topicNodes).toHaveLength(0);
  });

  it('topic nodes are capped by maxNodesPerType.topic', async () => {
    const policy = makePolicy({
      graphTraversal: {
        enabled: true,
        maxHopDepth: 2,
        maxRelatedNodes: 20,
        maxNodesPerType: { topic: 1 },
      },
    });
    // Multiple shared keywords → multiple topic candidates, but cap is 1.
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: 'deep neural network training optimization' }),
      makeEvidenceItem({ sourceKey: 'b', title: 'deep neural network architecture optimization' }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const topicNodes = result.filter(i => i.graphEdgeType === 'related_to');
    expect(topicNodes.length).toBeLessThanOrEqual(1);
  });

  it('items with no title do not contribute keywords', async () => {
    const policy = makeHop2Policy();
    const items = [
      makeEvidenceItem({ sourceKey: 'a', title: undefined }),
      makeEvidenceItem({ sourceKey: 'b', title: undefined }),
    ];
    const result = await service.expandFromEvidence({ evidenceItems: items, policy });
    const topicNodes = result.filter(i => i.graphEdgeType === 'related_to');
    expect(topicNodes).toHaveLength(0);
  });
});

// ─── ContextAssemblyService integration ──────────────────────────────────────

function makeMockResult(
  overrides: Partial<NormalizedSearchResult> & { itemKey: string; providerId: string },
): NormalizedSearchResult {
  return {
    title: null,
    uri: null,
    sourcePath: null,
    snippet: null,
    sourceType: null,
    externalId: null,
    contentHash: null,
    score: null,
    metadata: {},
    ...overrides,
  };
}

function makeScopeResolved(overrides: Partial<RetrievalScopeResolved> = {}): RetrievalScopeResolved {
  return {
    scopeType: 'global',
    uris: [],
    sourcePaths: [],
    itemKeys: [],
    ...overrides,
  };
}

function makeMockOrchestrator(results: NormalizedSearchResult[]): RetrievalOrchestrator {
  const response: RetrievalResponse = {
    query: 'test',
    mode: 'hybrid',
    scopeResolved: makeScopeResolved(),
    results,
    providerResults: [],
    totalResults: results.length,
    durationMs: 5,
  };
  return {
    retrieve: vi.fn().mockResolvedValue(response),
  } as unknown as RetrievalOrchestrator;
}

describe('ContextAssemblyService graph integration', () => {
  const policyService = new MemoryPolicyService();

  it('includes graph_context items in result when 2+ evidence chunks share a documentId and mode is graph_assisted', async () => {
    const results = [
      makeMockResult({ itemKey: 'c1', providerId: 'local', metadata: { documentId: 'shared-doc', chunkContent: 'chunk one' } }),
      makeMockResult({ itemKey: 'c2', providerId: 'local', metadata: { documentId: 'shared-doc', chunkContent: 'chunk two' } }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const contextService = new ContextAssemblyService(orchestrator, policyService);

    const result = await contextService.assemble({
      query: 'test query',
      policy: {
        groundingMode: 'graph_assisted',
        retrievalMode: 'hybrid',
        scope: 'global',
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          allowedEdgeTypes: ['contains'],
        },
        contextBudget: {
          maxItems: 10,
          maxItemsPerClass: { evidence: 5, graph_context: 5, latent: 5 },
          evidencePriority: true,
        },
      },
    });

    const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(graphItems.length).toBeGreaterThan(0);
  });

  it('graph_context items in ContextAssemblyResult have correct edge type', async () => {
    const results = [
      makeMockResult({ itemKey: 'c1', providerId: 'local', metadata: { documentId: 'doc-x', chunkContent: 'text a' } }),
      makeMockResult({ itemKey: 'c2', providerId: 'local', metadata: { documentId: 'doc-x', chunkContent: 'text b' } }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const contextService = new ContextAssemblyService(orchestrator, policyService);

    const result = await contextService.assemble({
      query: 'query',
      policy: {
        groundingMode: 'graph_assisted',
        retrievalMode: 'hybrid',
        scope: 'global',
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          allowedEdgeTypes: ['contains'],
        },
        contextBudget: {
          maxItems: 10,
          maxItemsPerClass: { evidence: 5, graph_context: 5, latent: 5 },
          evidencePriority: true,
        },
      },
    });

    const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(graphItems[0].graphEdgeType).toBe('contains');
    expect(graphItems[0].graphEdgeTrust).toBe('derived');
  });

  it('produces no graph_context items when groundingMode is strict', async () => {
    const results = [
      makeMockResult({ itemKey: 'c1', providerId: 'local', metadata: { documentId: 'doc-y', chunkContent: 'text a' } }),
      makeMockResult({ itemKey: 'c2', providerId: 'local', metadata: { documentId: 'doc-y', chunkContent: 'text b' } }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const contextService = new ContextAssemblyService(orchestrator, policyService);

    const result = await contextService.assemble({
      query: 'query',
      policy: {
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
          maxItems: 8,
          maxItemsPerClass: { evidence: 8, graph_context: 0, latent: 0 },
          evidencePriority: true,
        },
      },
    });

    const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(graphItems).toHaveLength(0);
  });

  it('graph_context items are counted in itemCountByClass', async () => {
    const results = [
      makeMockResult({ itemKey: 'c1', providerId: 'local', metadata: { documentId: 'doc-z', chunkContent: 'aaa' } }),
      makeMockResult({ itemKey: 'c2', providerId: 'local', metadata: { documentId: 'doc-z', chunkContent: 'bbb' } }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const contextService = new ContextAssemblyService(orchestrator, policyService);

    const result = await contextService.assemble({
      query: 'query',
      policy: {
        groundingMode: 'graph_assisted',
        retrievalMode: 'hybrid',
        scope: 'global',
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          allowedEdgeTypes: ['contains'],
        },
        contextBudget: {
          maxItems: 10,
          maxItemsPerClass: { evidence: 5, graph_context: 5, latent: 5 },
          evidencePriority: true,
        },
      },
    });

    expect(result.itemCountByClass.graph_context).toBeGreaterThan(0);
  });

  it('graph_context items are capped at maxItemsPerClass.graph_context', async () => {
    // 3 documents with 2 items each → 3 graph_context candidates, cap = 2
    const results = [
      makeMockResult({ itemKey: 'a1', providerId: 'local', metadata: { documentId: 'docA', chunkContent: 'a1' } }),
      makeMockResult({ itemKey: 'a2', providerId: 'local', metadata: { documentId: 'docA', chunkContent: 'a2' } }),
      makeMockResult({ itemKey: 'b1', providerId: 'local', metadata: { documentId: 'docB', chunkContent: 'b1' } }),
      makeMockResult({ itemKey: 'b2', providerId: 'local', metadata: { documentId: 'docB', chunkContent: 'b2' } }),
      makeMockResult({ itemKey: 'c1', providerId: 'local', metadata: { documentId: 'docC', chunkContent: 'c1' } }),
      makeMockResult({ itemKey: 'c2', providerId: 'local', metadata: { documentId: 'docC', chunkContent: 'c2' } }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const contextService = new ContextAssemblyService(orchestrator, policyService);

    const result = await contextService.assemble({
      query: 'query',
      policy: {
        groundingMode: 'graph_assisted',
        retrievalMode: 'hybrid',
        scope: 'global',
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          allowedEdgeTypes: ['contains'],
        },
        contextBudget: {
          maxItems: 20,
          maxItemsPerClass: { evidence: 10, graph_context: 2, latent: 10 },
          evidencePriority: true,
        },
      },
    });

    const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(graphItems.length).toBeLessThanOrEqual(2);
  });

  it('renderPromptBlocks includes DIRECT GRAPH CONTEXT section when graph items are present', async () => {
    const results = [
      makeMockResult({ itemKey: 'c1', providerId: 'local', metadata: { documentId: 'doc-r', chunkContent: 'text one' } }),
      makeMockResult({ itemKey: 'c2', providerId: 'local', metadata: { documentId: 'doc-r', chunkContent: 'text two' } }),
    ];
    const orchestrator = makeMockOrchestrator(results);
    const contextService = new ContextAssemblyService(orchestrator, policyService);

    const result = await contextService.assemble({
      query: 'query',
      policy: {
        groundingMode: 'graph_assisted',
        retrievalMode: 'hybrid',
        scope: 'global',
        graphTraversal: {
          enabled: true,
          maxHopDepth: 1,
          maxRelatedNodes: 10,
          maxNodesPerType: {},
          allowedEdgeTypes: ['contains'],
        },
        contextBudget: {
          maxItems: 10,
          maxItemsPerClass: { evidence: 5, graph_context: 5, latent: 5 },
          evidencePriority: true,
        },
      },
    });

    const rendered = contextService.renderPromptBlocks(result);
    expect(rendered).toContain('[DIRECT GRAPH CONTEXT]');
  });
});
