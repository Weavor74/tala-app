/**
 * ContextAssemblyDeterminism.test.ts
 * 
 * Feed 6: Determinism Proof Suite
 * 
 * Verifies that context assembly remains deterministic under cross-layer
 * competition, tie-breaking, authority resolution, and budget constraints.
 */

import { describe, it, expect } from 'vitest';
import { ContextAssemblyService } from '../../services/context/ContextAssemblyService';
import type { RetrievalOrchestrator } from '../../services/retrieval/RetrievalOrchestrator';
import type { ContextAssemblyRequest } from '../../../shared/policy/memoryPolicyTypes';
import { MemoryPolicyService } from '../../services/policy/MemoryPolicyService';

// ─── Test Harness ─────────────────────────────────────────────────────────────

function createMockOrchestrator(results: any[]): RetrievalOrchestrator {
  return {
    retrieve: async () => ({ results }),
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ContextAssembly Determinism Proof (Feed 6)', () => {

  // 1. same input → identical output
  it('Proof 1: Same input produces identical result (Strict Equality)', async () => {
    const results = [
      { itemKey: 'e1', title: 'E1', content: 'C1', score: 0.9, sourceType: 'doc' },
      { itemKey: 'e2', title: 'E2', content: 'C2', score: 0.8, sourceType: 'doc' },
    ];
    const service = new ContextAssemblyService(createMockOrchestrator(results));
    const request: ContextAssemblyRequest = { query: 'test', policy: { groundingMode: 'exploratory' } as any };

    const run1 = await service.assemble(request);
    const run2 = await service.assemble(request);

    // Assert deep equality of items and diagnostics (excluding durationMs)
    expect(run1.items).toEqual(run2.items);
    expect(run1.diagnostics!.crossLayerRankingOrder).toEqual(run2.diagnostics!.crossLayerRankingOrder);
    expect(run1.diagnostics!.decisions).toEqual(run2.diagnostics!.decisions);
  });

  // 2. tie-breaking consistent
  it('Proof 2: Tie-breaking is consistent for equal scores', async () => {
    // Both items have identical scores
    const results = [
      { itemKey: 'alpha', title: 'Alpha', content: 'Same content', score: 0.9, sourceType: 'doc' },
      { itemKey: 'beta', title: 'Beta', content: 'Same content', score: 0.9, sourceType: 'doc' },
    ];
    const service = new ContextAssemblyService(createMockOrchestrator(results));
    const request: ContextAssemblyRequest = { query: 'test', policy: { groundingMode: 'exploratory' } as any };

    const run1 = await service.assemble(request);
    const run2 = await service.assemble(request);

    // The winner must be the same every time (lexical sort by ID usually)
    expect(run1.diagnostics!.crossLayerRankingOrder).toEqual(run2.diagnostics!.crossLayerRankingOrder);
    expect(run1.diagnostics!.tieBreakRecords.length).toBeGreaterThan(0);
    expect(run1.diagnostics!.crossLayerRankingOrder[0]).toBe(run2.diagnostics!.crossLayerRankingOrder[0]);
  });

  // 3. canonical outranks derived
  it('Proof 3: Canonical/Higher-layer items always outrank lower-layer derived regardless of score', async () => {
    // RAG item has high semantic score
    const results = [
      { 
          itemKey: 'rag_high', 
          title: 'RAG Item', 
          content: 'High score RAG', 
          score: 0.95, 
          sourceType: 'doc',
          metadata: { canonicalId: 'conflict_1' } 
      },
    ];
    
    // Graph item has low score but higher layer priority (graph > rag)
    const graphItems = [
        {
            selectionClass: 'graph_context',
            sourceKey: 'graph_low',
            title: 'Graph Item',
            content: 'Low score Graph',
            score: 0.2,
            metadata: { canonicalId: 'conflict_1' }
        }
    ];

    const service = new ContextAssemblyService(
        createMockOrchestrator(results),
        new MemoryPolicyService(),
        { expandFromEvidence: async () => graphItems as any } as any // mock traversal
    );

    const result = await service.assemble({ query: 'test', policy: { groundingMode: 'graph_assisted' } as any });
    
    // The Graph item should win the conflict and be included.
    const decisions = result.diagnostics!.decisions;
    const ragDecision = decisions.find(d => d.candidateId === 'rag_high');
    const graphDecision = decisions.find(d => d.candidateId === 'graph_low');

    expect(graphDecision?.status).toBe('included');
    expect(ragDecision?.reasons).toContain('excluded.authority_conflict');
    expect(result.diagnostics!.authorityConflicts.length).toBeGreaterThan(0);
  });

  // 4. affective does not break determinism
  it('Proof 4: Affective weighting is deterministic and gated', async () => {
    const results = [
      { itemKey: 'e1', title: 'Happy item', content: 'good mood', score: 0.7, sourceType: 'doc' },
    ];
    // Mock AffectiveGraphService to provide a stable mood
    const mockAffectiveService = {
        getActiveAffectiveContext: async () => [
            { selectionClass: 'graph_context', content: 'joy', score: 1.0, metadata: { moodLabel: 'joy', affective: true } }
        ]
    } as any;
    
    const service = new ContextAssemblyService(
        createMockOrchestrator(results),
        new MemoryPolicyService(),
        { expandFromEvidence: async () => [] } as any, // graph traversal
        mockAffectiveService
    );

    const request: ContextAssemblyRequest = { query: 'test', policy: { groundingMode: 'exploratory' } as any };
    const run1 = await service.assemble(request);
    const run2 = await service.assemble(request);

    expect(run1.diagnostics!.crossLayerCandidatePool[0].scoreBreakdown.affectiveAdjustment)
        .toBe(run2.diagnostics!.crossLayerCandidatePool[0].scoreBreakdown.affectiveAdjustment);
    expect(run1.items).toEqual(run2.items);
  });

  // 5. budget selection stable
  it('Proof 5: Global budget selection is stable (Greedy selection)', async () => {
    const results = [
      { itemKey: 'e1', title: 'E1', content: 'C1', score: 0.9, sourceType: 'doc' },
      { itemKey: 'e2', title: 'E2', content: 'C2', score: 0.8, sourceType: 'doc' },
      { itemKey: 'e3', title: 'E3', content: 'C3', score: 0.7, sourceType: 'doc' },
    ];
    const service = new ContextAssemblyService(createMockOrchestrator(results));
    
    // Set maxItems to 2
    const request: ContextAssemblyRequest = { 
        query: 'test', 
        policy: { 
            groundingMode: 'exploratory',
            contextBudget: { maxItems: 2 } 
        } as any
    };

    const result = await service.assemble(request);
    const included = result.items.filter(i => i.selectionClass !== 'latent');

    expect(included.length).toBeLessThanOrEqual(2);
  });

  // 6. normalization behaves predictably
  it('Proof 6: Score normalization is bounded and predictable', async () => {
    const results = [
      { itemKey: 'e1', title: 'E1', content: 'C1', score: 0.9, sourceType: 'doc' },
    ];
    const service = new ContextAssemblyService(createMockOrchestrator(results));
    const result = await service.assemble({ query: 'test', policy: { groundingMode: 'exploratory' } as any });
    
    const norm = result.diagnostics!.normalizationDetails;
    expect(norm.min).toBeGreaterThanOrEqual(0);
    expect(norm.max).toBeLessThanOrEqual(1.5); // Allow some headroom for boosts
    expect(norm.avg).toBeGreaterThan(0);
  });

  // 7. diagnostics complete
  it('Proof 7: Diagnostics are complete (No missing decisions)', async () => {
    const results = [
      { itemKey: 'e1', title: 'E1', content: 'C1', score: 0.9, sourceType: 'doc' },
      { itemKey: 'e2', title: 'E2', content: 'C2', score: 0.8, sourceType: 'doc' },
    ];
    const service = new ContextAssemblyService(createMockOrchestrator(results));
    const result = await service.assemble({ query: 'test', policy: { groundingMode: 'exploratory' } as any });
    
    const candidates = result.diagnostics!.crossLayerRankingOrder;
    const decisions = result.diagnostics!.decisions.map(d => d.candidateId);

    expect(candidates.every(c => decisions.includes(c))).toBe(true);
    expect(result.diagnostics!.totalCandidatesConsidered).toBe(candidates.length);
  });

  // 8. removing candidate changes ranking deterministically
  it('Proof 8: Removing a top candidate shifts ranking deterministically', async () => {
    const resultsFull = [
      { itemKey: 'e1', title: 'E1', content: 'C1', score: 0.9, sourceType: 'doc' },
      { itemKey: 'e2', title: 'E2', content: 'C2', score: 0.8, sourceType: 'doc' },
      { itemKey: 'e3', title: 'E3', content: 'C3', score: 0.7, sourceType: 'doc' },
    ];
    
    const serviceFull = new ContextAssemblyService(createMockOrchestrator(resultsFull));
    const resFull = await serviceFull.assemble({ query: 'test', policy: { groundingMode: 'exploratory' } as any });
    
    // Remove e1
    const resultsPartial = resultsFull.slice(1);
    const servicePartial = new ContextAssemblyService(createMockOrchestrator(resultsPartial));
    const resPartial = await servicePartial.assemble({ query: 'test', policy: { groundingMode: 'exploratory' } as any });

    // The second candidate in full must be the first in partial
    expect(resPartial.diagnostics!.crossLayerRankingOrder[0]).toBe(resFull.diagnostics!.crossLayerRankingOrder[1]);
    expect(resFull.diagnostics!.crossLayerRankingOrder[0]).toBe('e1');
  });

});
