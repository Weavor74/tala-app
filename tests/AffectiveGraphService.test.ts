/**
 * AffectiveGraphService.test.ts
 *
 * Unit tests for AffectiveGraphService — the affective graph modulation layer.
 *
 * Validates:
 *   - Returns empty array when groundingMode is 'strict'.
 *   - Returns empty array when affectiveModulation is absent on the policy.
 *   - Returns empty array when affectiveModulation.enabled is false.
 *   - Returns empty array when maxAffectiveNodes is 0.
 *   - Returns empty array when AstroService is not provided (null).
 *   - Returns empty array when AstroService.getReadyStatus() is false.
 *   - Returns empty array when AstroService returns a neutral/offline state.
 *   - Returns bounded affective graph_context items when all gates pass.
 *   - All returned items have selectionClass === 'graph_context'.
 *   - All returned items have metadata.affective === true.
 *   - All returned items have graphEdgeType === 'modulates'.
 *   - All returned items have graphEdgeTrust === 'session_only'.
 *   - requireLabeling === true: content is prefixed with the affective disclaimer.
 *   - requireLabeling === false: content has no disclaimer prefix.
 *   - maxAffectiveNodes cap is enforced.
 *   - affectiveWeight is clamped to MAX_AFFECTIVE_WEIGHT (0.3).
 *   - emotion_tag item is produced when rawState has a mood_label.
 *   - emotion_tag item is NOT produced when rawState is null.
 *   - Long astro state text is truncated in the astro_state item content.
 *   - Returns empty array when AstroService.getEmotionalState throws.
 *   - graph_assisted mode with enabled policy produces items.
 *   - exploratory mode with enabled policy produces items.
 *
 * No DB or network calls. AstroServiceSeam is mocked in all tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { AffectiveGraphService } from '../electron/services/graph/AffectiveGraphService';
import type {
  AstroServiceSeam,
  RawEmotionalState,
  GetActiveAffectiveContextArgs,
} from '../electron/services/graph/AffectiveGraphService';
import type { MemoryPolicy, AffectiveModulationPolicy } from '../shared/policy/memoryPolicyTypes';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tala-test' },
}));

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeAffectivePolicy(overrides: Partial<AffectiveModulationPolicy> = {}): AffectiveModulationPolicy {
  return {
    enabled: true,
    maxAffectiveNodes: 2,
    allowToneModulation: true,
    allowGraphOrderingInfluence: true,
    allowGraphExpansionInfluence: false,
    allowEvidenceReordering: false,
    affectiveWeight: 0.1,
    requireLabeling: true,
    ...overrides,
  };
}

function makePolicy(
  groundingMode: MemoryPolicy['groundingMode'] = 'graph_assisted',
  affectiveModulation?: AffectiveModulationPolicy,
): MemoryPolicy {
  return {
    groundingMode,
    retrievalMode: 'hybrid',
    scope: 'global',
    graphTraversal: {
      enabled: true,
      maxHopDepth: 1,
      maxRelatedNodes: 10,
      maxNodesPerType: {},
    },
    contextBudget: {
      maxItems: 15,
      evidencePriority: true,
    },
    affectiveModulation,
  };
}

function makeAstroSeam(overrides: Partial<AstroServiceSeam> = {}): AstroServiceSeam {
  return {
    getReadyStatus: () => true,
    getEmotionalState: vi.fn().mockResolvedValue(
      '[ASTRO STATE]\nSystem Instructions: Express warmth and nurturing energy.\nStyle Guide: Use gentle phrasing.\nwarmth: 0.8\nintensity: 0.6\nclarity: 0.5\ncaution: 0.4',
    ),
    getRawEmotionalState: vi.fn().mockResolvedValue({
      mood_label: 'Nurturing',
      emotional_vector: { warmth: 0.8, intensity: 0.6, clarity: 0.5, caution: 0.4 },
    } satisfies RawEmotionalState),
    ...overrides,
  };
}

function makeArgs(
  policy: MemoryPolicy,
  overrides: Partial<GetActiveAffectiveContextArgs> = {},
): GetActiveAffectiveContextArgs {
  return {
    policy,
    queryText: 'What is the memory architecture?',
    agentId: 'tala',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AffectiveGraphService', () => {

  // ── Policy gate: groundingMode ──────────────────────────────────────────────

  describe('strict groundingMode', () => {
    it('returns empty array regardless of policy flags', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('strict', makeAffectivePolicy({ enabled: true }))),
      );
      expect(result).toHaveLength(0);
    });
  });

  // ── Policy gate: affectiveModulation absent / disabled ──────────────────────

  describe('affectiveModulation absent on policy', () => {
    it('returns empty array when affectiveModulation is undefined', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', undefined)),
      );
      expect(result).toHaveLength(0);
    });
  });

  describe('affectiveModulation.enabled === false', () => {
    it('returns empty array', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ enabled: false }))),
      );
      expect(result).toHaveLength(0);
    });
  });

  describe('maxAffectiveNodes === 0', () => {
    it('returns empty array even when enabled is true', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ maxAffectiveNodes: 0 }))),
      );
      expect(result).toHaveLength(0);
    });
  });

  // ── Service gate: AstroService ──────────────────────────────────────────────

  describe('AstroService not provided', () => {
    it('returns empty array when astroService is null', async () => {
      const service = new AffectiveGraphService(null);
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );
      expect(result).toHaveLength(0);
    });
  });

  describe('AstroService not ready', () => {
    it('returns empty array when getReadyStatus returns false', async () => {
      const service = new AffectiveGraphService(makeAstroSeam({ getReadyStatus: () => false }));
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );
      expect(result).toHaveLength(0);
    });
  });

  // ── Neutral / offline state guards ─────────────────────────────────────────

  describe('neutral or offline state', () => {
    it.each([
      '[ASTRO STATE]: Neutral (Engine offline)',
      '[ASTRO STATE]: Error (Calculation failed)',
      '[ASTRO STATE]: Calculation returned no data',
      '',
    ])('returns empty array for state: %s', async (state) => {
      const service = new AffectiveGraphService(
        makeAstroSeam({ getEmotionalState: vi.fn().mockResolvedValue(state) }),
      );
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );
      expect(result).toHaveLength(0);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  describe('getEmotionalState throws', () => {
    it('returns empty array and does not throw', async () => {
      const service = new AffectiveGraphService(
        makeAstroSeam({
          getEmotionalState: vi.fn().mockRejectedValue(new Error('engine crash')),
        }),
      );
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );
      expect(result).toHaveLength(0);
    });
  });

  // ── Successful item production ──────────────────────────────────────────────

  describe('successful affective item production', () => {
    it('returns items with selectionClass === graph_context', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );

      expect(result.length).toBeGreaterThan(0);
      for (const item of result) {
        expect(item.selectionClass).toBe('graph_context');
      }
    });

    it('returns items with metadata.affective === true', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );

      for (const item of result) {
        expect(item.metadata?.affective).toBe(true);
      }
    });

    it('returns items with graphEdgeType === modulates', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );

      for (const item of result) {
        expect(item.graphEdgeType).toBe('modulates');
      }
    });

    it('returns items with graphEdgeTrust === session_only', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );

      for (const item of result) {
        expect(item.graphEdgeTrust).toBe('session_only');
      }
    });

    it('produces an astro_state item as the first item', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );

      expect(result[0].sourceType).toBe('astro_state');
      expect(result[0].metadata?.affectiveNodeType).toBe('astro_state');
    });

    it('produces an emotion_tag item when rawState has a mood_label', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ maxAffectiveNodes: 4 }))),
      );

      const emotionTag = result.find(i => i.sourceType === 'emotion_tag');
      expect(emotionTag).toBeDefined();
      expect(emotionTag?.metadata?.moodLabel).toBe('Nurturing');
    });

    it('does NOT produce an emotion_tag item when rawState is null', async () => {
      const service = new AffectiveGraphService(
        makeAstroSeam({
          getRawEmotionalState: vi.fn().mockResolvedValue(null),
        }),
      );
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ maxAffectiveNodes: 4 }))),
      );

      const emotionTag = result.find(i => i.sourceType === 'emotion_tag');
      expect(emotionTag).toBeUndefined();
    });
  });

  // ── requireLabeling ──────────────────────────────────────────────────────────

  describe('requireLabeling', () => {
    it('prefixes astro_state content with disclaimer when requireLabeling === true', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ requireLabeling: true }))),
      );

      const astroItem = result.find(i => i.sourceType === 'astro_state');
      expect(astroItem?.content).toMatch(/^\[Affective context — not evidence\]/);
    });

    it('does NOT prefix content when requireLabeling === false', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ requireLabeling: false }))),
      );

      const astroItem = result.find(i => i.sourceType === 'astro_state');
      expect(astroItem?.content).not.toMatch(/^\[Affective context — not evidence\]/);
    });
  });

  // ── maxAffectiveNodes cap ────────────────────────────────────────────────────

  describe('maxAffectiveNodes cap', () => {
    it('returns at most maxAffectiveNodes items', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ maxAffectiveNodes: 1 }))),
      );
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it('returns up to 2 items when maxAffectiveNodes is 2 and rawState has mood_label', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ maxAffectiveNodes: 2 }))),
      );
      expect(result.length).toBeLessThanOrEqual(2);
    });
  });

  // ── affectiveWeight clamping ─────────────────────────────────────────────────

  describe('affectiveWeight clamping', () => {
    it('clamps affectiveWeight above 0.3 to 0.3 for astro_state score', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ affectiveWeight: 0.9 }))),
      );

      const astroItem = result.find(i => i.sourceType === 'astro_state');
      expect(astroItem?.score).toBeLessThanOrEqual(0.3);
    });

    it('preserves affectiveWeight at or below 0.3 unchanged', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ affectiveWeight: 0.1 }))),
      );

      const astroItem = result.find(i => i.sourceType === 'astro_state');
      expect(astroItem?.score).toBe(0.1);
    });
  });

  // ── astro text truncation ─────────────────────────────────────────────────────

  describe('long astro state text', () => {
    it('truncates astro_state content to at most 400 characters plus ellipsis', async () => {
      const longState = '[ASTRO STATE]\n' + 'X'.repeat(600);
      const service = new AffectiveGraphService(
        makeAstroSeam({ getEmotionalState: vi.fn().mockResolvedValue(longState) }),
      );
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy({ requireLabeling: false }))),
      );

      const astroItem = result.find(i => i.sourceType === 'astro_state');
      // Content should end with '…' and the meaningful portion ≤ 400 chars
      expect(astroItem?.content).toMatch(/…$/);
      // Strip disclaimer prefix length if present, check body length
      const body = astroItem?.content ?? '';
      expect(body.length).toBeLessThanOrEqual(401); // 400 chars + '…'
    });
  });

  // ── Mode compatibility ────────────────────────────────────────────────────────

  describe('mode compatibility', () => {
    it('returns items in graph_assisted mode with enabled policy', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy())),
      );
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns items in exploratory mode with enabled policy', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('exploratory', makeAffectivePolicy({ maxAffectiveNodes: 4 }))),
      );
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ── notebookId in sourceKey ───────────────────────────────────────────────────

  describe('sourceKey includes notebookId', () => {
    it('incorporates notebookId into astro_state sourceKey when provided', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy()), { notebookId: 'nb-42' }),
      );

      const astroItem = result.find(i => i.sourceType === 'astro_state');
      expect(astroItem?.sourceKey).toContain('nb-42');
    });

    it('uses global when notebookId is null', async () => {
      const service = new AffectiveGraphService(makeAstroSeam());
      const result = await service.getActiveAffectiveContext(
        makeArgs(makePolicy('graph_assisted', makeAffectivePolicy()), { notebookId: null }),
      );

      const astroItem = result.find(i => i.sourceType === 'astro_state');
      expect(astroItem?.sourceKey).toContain('global');
    });
  });
});
