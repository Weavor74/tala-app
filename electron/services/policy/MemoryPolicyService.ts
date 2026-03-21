/**
 * MemoryPolicyService.ts
 *
 * Resolves a canonical MemoryPolicy from a ContextAssemblyRequest.
 *
 * Responsibilities:
 *   1. Select the appropriate default policy by groundingMode.
 *   2. Derive scope: 'notebook' when notebookId is present, 'global' otherwise.
 *   3. Apply shallow/deep override merging for budget and graphTraversal fields
 *      supplied by the request, without mutating the default policy objects.
 *   4. Return a fully resolved MemoryPolicy ready for use by ContextAssemblyService.
 *
 * DESIGN PRINCIPLES:
 *   - Side-effect free and deterministic. The same request always produces the
 *     same policy.
 *   - Defaults are never mutated. Deep-merge creates new objects.
 *   - Policy logic stays in this service. Do not duplicate this logic in the
 *     assembler, IPC handlers, or renderer.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type {
  MemoryPolicy,
  ContextAssemblyRequest,
  GroundingMode,
  GraphTraversalPolicy,
  ContextBudgetPolicy,
  AffectiveModulationPolicy,
} from '../../../shared/policy/memoryPolicyTypes';
import type { RetrievalMode } from '../../../shared/retrieval/retrievalTypes';
import {
  DEFAULT_STRICT_POLICY,
  DEFAULT_GRAPH_ASSISTED_POLICY,
  DEFAULT_EXPLORATORY_POLICY,
} from './defaultMemoryPolicies';

export class MemoryPolicyService {

  /**
   * Resolve a fully-specified MemoryPolicy from a ContextAssemblyRequest.
   *
   * Resolution rules (in order):
   *   1. groundingMode — taken from request.policy.groundingMode; defaults to
   *      'graph_assisted' when absent/null at runtime.
   *   2. Base policy — selected by groundingMode from the three default policies.
   *   3. retrievalMode — taken from request.policy.retrievalMode if present;
   *      otherwise inherited from the base policy.
   *   4. scope — taken from request.policy.scope if present; otherwise derived
   *      from notebookId: 'notebook' when notebookId exists, 'global' otherwise.
   *   5. notebookId — preserved from request.policy.notebookId.
   *   6. explicitSources — preserved from request.policy.explicitSources.
   *   7. graphTraversal — shallow-merged: base values are overridden by any
   *      fields present in request.policy.graphTraversal.
   *   8. contextBudget — shallow-merged: base values are overridden by any
   *      fields present in request.policy.contextBudget.
   */
  resolvePolicy(request: ContextAssemblyRequest): MemoryPolicy {
    // Cast to allow safe runtime access of potentially partial/absent fields.
    // The TypeScript type requires policy to be a full MemoryPolicy, but
    // callers may supply partial shapes at runtime. We handle this gracefully.
    const raw = (request.policy ?? {}) as Partial<MemoryPolicy>;

    // 1. Determine groundingMode with a sensible default.
    const groundingMode: GroundingMode = raw.groundingMode ?? 'graph_assisted';

    // 2. Select the appropriate base policy.
    const base = this._selectBasePolicy(groundingMode);

    // 3. Determine retrievalMode.
    const retrievalMode: RetrievalMode = raw.retrievalMode ?? base.retrievalMode;

    // 4. Determine notebookId and scope.
    const notebookId = raw.notebookId;
    const scope = raw.scope ?? (notebookId ? 'notebook' : 'global');

    // 5. Merge graphTraversal overrides over the base traversal policy.
    const graphTraversal: GraphTraversalPolicy = raw.graphTraversal
      ? { ...base.graphTraversal, ...raw.graphTraversal }
      : { ...base.graphTraversal };

    // 6. Merge contextBudget overrides over the base budget policy.
    const contextBudget: ContextBudgetPolicy = raw.contextBudget
      ? { ...base.contextBudget, ...raw.contextBudget }
      : { ...base.contextBudget };

    // 7. Merge affectiveModulation overrides over the base affective policy.
    //    When the base policy has no affectiveModulation, use a disabled default
    //    so that downstream consumers always receive a defined policy object.
    const baseAffective: AffectiveModulationPolicy = base.affectiveModulation ?? {
      enabled: false,
      maxAffectiveNodes: 0,
      allowToneModulation: false,
      allowGraphOrderingInfluence: false,
      allowGraphExpansionInfluence: false,
      allowEvidenceReordering: false,
      affectiveWeight: 0,
      requireLabeling: true,
    };
    const affectiveModulation: AffectiveModulationPolicy = raw.affectiveModulation
      ? { ...baseAffective, ...raw.affectiveModulation }
      : { ...baseAffective };

    return {
      groundingMode,
      retrievalMode,
      scope,
      notebookId,
      explicitSources: raw.explicitSources,
      graphTraversal,
      contextBudget,
      affectiveModulation,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _selectBasePolicy(groundingMode: GroundingMode): MemoryPolicy {
    switch (groundingMode) {
      case 'strict':
        return DEFAULT_STRICT_POLICY;
      case 'exploratory':
        return DEFAULT_EXPLORATORY_POLICY;
      case 'graph_assisted':
      default:
        return DEFAULT_GRAPH_ASSISTED_POLICY;
    }
  }
}
