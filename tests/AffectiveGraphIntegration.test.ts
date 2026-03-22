/**
 * AffectiveGraphIntegration.test.ts
 *
 * Integration tests for the Step 6E runtime wiring seam:
 *   IpcRouter context:assemble → AffectiveGraphService → AstroServiceSeam
 *
 * Validates:
 *   - context:assemble with Astro runtime available → affective items included when policy allows
 *   - context:assemble with Astro runtime unavailable (null) → no affective items, no crash
 *   - context:assemble with Astro runtime not ready → no affective items, no crash
 *   - strict mode through composition path → no affective items by default
 *   - graph_assisted through composition path → bounded affective items present
 *   - exploratory through composition path → bounded affective items present
 *   - [AFFECTIVE CONTEXT] appears in rendered output when appropriate
 *   - evidence ordering is unchanged when affective items are present
 *   - AstroService throws during state retrieval → graceful degradation, assembly completes
 *
 * These tests compose ContextAssemblyService + AffectiveGraphService directly (no
 * live Electron IPC) using the same pattern as ContextAssemblyService.test.ts.
 * The Astro runtime is always mocked — no real Astro engine is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssemblyService } from '../electron/services/context/ContextAssemblyService';
import { MemoryPolicyService } from '../electron/services/policy/MemoryPolicyService';
import { GraphTraversalService } from '../electron/services/graph/GraphTraversalService';
import { AffectiveGraphService } from '../electron/services/graph/AffectiveGraphService';
import type { AstroServiceSeam } from '../electron/services/graph/AffectiveGraphService';
import type { RetrievalOrchestrator } from '../electron/services/retrieval/RetrievalOrchestrator';
import type {
  NormalizedSearchResult,
  RetrievalResponse,
  RetrievalScopeResolved,
} from '../shared/retrieval/retrievalTypes';
import type {
  ContextAssemblyRequest,
  MemoryPolicy,
  AffectiveModulationPolicy,
} from '../shared/policy/memoryPolicyTypes';

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

function makeRetrievalResponse(
  results: NormalizedSearchResult[],
  overrides: Partial<RetrievalResponse> = {},
): RetrievalResponse {
  return {
    query: 'test',
    mode: 'hybrid',
    scopeResolved: makeScopeResolved(),
    results,
    providerResults: [],
    totalResults: results.length,
    durationMs: 5,
    ...overrides,
  };
}

function makeMockOrchestrator(results: NormalizedSearchResult[]): RetrievalOrchestrator {
  return {
    retrieve: vi.fn().mockResolvedValue(makeRetrievalResponse(results)),
  } as unknown as RetrievalOrchestrator;
}

function makeEvidence(n = 2): NormalizedSearchResult[] {
  return Array.from({ length: n }, (_, i) => makeResult({
    itemKey: `ev-${i}`,
    title: `Evidence ${i}`,
    providerId: 'local',
    score: 0.9 - i * 0.1,
    snippet: `Evidence content ${i}`,
  }));
}

function makeAffectivePolicy(
  overrides: Partial<AffectiveModulationPolicy> = {},
): AffectiveModulationPolicy {
  return {
    enabled: true,
    maxAffectiveNodes: 2,
    allowToneModulation: true,
    allowGraphOrderingInfluence: false,
    allowGraphExpansionInfluence: false,
    allowEvidenceReordering: false,
    affectiveWeight: 0.1,
    requireLabeling: true,
    ...overrides,
  };
}

function makeRequest(policyOverride: Partial<MemoryPolicy> = {}): ContextAssemblyRequest {
  const partialPolicy: Partial<MemoryPolicy> = {
    groundingMode: 'graph_assisted',
    ...policyOverride,
  };
  return {
    query: 'test query',
    policy: partialPolicy as MemoryPolicy,
  };
}

/**
 * Build a mock AstroServiceSeam that reports as ready and returns a non-neutral
 * emotional state string and raw state object.
 */
function makeReadyAstroSeam(overrides: Partial<AstroServiceSeam> = {}): AstroServiceSeam {
  return {
    getReadyStatus: vi.fn().mockReturnValue(true),
    getEmotionalState: vi.fn().mockResolvedValue(
      '[ASTRO STATE]\nSystem Instructions: Focus with warm intensity today.\nEmotional Vector: warmth=0.7, intensity=0.6, clarity=0.5',
    ),
    getRawEmotionalState: vi.fn().mockResolvedValue({
      mood_label: 'warmly_focused',
      emotional_vector: { warmth: 0.7, intensity: 0.6, clarity: 0.5 },
    }),
    ...overrides,
  };
}

