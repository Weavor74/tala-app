/**
 * ContextAssemblyDiagnostics.test.ts
 *
 * Specialized verification for the Feed 5 diagnostics extensions.
 */

import { describe, it, expect } from 'vitest';
import { ContextAssemblyService } from '../../services/context/ContextAssemblyService';
import type { RetrievalOrchestrator } from '../../services/retrieval/RetrievalOrchestrator';
import type { ContextAssemblyRequest } from '../../../shared/policy/memoryPolicyTypes';

describe('ContextAssemblyService Diagnostics Extensions (Feed 5)', () => {
  const mockOrchestrator: RetrievalOrchestrator = {
    retrieve: async () => ({
      results: [
        { itemKey: 'e1', title: 'Evidence 1', content: 'Content 1', score: 0.9, sourceType: 'document_chunk' },
        { itemKey: 'e2', title: 'Evidence 2', content: 'Content 2', score: 0.8, sourceType: 'document_chunk' },
      ],
    }),
  } as any;

  const service = new ContextAssemblyService(mockOrchestrator);

  it('populates all new Feed 5 diagnostic fields', async () => {
    const request: ContextAssemblyRequest = {
      query: 'test query',
      policy: { groundingMode: 'exploratory' } as any,
    };

    const result = await service.assemble(request);
    expect(result.diagnostics).toBeDefined();
    const diag = result.diagnostics!;

    expect(diag.crossLayerCandidatePool).toBeDefined();
    expect(diag.crossLayerCandidatePool.length).toBeGreaterThan(0);
    expect(diag.crossLayerRankingOrder).toBeDefined();
    expect(diag.crossLayerRankingOrder.length).toBe(diag.crossLayerCandidatePool.length);
    expect(diag.perSourceCounts).toBeDefined();
    expect(diag.perSourceCounts['rag']).toBeGreaterThan(0);
    expect(diag.exclusionBreakdown).toBeDefined();
    expect(diag.authorityConflicts).toBeDefined();
    expect(diag.normalizationDetails).toBeDefined();
    expect(diag.normalizationDetails.min).toBeLessThanOrEqual(diag.normalizationDetails.max);
  });

  it('correctly ranks candidates in crossLayerRankingOrder', async () => {
    const request: ContextAssemblyRequest = {
      query: 'test query',
      policy: { groundingMode: 'exploratory' } as any,
    };

    const result = await service.assemble(request);
    expect(result.diagnostics).toBeDefined();
    const diag = result.diagnostics!;

    // Check that IDs in crossLayerRankingOrder match the pool in order
    for (let i = 0; i < diag.crossLayerRankingOrder.length; i++) {
        expect(diag.crossLayerRankingOrder[i]).toBe(diag.crossLayerCandidatePool[i].id);
        expect(diag.crossLayerCandidatePool[i].rank).toBe(i + 1);
    }
  });

  it('answers "why X beat Y" via score breakdown in the pool', async () => {
    const request: ContextAssemblyRequest = {
      query: 'test query',
      policy: { groundingMode: 'exploratory' } as any,
    };

    const result = await service.assemble(request);
    expect(result.diagnostics).toBeDefined();
    const diag = result.diagnostics!;

    // e1 has higher semantic score than e2, so it should have a higher normalized score
    const first = diag.crossLayerCandidatePool.find(c => c.id === 'e1');
    const second = diag.crossLayerCandidatePool.find(c => c.id === 'e2');

    if (first && second) {
        expect(first.scoreBreakdown.normalizedScore).toBeGreaterThanOrEqual(second.scoreBreakdown.normalizedScore);
        // Explainability: we can see the full breakdown
        expect(first.scoreBreakdown.semanticScore).toBeDefined();
        expect(first.scoreBreakdown.authorityScore).toBeDefined();
    }
  });
});
