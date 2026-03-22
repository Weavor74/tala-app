/**
 * ContextAssemblyStrategy.test.ts
 *
 * P7E — Adaptive Context Strategy Tests
 *
 * Verifies that the strategy layer correctly resolves profiles based on
 * deterministic policy signals and applies budget/weight adjustments
 * without breaking overall determinism or canonical authority.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextAssemblyService } from '../../services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../../services/policy/MemoryPolicyService';
import { RetrievalOrchestrator } from '../../services/retrieval/RetrievalOrchestrator';
import { GraphTraversalService } from '../../services/graph/GraphTraversalService';
import type {
  NormalizedSearchResult,
  RetrievalResponse,
  RetrievalScopeResolved,
} from '../../../shared/retrieval/retrievalTypes';
import type {
  ContextAssemblyRequest,
  MemoryPolicy,
} from '../../../shared/policy/memoryPolicyTypes';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResult(
  overrides: Partial<NormalizedSearchResult> & { itemKey: string; title: string; providerId: string },
): NormalizedSearchResult {
  return {
    uri: null,
    sourcePath: null,
    snippet: overrides.snippet ?? `Content for ${overrides.title}`,
    sourceType: null,
    externalId: null,
    contentHash: null,
    score: null,
    metadata: {},
    ...overrides,
  };
}

function makeRetrievalResponse(results: NormalizedSearchResult[]): RetrievalResponse {
  return {
    query: 'test',
    mode: 'hybrid',
    scopeResolved: { scopeType: 'global', uris: [], sourcePaths: [], itemKeys: [] },
    results,
    providerResults: [],
    totalResults: results.length,
    durationMs: 2,
  };
}

function makeMockOrchestrator(results: NormalizedSearchResult[]): RetrievalOrchestrator {
  return {
    retrieve: vi.fn().mockResolvedValue(makeRetrievalResponse(results)),
  } as unknown as RetrievalOrchestrator;
}

function makeNoopGraphService(): GraphTraversalService {
  return {
    expandFromEvidence: vi.fn().mockResolvedValue([]),
  } as unknown as GraphTraversalService;
}

function makeRequest(policyOverride: Partial<MemoryPolicy> = {}): ContextAssemblyRequest {
  return {
    query: 'test query',
    policy: {
      groundingMode: 'graph_assisted',
      retrievalMode: 'hybrid',
      scope: 'global',
      contextBudget: { maxItems: 10, maxTokens: 4000 },
      ...policyOverride
    } as MemoryPolicy,
  };
}

const policyService = new MemoryPolicyService();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Adaptive Context Strategy (P7E)', () => {
  it('resolves graph_exploratory strategy for graph retrieval mode', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    
    // retrievalMode: 'graph' -> graph_exploratory
    const result = await service.assemble(makeRequest({
      retrievalMode: 'graph'
    }));
    
    expect(result.diagnostics?.strategyMode).toBe('graph_exploratory');
  });

  it('resolves recall_strict strategy for strict grounding mode', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    
    // groundingMode: strict -> recall_strict
    const result = await service.assemble(makeRequest({
      groundingMode: 'strict'
    }));
    
    expect(result.diagnostics?.strategyMode).toBe('recall_strict');
    // recall_strict reduces evidence items by 1
    expect(result.policy.contextBudget.maxItems).toBe(9); 
  });

  it('resolves recall_exploratory strategy for exploratory grounding mode', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    
    // groundingMode: exploratory -> recall_exploratory
    const result = await service.assemble(makeRequest({
      groundingMode: 'exploratory'
    }));
    
    expect(result.diagnostics?.strategyMode).toBe('recall_exploratory');
    // recall_exploratory increases evidence items by 5
    expect(result.policy.contextBudget.maxItems).toBe(15);
  });

  it('resolves task_execution strategy for notebook scope when otherwise balanced', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    
    // scope: notebook -> task_execution
    // This should now correctly resolve even with graph_assisted grounding mode
    const result = await service.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      scope: 'notebook'
    }));
    
    expect(result.diagnostics?.strategyMode).toBe('task_execution');
  });

  it('applies weight multipliers correctly in scoring pass-through', async () => {
    const results = [
      makeResult({ itemKey: 'e1', title: 'Evidence A', providerId: 'local', score: 0.1 }),
    ];
    
    // recall_strict has weightAdjustments: [{ sourceLayer: 'rag', multiplier: 0.8 }]
    const orchestrator = makeMockOrchestrator(results);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    
    const result = await service.assemble(makeRequest({
      groundingMode: 'strict'
    }));
    
    const diag = result.diagnostics!;
    expect(diag.strategyResolution!.appliedWeightMultipliers['rag']).toBe(0.8);
    
    // Verify candidate in pool has the multiplier recorded or applied
    const candidate = diag.crossLayerCandidatePool[0];
    expect(candidate.scoreBreakdown.finalScore).toBeGreaterThan(0);
  });

  it('ensures budget adjustments are bounded (clamping min items)', async () => {
    const orchestrator = makeMockOrchestrator([]);
    const service = new ContextAssemblyService(orchestrator, policyService, makeNoopGraphService());
    
    // recall_strict reduces maxItems by 1. 
    // If base is 1, it should stay 1 (clamped to Math.max(1, ...))
    const result = await service.assemble(makeRequest({
      groundingMode: 'strict',
      contextBudget: { maxItems: 1 }
    }));
    
    expect(result.policy.contextBudget.maxItems).toBe(1);
  });
});