/**
 * Build a mock AstroServiceSeam that reports as NOT ready.
 */
function makeNotReadyAstroSeam(): AstroServiceSeam {
  return {
    getReadyStatus: vi.fn().mockReturnValue(false),
    getEmotionalState: vi.fn().mockResolvedValue('[ASTRO STATE]: Offline'),
    getRawEmotionalState: vi.fn().mockResolvedValue(null),
  };
}

// ─── Factory mirroring IpcRouter composition root (Step 6E) ─────────────────

/**
 * Compose a ContextAssemblyService the same way IpcRouter does in the
 * context:assemble handler after Step 6E wiring:
 *   - RetrievalOrchestrator (required)
 *   - MemoryPolicyService (new per call)
 *   - GraphTraversalService (new per call)
 *   - AffectiveGraphService(astroSeam) or null when astro is unavailable
 */
function buildAssembler(
  orchestrator: RetrievalOrchestrator,
  astroSeam: AstroServiceSeam | null,
): ContextAssemblyService {
  const policyService = new MemoryPolicyService();
  const affectiveService = astroSeam ? new AffectiveGraphService(astroSeam) : null;
  return new ContextAssemblyService(
    orchestrator,
    policyService,
    new GraphTraversalService(),
    affectiveService,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AffectiveGraphIntegration — IpcRouter composition path (Step 6E)', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Astro runtime unavailable ──────────────────────────────────────────────

  it('assembles context without affective items when astroSeam is null (Astro unavailable)', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, null);
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy(),
    }));

    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    expect(affectiveItems).toHaveLength(0);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('does not throw when astroSeam is null', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(1));
    const assembler = buildAssembler(orchestrator, null);
    await expect(
      assembler.assemble(makeRequest({ groundingMode: 'exploratory', affectiveModulation: makeAffectivePolicy() })),
    ).resolves.not.toThrow();
  });

  // ── Astro runtime not ready ────────────────────────────────────────────────

  it('returns no affective items when Astro seam is not ready', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeNotReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy(),
    }));

    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    expect(affectiveItems).toHaveLength(0);
    expect(result.items.some(i => i.selectionClass === 'evidence')).toBe(true);
  });

  // ── Astro runtime available ────────────────────────────────────────────────

  it('includes affective items in graph_assisted mode when Astro is ready and policy enabled', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy({ maxAffectiveNodes: 2 }),
    }));

    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    expect(affectiveItems.length).toBeGreaterThan(0);
    expect(affectiveItems.length).toBeLessThanOrEqual(2);
  });

  it('includes affective items in exploratory mode when Astro is ready and policy enabled', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'exploratory',
      affectiveModulation: makeAffectivePolicy({ maxAffectiveNodes: 4 }),
    }));

    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    expect(affectiveItems.length).toBeGreaterThan(0);
    expect(affectiveItems.length).toBeLessThanOrEqual(4);
  });

  // ── Strict mode ────────────────────────────────────────────────────────────

  it('excludes affective items in strict mode even when Astro is ready and policy enables them', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'strict',
      affectiveModulation: makeAffectivePolicy({ enabled: true, maxAffectiveNodes: 4 }),
    }));

    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    expect(affectiveItems).toHaveLength(0);
  });

  it('excludes all graph_context items (structural and affective) in strict mode', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(3));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'strict',
      affectiveModulation: makeAffectivePolicy(),
    }));

    const graphItems = result.items.filter(i => i.selectionClass === 'graph_context');
    expect(graphItems).toHaveLength(0);
  });

  // ── Policy disabled ────────────────────────────────────────────────────────

  it('returns no affective items when affectiveModulation.enabled = false even if Astro is ready', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy({ enabled: false }),
    }));

    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    expect(affectiveItems).toHaveLength(0);
  });

  // ── Evidence ordering ──────────────────────────────────────────────────────

  it('preserves evidence ordering when affective items are present', async () => {
    const evidence = makeEvidence(3);
    const orchestrator = makeMockOrchestrator(evidence);
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy({ allowEvidenceReordering: false }),
    }));

    const evidenceItems = result.items.filter(i => i.selectionClass === 'evidence');
    // Evidence items should appear in descending score order (as retrieved)
    for (let i = 1; i < evidenceItems.length; i++) {
      const prev = evidenceItems[i - 1].score ?? 0;
      const curr = evidenceItems[i].score ?? 0;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('affective items are never classified as evidence', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'exploratory',
      affectiveModulation: makeAffectivePolicy({ maxAffectiveNodes: 4 }),
    }));

    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    for (const item of affectiveItems) {
      expect(item.selectionClass).toBe('graph_context');
      expect(item.selectionClass).not.toBe('evidence');
    }
  });

  // ── renderPromptBlocks ─────────────────────────────────────────────────────

  it('renderPromptBlocks includes [AFFECTIVE CONTEXT] section when affective items are present', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy({ maxAffectiveNodes: 2 }),
    }));

    const hasAffective = result.items.some(i => i.metadata?.affective === true);
    if (hasAffective) {
      const rendered = assembler.renderPromptBlocks(result);
      expect(rendered).toContain('[AFFECTIVE CONTEXT]');
    }
  });

  it('renderPromptBlocks omits [AFFECTIVE CONTEXT] when astroSeam is null', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, null);
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy(),
    }));

    const rendered = assembler.renderPromptBlocks(result);
    expect(rendered).not.toContain('[AFFECTIVE CONTEXT]');
  });

  it('renderPromptBlocks omits [AFFECTIVE CONTEXT] in strict mode', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'strict',
      affectiveModulation: makeAffectivePolicy(),
    }));

    const rendered = assembler.renderPromptBlocks(result);
    expect(rendered).not.toContain('[AFFECTIVE CONTEXT]');
  });

  // ── maxAffectiveNodes cap ─────────────────────────────────────────────────

  it('respects maxAffectiveNodes cap in graph_assisted mode', async () => {
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, makeReadyAstroSeam());
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy({ maxAffectiveNodes: 1 }),
    }));

    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    expect(affectiveItems.length).toBeLessThanOrEqual(1);
  });

  // ── Astro service throws during state retrieval ────────────────────────────

  it('gracefully degrades when AstroService.getEmotionalState throws — no affective items, no crash, no warning', async () => {
    // AffectiveGraphService internally catches getEmotionalState() failures and returns [].
    // No warning is emitted at the ContextAssemblyService level for this case.
    const throwingAstroSeam: AstroServiceSeam = {
      getReadyStatus: vi.fn().mockReturnValue(true),
      getEmotionalState: vi.fn().mockRejectedValue(new Error('MCP connection lost')),
      getRawEmotionalState: vi.fn().mockRejectedValue(new Error('MCP connection lost')),
    };
    const orchestrator = makeMockOrchestrator(makeEvidence(2));
    const assembler = buildAssembler(orchestrator, throwingAstroSeam);
    const result = await assembler.assemble(makeRequest({
      groundingMode: 'graph_assisted',
      affectiveModulation: makeAffectivePolicy(),
    }));

    // Assembly must succeed: durationMs is always set
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // Evidence items should still be present
    expect(result.items.some(i => i.selectionClass === 'evidence')).toBe(true);
    // No affective items should appear when state retrieval failed
    const affectiveItems = result.items.filter(i => i.metadata?.affective === true);
    expect(affectiveItems).toHaveLength(0);
  });

  // ── Full composition equivalence ──────────────────────────────────────────

  it('matches evidence item count when Astro is absent vs not ready', async () => {
    const evidence = makeEvidence(2);
    const orchA = makeMockOrchestrator([...evidence]);
    const orchB = makeMockOrchestrator([...evidence]);
    const req = makeRequest({ groundingMode: 'graph_assisted', affectiveModulation: makeAffectivePolicy() });

    const assemblerWithNull = buildAssembler(orchA, null);
    const assemblerWithNotReady = buildAssembler(orchB, makeNotReadyAstroSeam());

    const resultA = await assemblerWithNull.assemble(req);
    const resultB = await assemblerWithNotReady.assemble(req);

    // Both should have the same evidence items and neither should have affective items
    const affectiveA = resultA.items.filter(i => i.metadata?.affective === true);
    const affectiveB = resultB.items.filter(i => i.metadata?.affective === true);

    expect(affectiveA).toHaveLength(0);
    expect(affectiveB).toHaveLength(0);
    expect(resultA.items.filter(i => i.selectionClass === 'evidence')).toHaveLength(
      resultB.items.filter(i => i.selectionClass === 'evidence').length,
    );
  });
});
