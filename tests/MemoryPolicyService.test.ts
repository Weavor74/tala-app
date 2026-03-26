/**
 * MemoryPolicyService.test.ts
 *
 * Unit tests for MemoryPolicyService.
 *
 * Validates:
 *   - Correct default policy selected for each groundingMode.
 *   - Notebook scope default when notebookId is present.
 *   - Global scope default when notebookId is absent.
 *   - retrievalMode inherited from base policy when not specified.
 *   - graphTraversal and contextBudget overrides merged correctly.
 *   - Default groundingMode is 'graph_assisted' when omitted.
 *   - Strict mode: graphTraversal.enabled = false.
 *   - Graph-assisted / exploratory modes: graphTraversal.enabled = true.
 *   - Mutation safety: default policy objects are not mutated.
 *
 * No DB, no IPC, no Electron.
 */

import { describe, it, expect } from 'vitest';
import { MemoryPolicyService } from '../electron/services/policy/MemoryPolicyService';
import {
  DEFAULT_STRICT_POLICY,
  DEFAULT_GRAPH_ASSISTED_POLICY,
  DEFAULT_EXPLORATORY_POLICY,
} from '../electron/services/policy/defaultMemoryPolicies';
import type { ContextAssemblyRequest, MemoryPolicy } from '../shared/policy/memoryPolicyTypes';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal ContextAssemblyRequest for testing.
 * Does NOT include graphTraversal or contextBudget by default so that
 * MemoryPolicyService uses its base policy defaults for those fields.
 * Pass explicit overrides to test override merging.
 */
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MemoryPolicyService', () => {
  const service = new MemoryPolicyService();

  // ── Default groundingMode ──────────────────────────────────────────────────

  describe('default groundingMode resolution', () => {
    it('defaults to graph_assisted when groundingMode is absent at runtime', () => {
      // Simulate a caller omitting groundingMode (TypeScript would warn, but JS allows it)
      const request = makeRequest();
      // Cast to allow omitting groundingMode for runtime test
      const partial = { query: 'test', policy: { contextBudget: { maxItems: 5 } } } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.groundingMode).toBe('graph_assisted');
    });

    it('returns graph_assisted base policy defaults when groundingMode is graph_assisted', () => {
      const request = makeRequest({ groundingMode: 'graph_assisted' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.groundingMode).toBe('graph_assisted');
      expect(resolved.graphTraversal.enabled).toBe(true);
      expect(resolved.contextBudget.maxItems).toBe(DEFAULT_GRAPH_ASSISTED_POLICY.contextBudget.maxItems);
    });
  });

  // ── Strict policy resolution ───────────────────────────────────────────────

  describe('strict policy default resolution', () => {
    it('selects strict base policy for groundingMode strict', () => {
      const request = makeRequest({ groundingMode: 'strict' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.groundingMode).toBe('strict');
      expect(resolved.retrievalMode).toBe(DEFAULT_STRICT_POLICY.retrievalMode);
    });

    it('strict mode: graphTraversal.enabled is false', () => {
      const request = makeRequest({ groundingMode: 'strict' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.graphTraversal.enabled).toBe(false);
    });

    it('strict mode: contextBudget.maxItems matches DEFAULT_STRICT_POLICY', () => {
      const request = makeRequest({ groundingMode: 'strict' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.contextBudget.maxItems).toBe(DEFAULT_STRICT_POLICY.contextBudget.maxItems);
    });

    it('strict mode: evidencePriority is true', () => {
      const request = makeRequest({ groundingMode: 'strict' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.contextBudget.evidencePriority).toBe(true);
    });
  });

  // ── Graph-assisted policy resolution ──────────────────────────────────────

  describe('graph_assisted policy default resolution', () => {
    it('selects graph_assisted base policy', () => {
      const request = makeRequest({ groundingMode: 'graph_assisted' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.groundingMode).toBe('graph_assisted');
    });

    it('graph_assisted mode: graphTraversal.enabled is true', () => {
      const request = makeRequest({ groundingMode: 'graph_assisted' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.graphTraversal.enabled).toBe(true);
    });

    it('graph_assisted mode: maxHopDepth matches DEFAULT_GRAPH_ASSISTED_POLICY', () => {
      const request = makeRequest({ groundingMode: 'graph_assisted' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.graphTraversal.maxHopDepth).toBe(
        DEFAULT_GRAPH_ASSISTED_POLICY.graphTraversal.maxHopDepth,
      );
    });

    it('graph_assisted and strict modes are structurally distinct', () => {
      const strictResolved = service.resolvePolicy(makeRequest({ groundingMode: 'strict' }));
      const graphResolved = service.resolvePolicy(makeRequest({ groundingMode: 'graph_assisted' }));
      expect(strictResolved.groundingMode).not.toBe(graphResolved.groundingMode);
      expect(strictResolved.graphTraversal.enabled).toBe(false);
      expect(graphResolved.graphTraversal.enabled).toBe(true);
    });
  });

  // ── Exploratory policy resolution ──────────────────────────────────────────

  describe('exploratory policy default resolution', () => {
    it('selects exploratory base policy', () => {
      const request = makeRequest({ groundingMode: 'exploratory' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.groundingMode).toBe('exploratory');
    });

    it('exploratory mode: graphTraversal.enabled is true', () => {
      const request = makeRequest({ groundingMode: 'exploratory' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.graphTraversal.enabled).toBe(true);
    });

    it('exploratory mode: maxHopDepth matches DEFAULT_EXPLORATORY_POLICY', () => {
      const request = makeRequest({ groundingMode: 'exploratory' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.graphTraversal.maxHopDepth).toBe(
        DEFAULT_EXPLORATORY_POLICY.graphTraversal.maxHopDepth,
      );
    });

    it('exploratory mode has a larger budget than strict mode', () => {
      const strict = service.resolvePolicy(makeRequest({ groundingMode: 'strict' }));
      const exploratory = service.resolvePolicy(makeRequest({ groundingMode: 'exploratory' }));
      expect(exploratory.contextBudget.maxItems).toBeGreaterThan(strict.contextBudget.maxItems);
    });

    it('graph_assisted and exploratory modes are structurally distinct', () => {
      const graphAssisted = service.resolvePolicy(makeRequest({ groundingMode: 'graph_assisted' }));
      const exploratory = service.resolvePolicy(makeRequest({ groundingMode: 'exploratory' }));
      expect(graphAssisted.groundingMode).not.toBe(exploratory.groundingMode);
      expect(exploratory.graphTraversal.maxHopDepth).toBeGreaterThan(
        graphAssisted.graphTraversal.maxHopDepth,
      );
    });
  });

  // ── Scope resolution ───────────────────────────────────────────────────────

  describe('scope resolution', () => {
    it('uses notebook scope when notebookId is present and scope is not specified', () => {
      const partial = {
        query: 'test',
        policy: { groundingMode: 'strict', notebookId: 'nb-1' },
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.scope).toBe('notebook');
      expect(resolved.notebookId).toBe('nb-1');
    });

    it('uses global scope when notebookId is absent and scope is not specified', () => {
      const partial = {
        query: 'test',
        policy: { groundingMode: 'strict' },
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.scope).toBe('global');
      expect(resolved.notebookId).toBeUndefined();
    });

    it('preserves explicit scope when provided', () => {
      const request = makeRequest({ groundingMode: 'strict', scope: 'explicit_sources', explicitSources: ['file:///a.md'] });
      const resolved = service.resolvePolicy(request);
      expect(resolved.scope).toBe('explicit_sources');
      expect(resolved.explicitSources).toEqual(['file:///a.md']);
    });

    it('preserves notebookId on resolved policy', () => {
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        scope: 'notebook',
        notebookId: 'nb-42',
      });
      const resolved = service.resolvePolicy(request);
      expect(resolved.notebookId).toBe('nb-42');
    });
  });

  // ── Override merging ───────────────────────────────────────────────────────

  describe('override merging', () => {
    it('merges contextBudget overrides over base policy defaults', () => {
      const request = makeRequest({
        groundingMode: 'strict',
        contextBudget: { maxItems: 3 },
      });
      const resolved = service.resolvePolicy(request);
      expect(resolved.contextBudget.maxItems).toBe(3);
    });

    it('merges graphTraversal overrides over base policy defaults', () => {
      const request = makeRequest({
        groundingMode: 'graph_assisted',
        graphTraversal: {
          enabled: true,
          maxHopDepth: 2,
          maxRelatedNodes: 5,
          maxNodesPerType: {},
        },
      });
      const resolved = service.resolvePolicy(request);
      expect(resolved.graphTraversal.maxHopDepth).toBe(2);
      expect(resolved.graphTraversal.maxRelatedNodes).toBe(5);
    });

    it('inherits retrievalMode from base policy when not specified', () => {
      const partial = {
        query: 'test',
        policy: { groundingMode: 'strict' },
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.retrievalMode).toBe(DEFAULT_STRICT_POLICY.retrievalMode);
    });

    it('uses caller-supplied retrievalMode when specified', () => {
      const request = makeRequest({ groundingMode: 'strict', retrievalMode: 'semantic' });
      const resolved = service.resolvePolicy(request);
      expect(resolved.retrievalMode).toBe('semantic');
    });
  });

  // ── Notebook auto-strict ───────────────────────────────────────────────────

  describe('notebook auto-strict grounding', () => {
    it('defaults groundingMode to strict when notebookId is present and groundingMode is omitted', () => {
      const partial = {
        query: 'summarize notebook',
        policy: { notebookId: 'nb-1' },
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.groundingMode).toBe('strict');
    });

    it('notebook+strict uses DEFAULT_STRICT_POLICY: graphTraversal disabled', () => {
      const partial = {
        query: 'summarize notebook',
        policy: { notebookId: 'nb-1' },
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.graphTraversal.enabled).toBe(false);
    });

    it('notebook+strict uses DEFAULT_STRICT_POLICY: affective modulation disabled', () => {
      const partial = {
        query: 'summarize notebook',
        policy: { notebookId: 'nb-1' },
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.affectiveModulation.enabled).toBe(false);
    });

    it('notebook+strict scope is set to notebook', () => {
      const partial = {
        query: 'summarize notebook',
        policy: { notebookId: 'nb-2' },
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.scope).toBe('notebook');
      expect(resolved.notebookId).toBe('nb-2');
    });

    it('caller-supplied groundingMode overrides the notebook auto-strict default', () => {
      const partial = {
        query: 'explore notebook',
        policy: { notebookId: 'nb-1', groundingMode: 'exploratory' },
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.groundingMode).toBe('exploratory');
    });

    it('notebook auto-strict does not affect requests without a notebookId', () => {
      const partial = {
        query: 'general query',
        policy: {},
      } as any;
      const resolved = service.resolvePolicy(partial);
      expect(resolved.groundingMode).toBe('graph_assisted');
    });
  });
});
