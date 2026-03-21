/**
 * MemoryPolicy — Unit tests for the memory policy type contracts
 *
 * Validates the canonical types defined in shared/policy/memoryPolicyTypes.ts:
 *   - All enum literal values are present and correct
 *   - Interface shapes are structurally valid
 *   - Default/required field constraints hold
 *   - Re-exported retrieval types (RetrievalMode, ScopeType) are consistent
 *     with their definitions in shared/retrieval/retrievalTypes.ts
 *
 * These tests are pure TypeScript — no DB, no IPC, no Electron.
 */

import { describe, it, expect } from 'vitest';

import type {
  GroundingMode,
  GraphNodeType,
  GraphEdgeType,
  EdgeTrustLevel,
  MemorySelectionClass,
  GraphTraversalPolicy,
  ContextBudgetPolicy,
  MemoryPolicy,
  ContextAssemblyItem,
  ContextAssemblyRequest,
  ContextAssemblyResult,
} from '../shared/policy/memoryPolicyTypes';

// Re-export aliases used by policy consumers
import type { RetrievalMode, ScopeType } from '../shared/policy/memoryPolicyTypes';

// Also import directly from retrievalTypes to validate consistency
import type {
  RetrievalMode as CanonicalRetrievalMode,
  RetrievalScopeType as CanonicalScopeType,
} from '../shared/retrieval/retrievalTypes';

// ─── Type compatibility helpers ───────────────────────────────────────────────
// These compile-time checks ensure the re-exported aliases are assignment-
// compatible with their source definitions. If either fails to compile, the
// policy module has drifted from the retrieval module.

type AssertExtends<T, U extends T> = U;

// RetrievalMode re-export is the same type
type _CheckRetrievalMode = AssertExtends<RetrievalMode, CanonicalRetrievalMode>;
// ScopeType re-export is the same type
type _CheckScopeType = AssertExtends<ScopeType, CanonicalScopeType>;

// ─── Literal union validators ─────────────────────────────────────────────────

/** Helper: asserts that a value is of the expected type at runtime. */
function expectLiteral<T>(value: T): T {
  return value;
}

describe('MemoryPolicy type contracts', () => {

  // ── RetrievalMode (re-exported) ─────────────────────────────────────────────

  describe('RetrievalMode (re-exported from retrievalTypes)', () => {
    const modes: RetrievalMode[] = ['keyword', 'semantic', 'hybrid', 'graph'];

    it('includes all four canonical modes', () => {
      expect(modes).toHaveLength(4);
      expect(modes).toContain('keyword');
      expect(modes).toContain('semantic');
      expect(modes).toContain('hybrid');
      expect(modes).toContain('graph');
    });
  });

  // ── ScopeType (re-exported) ─────────────────────────────────────────────────

  describe('ScopeType (re-exported from retrievalTypes)', () => {
    const scopes: ScopeType[] = ['global', 'notebook', 'explicit_sources'];

    it('includes all three canonical scope types', () => {
      expect(scopes).toHaveLength(3);
      expect(scopes).toContain('global');
      expect(scopes).toContain('notebook');
      expect(scopes).toContain('explicit_sources');
    });
  });

  // ── GroundingMode ───────────────────────────────────────────────────────────

  describe('GroundingMode', () => {
    const modes: GroundingMode[] = ['strict', 'graph_assisted', 'exploratory'];

    it('includes strict, graph_assisted, and exploratory', () => {
      expect(modes).toHaveLength(3);
      expect(modes).toContain('strict');
      expect(modes).toContain('graph_assisted');
      expect(modes).toContain('exploratory');
    });
  });

  // ── GraphNodeType ───────────────────────────────────────────────────────────

  describe('GraphNodeType', () => {
    const nodeTypes: GraphNodeType[] = [
      'notebook',
      'source_document',
      'document_chunk',
      'entity',
      'topic',
      'task',
      'artifact',
      'policy',
      'session_memory',
      'summary',
    ];

    it('includes all ten canonical node types', () => {
      expect(nodeTypes).toHaveLength(10);
    });

    it('includes all expected values', () => {
      for (const t of nodeTypes) {
        expect(expectLiteral<GraphNodeType>(t)).toBeTruthy();
      }
    });
  });

  // ── GraphEdgeType ───────────────────────────────────────────────────────────

  describe('GraphEdgeType', () => {
    const edgeTypes: GraphEdgeType[] = [
      'contains',
      'cites',
      'mentions',
      'about',
      'related_to',
      'supports',
      'contradicts',
      'derived_from',
      'belongs_to',
      'depends_on',
      'references',
      'governs',
      'same_as',
    ];

    it('includes all thirteen canonical edge types', () => {
      expect(edgeTypes).toHaveLength(13);
    });

    it('includes all expected values', () => {
      for (const t of edgeTypes) {
        expect(expectLiteral<GraphEdgeType>(t)).toBeTruthy();
      }
    });
  });

  // ── EdgeTrustLevel ──────────────────────────────────────────────────────────

  describe('EdgeTrustLevel', () => {
    const levels: EdgeTrustLevel[] = [
      'canonical',
      'explicit',
      'derived',
      'inferred_high',
      'inferred_low',
      'session_only',
    ];

    it('includes all six trust levels', () => {
      expect(levels).toHaveLength(6);
    });

    it('contains canonical, explicit, derived, inferred_high, inferred_low, session_only', () => {
      expect(levels).toContain('canonical');
      expect(levels).toContain('explicit');
      expect(levels).toContain('derived');
      expect(levels).toContain('inferred_high');
      expect(levels).toContain('inferred_low');
      expect(levels).toContain('session_only');
    });
  });

  // ── MemorySelectionClass ────────────────────────────────────────────────────

  describe('MemorySelectionClass', () => {
    const classes: MemorySelectionClass[] = ['evidence', 'graph_context', 'summary', 'latent'];

    it('includes all four selection classes', () => {
      expect(classes).toHaveLength(4);
      expect(classes).toContain('evidence');
      expect(classes).toContain('graph_context');
      expect(classes).toContain('summary');
      expect(classes).toContain('latent');
    });
  });

  // ── GraphTraversalPolicy ────────────────────────────────────────────────────

  describe('GraphTraversalPolicy', () => {
    it('accepts a minimal disabled policy', () => {
      const policy: GraphTraversalPolicy = {
        enabled: false,
        maxHopDepth: 0,
        maxRelatedNodes: 0,
        maxNodesPerType: {},
      };

      expect(policy.enabled).toBe(false);
      expect(policy.maxHopDepth).toBe(0);
      expect(policy.maxRelatedNodes).toBe(0);
    });

    it('accepts a full traversal policy with all optional fields', () => {
      const policy: GraphTraversalPolicy = {
        enabled: true,
        maxHopDepth: 2,
        maxRelatedNodes: 10,
        maxNodesPerType: {
          entity: 5,
          topic: 3,
          document_chunk: 4,
        },
        minEdgeTrustLevel: 'derived',
        allowedEdgeTypes: ['supports', 'cites', 'related_to'],
      };

      expect(policy.enabled).toBe(true);
      expect(policy.maxHopDepth).toBe(2);
      expect(policy.maxRelatedNodes).toBe(10);
      expect(policy.maxNodesPerType.entity).toBe(5);
      expect(policy.maxNodesPerType.topic).toBe(3);
      expect(policy.minEdgeTrustLevel).toBe('derived');
      expect(policy.allowedEdgeTypes).toContain('cites');
    });

    it('accepts partial maxNodesPerType (not all node types required)', () => {
      const policy: GraphTraversalPolicy = {
        enabled: true,
        maxHopDepth: 1,
        maxRelatedNodes: 5,
        maxNodesPerType: { artifact: 2 },
      };

      expect(policy.maxNodesPerType.artifact).toBe(2);
      expect(policy.maxNodesPerType.entity).toBeUndefined();
    });
  });

  // ── ContextBudgetPolicy ─────────────────────────────────────────────────────

  describe('ContextBudgetPolicy', () => {
    it('accepts a minimal budget with only maxItems', () => {
      const budget: ContextBudgetPolicy = {
        maxItems: 10,
      };

      expect(budget.maxItems).toBe(10);
      expect(budget.maxTokens).toBeUndefined();
      expect(budget.maxItemsPerClass).toBeUndefined();
    });

    it('accepts a full budget with all optional fields', () => {
      const budget: ContextBudgetPolicy = {
        maxItems: 20,
        maxTokens: 4096,
        maxItemsPerClass: {
          evidence: 10,
          graph_context: 5,
          summary: 3,
          latent: 2,
        },
        evidencePriority: true,
      };

      expect(budget.maxTokens).toBe(4096);
      expect(budget.maxItemsPerClass?.evidence).toBe(10);
      expect(budget.evidencePriority).toBe(true);
    });
  });

  // ── MemoryPolicy ────────────────────────────────────────────────────────────

  describe('MemoryPolicy', () => {
    it('accepts a minimal valid policy for strict notebook-scoped retrieval', () => {
      const policy: MemoryPolicy = {
        groundingMode: 'strict',
        retrievalMode: 'hybrid',
        scope: 'notebook',
        notebookId: 'nb-uuid-1',
        graphTraversal: {
          enabled: false,
          maxHopDepth: 0,
          maxRelatedNodes: 0,
          maxNodesPerType: {},
        },
        contextBudget: {
          maxItems: 10,
        },
      };

      expect(policy.groundingMode).toBe('strict');
      expect(policy.retrievalMode).toBe('hybrid');
      expect(policy.scope).toBe('notebook');
      expect(policy.notebookId).toBe('nb-uuid-1');
      expect(policy.graphTraversal.enabled).toBe(false);
    });

    it('accepts a graph-assisted policy with traversal enabled', () => {
      const policy: MemoryPolicy = {
        groundingMode: 'graph_assisted',
        retrievalMode: 'graph',
        scope: 'global',
        graphTraversal: {
          enabled: true,
          maxHopDepth: 2,
          maxRelatedNodes: 15,
          maxNodesPerType: { entity: 5, topic: 5 },
          minEdgeTrustLevel: 'explicit',
        },
        contextBudget: {
          maxItems: 25,
          maxTokens: 8192,
          evidencePriority: true,
        },
      };

      expect(policy.graphTraversal.enabled).toBe(true);
      expect(policy.graphTraversal.maxHopDepth).toBe(2);
      expect(policy.contextBudget.evidencePriority).toBe(true);
    });

    it('accepts explicit_sources scope with source list', () => {
      const policy: MemoryPolicy = {
        groundingMode: 'strict',
        retrievalMode: 'semantic',
        scope: 'explicit_sources',
        explicitSources: ['file:///docs/policy.md', 'file:///docs/overview.md'],
        graphTraversal: {
          enabled: false,
          maxHopDepth: 0,
          maxRelatedNodes: 0,
          maxNodesPerType: {},
        },
        contextBudget: { maxItems: 5 },
      };

      expect(policy.scope).toBe('explicit_sources');
      expect(policy.explicitSources).toHaveLength(2);
    });
  });

  // ── ContextAssemblyItem ─────────────────────────────────────────────────────

  describe('ContextAssemblyItem', () => {
    it('accepts a minimal evidence item with just content and selectionClass', () => {
      const item: ContextAssemblyItem = {
        content: 'Tala is a memory-grounded AI assistant.',
        selectionClass: 'evidence',
      };

      expect(item.selectionClass).toBe('evidence');
      expect(item.content).toBeTruthy();
    });

    it('accepts a fully populated graph_context item', () => {
      const item: ContextAssemblyItem = {
        content: 'Related topic: knowledge graphs',
        selectionClass: 'graph_context',
        sourceType: 'topic',
        sourceKey: 'topic:knowledge-graphs',
        title: 'Knowledge Graphs',
        uri: 'tala://graph/node/topic:knowledge-graphs',
        score: 0.78,
        graphEdgeType: 'related_to',
        graphEdgeTrust: 'inferred_high',
        metadata: { hopDepth: 1 },
      };

      expect(item.selectionClass).toBe('graph_context');
      expect(item.graphEdgeType).toBe('related_to');
      expect(item.graphEdgeTrust).toBe('inferred_high');
      expect(item.metadata?.hopDepth).toBe(1);
    });

    it('allows null graphEdgeType and graphEdgeTrust for non-graph items', () => {
      const item: ContextAssemblyItem = {
        content: 'Summary of session context.',
        selectionClass: 'summary',
        graphEdgeType: null,
        graphEdgeTrust: null,
      };

      expect(item.graphEdgeType).toBeNull();
      expect(item.graphEdgeTrust).toBeNull();
    });
  });

  // ── ContextAssemblyRequest ──────────────────────────────────────────────────

  describe('ContextAssemblyRequest', () => {
    it('accepts a minimal request with query and policy', () => {
      const request: ContextAssemblyRequest = {
        query: 'What is the TALA memory architecture?',
        policy: {
          groundingMode: 'strict',
          retrievalMode: 'hybrid',
          scope: 'global',
          graphTraversal: { enabled: false, maxHopDepth: 0, maxRelatedNodes: 0, maxNodesPerType: {} },
          contextBudget: { maxItems: 10 },
        },
      };

      expect(request.query).toBeTruthy();
      expect(request.policy.groundingMode).toBe('strict');
      expect(request.sessionId).toBeUndefined();
    });

    it('accepts optional sessionId and turnId', () => {
      const request: ContextAssemblyRequest = {
        query: 'test query',
        policy: {
          groundingMode: 'exploratory',
          retrievalMode: 'keyword',
          scope: 'global',
          graphTraversal: { enabled: false, maxHopDepth: 0, maxRelatedNodes: 0, maxNodesPerType: {} },
          contextBudget: { maxItems: 5 },
        },
        sessionId: 'session-abc-123',
        turnId: 'turn-xyz-456',
      };

      expect(request.sessionId).toBe('session-abc-123');
      expect(request.turnId).toBe('turn-xyz-456');
    });
  });

  // ── ContextAssemblyResult ───────────────────────────────────────────────────

  describe('ContextAssemblyResult', () => {
    it('accepts a minimal result with zero items', () => {
      const result: ContextAssemblyResult = {
        items: [],
        policy: {
          groundingMode: 'strict',
          retrievalMode: 'hybrid',
          scope: 'global',
          graphTraversal: { enabled: false, maxHopDepth: 0, maxRelatedNodes: 0, maxNodesPerType: {} },
          contextBudget: { maxItems: 10 },
        },
        totalItems: 0,
        itemCountByClass: {},
        durationMs: 5,
      };

      expect(result.items).toHaveLength(0);
      expect(result.totalItems).toBe(0);
      expect(result.warnings).toBeUndefined();
    });

    it('accepts a result with mixed selection classes and warnings', () => {
      const evidenceItem: ContextAssemblyItem = {
        content: 'Retrieved evidence passage.',
        selectionClass: 'evidence',
        score: 0.92,
      };
      const graphItem: ContextAssemblyItem = {
        content: 'Graph-linked related concept.',
        selectionClass: 'graph_context',
        graphEdgeType: 'supports',
        graphEdgeTrust: 'derived',
      };

      const result: ContextAssemblyResult = {
        items: [evidenceItem, graphItem],
        policy: {
          groundingMode: 'graph_assisted',
          retrievalMode: 'hybrid',
          scope: 'notebook',
          notebookId: 'nb-1',
          graphTraversal: {
            enabled: true,
            maxHopDepth: 1,
            maxRelatedNodes: 5,
            maxNodesPerType: {},
          },
          contextBudget: { maxItems: 10, evidencePriority: true },
        },
        totalItems: 2,
        itemCountByClass: {
          evidence: 1,
          graph_context: 1,
        },
        estimatedTokens: 128,
        durationMs: 42,
        warnings: ['Graph runtime unavailable; traversal skipped.'],
      };

      expect(result.totalItems).toBe(2);
      expect(result.itemCountByClass.evidence).toBe(1);
      expect(result.itemCountByClass.graph_context).toBe(1);
      expect(result.estimatedTokens).toBe(128);
      expect(result.warnings).toHaveLength(1);
      expect(result.items[0].selectionClass).toBe('evidence');
    });

    it('totalItems matches items.length', () => {
      const items: ContextAssemblyItem[] = [
        { content: 'A', selectionClass: 'evidence' },
        { content: 'B', selectionClass: 'summary' },
        { content: 'C', selectionClass: 'latent' },
      ];

      const result: ContextAssemblyResult = {
        items,
        policy: {
          groundingMode: 'exploratory',
          retrievalMode: 'semantic',
          scope: 'global',
          graphTraversal: { enabled: false, maxHopDepth: 0, maxRelatedNodes: 0, maxNodesPerType: {} },
          contextBudget: { maxItems: 10 },
        },
        totalItems: items.length,
        itemCountByClass: { evidence: 1, summary: 1, latent: 1 },
        durationMs: 7,
      };

      expect(result.totalItems).toBe(result.items.length);
    });
  });
});
