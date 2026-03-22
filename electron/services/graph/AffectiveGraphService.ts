/**
 * AffectiveGraphService.ts
 *
 * Affective graph modulation layer for the TALA context assembly pipeline.
 *
 * Responsibilities:
 *   1. Read the current astro/emotional state via the runtime seam (AstroService).
 *   2. Normalize that state into bounded, policy-governed graph_context-compatible
 *      ContextAssemblyItems with affective node types.
 *   3. Return items only when AffectiveModulationPolicy.enabled is true and
 *      the active groundingMode is NOT 'strict'.
 *   4. Enforce maxAffectiveNodes cap.
 *   5. Label all affective items as modulatory/non-authoritative.
 *   6. Clamp affectiveWeight to [0, MAX_AFFECTIVE_WEIGHT] to prevent policy bypass.
 *
 * CRITICAL CONSTRAINTS:
 *   - Affective items are NEVER evidence. selectionClass is always 'graph_context'.
 *   - Affective items do NOT override retrieved evidence.
 *   - No affective content is fabricated when astro/emotion state is absent.
 *   - All returned items carry metadata.affective = true and, when
 *     policy.requireLabeling is true, a disclaimer prefix in their content.
 *   - Strict grounding mode always returns an empty array regardless of policy.
 *   - AstroService is optional. When not provided the service degrades gracefully.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import type {
  MemoryPolicy,
  ContextAssemblyItem,
  AffectiveModulationPolicy,
} from '../../../shared/policy/memoryPolicyTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Hard upper bound on affectiveWeight. Values supplied above this threshold
 * are silently clamped to prevent policy bypass via configuration.
 */
const MAX_AFFECTIVE_WEIGHT = 0.3;

/** Prefix prepended to all affective item content when requireLabeling is true. */
const AFFECTIVE_LABEL_PREFIX = '[Affective context — not evidence]\n';

// ─── Runtime seam ─────────────────────────────────────────────────────────────

/**
 * Minimal interface for the AstroService methods used by AffectiveGraphService.
 *
 * This seam allows AffectiveGraphService to be tested without a live AstroService
 * instance and keeps the dependency on AstroService optional/injectable.
 */
export interface AstroServiceSeam {
  getReadyStatus(): boolean;
  getEmotionalState(agentId?: string, contextPrompt?: string): Promise<string>;
  getRawEmotionalState(agentId?: string): Promise<RawEmotionalState | null>;
}

/**
 * Shape of the raw emotional state object returned by AstroService.getRawEmotionalState().
 * Only the fields used by AffectiveGraphService are declared; additional fields are
 * preserved in metadata under the 'rawAstroState' key.
 */
export interface RawEmotionalState {
  mood_label?: string;
  emotional_vector?: {
    warmth?: number;
    intensity?: number;
    clarity?: number;
    caution?: number;
  };
  [key: string]: unknown;
}

// ─── Public args ──────────────────────────────────────────────────────────────

export interface GetActiveAffectiveContextArgs {
  /** The resolved MemoryPolicy governing this assembly pass. */
  policy: MemoryPolicy;
  /** Notebook ID for context; does not change retrieval scope for affective items. */
  notebookId?: string | null;
  /** The raw query text; used as context_prompt when calling AstroService. */
  queryText?: string;
  /** Agent ID passed to AstroService. Defaults to 'tala'. */
  agentId?: string;
}

// ─── AffectiveGraphService ────────────────────────────────────────────────────

export class AffectiveGraphService {

  constructor(
    /** Optional AstroService instance. When absent all calls return []. */
    private readonly astroService: AstroServiceSeam | null = null,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Return bounded affective ContextAssemblyItems for inclusion in the graph_context
   * portion of an assembled context block.
   *
   * Returns an empty array when:
   *   - policy.groundingMode is 'strict' (affective modulation disabled in strict mode).
   *   - policy.affectiveModulation is absent or enabled === false.
   *   - policy.affectiveModulation.maxAffectiveNodes === 0.
   *   - No AstroService was provided.
   *   - AstroService is not ready.
   *   - AstroService returns an empty or neutral-only state.
   *
   * All returned items:
   *   - have selectionClass === 'graph_context'
   *   - have metadata.affective === true
   *   - carry graphEdgeType === 'modulates' and graphEdgeTrust === 'session_only'
   *   - are labeled with AFFECTIVE_LABEL_PREFIX when requireLabeling is true
   */
  async getActiveAffectiveContext(
    args: GetActiveAffectiveContextArgs,
  ): Promise<ContextAssemblyItem[]> {
    const { policy, notebookId, queryText, agentId = 'tala' } = args;

    // 1. Strict mode: always return empty.
    if (policy.groundingMode === 'strict') {
      return [];
    }

    // 2. Policy gate: affective modulation must be explicitly enabled.
    const ap = this._resolveAffectivePolicy(policy);
    if (!ap.enabled || ap.maxAffectiveNodes === 0) {
      return [];
    }

    // 3. Service gate: AstroService must be provided and ready.
    if (!this.astroService || !this.astroService.getReadyStatus()) {
      return [];
    }

    // 4. Fetch emotional state.
    const contextPrompt = queryText ?? '';
    let stateText: string;
    let rawState: RawEmotionalState | null = null;

    try {
      stateText = await this.astroService.getEmotionalState(agentId, contextPrompt);
    } catch {
      return [];
    }

    // 5. Guard: skip neutral/offline states.
    if (this._isNeutralOrOffline(stateText)) {
      return [];
    }

    // 6. Attempt to fetch structured raw state for richer metadata.
    try {
      rawState = await this.astroService.getRawEmotionalState(agentId);
    } catch {
      // Non-fatal — proceed with text-only state.
    }

    // 7. Build affective context items from the state.
    const items = this._buildAffectiveItems(stateText, rawState, ap, notebookId ?? undefined);

    // 8. Apply maxAffectiveNodes cap.
    return items.slice(0, ap.maxAffectiveNodes);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the effective AffectiveModulationPolicy, substituting a
   * fully-disabled default when the policy field is absent.
   */
  private _resolveAffectivePolicy(policy: MemoryPolicy): AffectiveModulationPolicy {
    return policy.affectiveModulation ?? {
      enabled: false,
      maxAffectiveNodes: 0,
      allowToneModulation: false,
      allowGraphOrderingInfluence: false,
      allowGraphExpansionInfluence: false,
      allowEvidenceReordering: false,
      affectiveWeight: 0,
      requireLabeling: true,
    };
  }

  /**
   * Returns true when the astro state string signals unavailability or neutrality.
   * Prevents fabrication of affective items from uninformative engine outputs.
   */
  private _isNeutralOrOffline(stateText: string): boolean {
    if (!stateText || stateText.trim().length === 0) return true;
    const lower = stateText.toLowerCase();
    return (
      lower.includes('engine offline') ||
      lower.includes('neutral (engine') ||
      lower.includes('not ready') ||
      lower.includes('calculation failed') ||
      lower.includes('calculation returned no data')
    );
  }

  /**
   * Build the bounded list of affective ContextAssemblyItems from the parsed
   * emotional state. Each item corresponds to one affective node type.
   *
   * Items produced (in priority order, subject to maxAffectiveNodes cap):
   *   1. 'astro_state' — the current astrological/emotional summary.
   *   2. 'emotion_tag' — the mood label, when available from raw state.
   *
   * Both items use:
   *   - selectionClass: 'graph_context'
   *   - graphEdgeType: 'modulates'
   *   - graphEdgeTrust: 'session_only'
   *   - score: clamped affectiveWeight
   */
  private _buildAffectiveItems(
    stateText: string,
    rawState: RawEmotionalState | null,
    ap: AffectiveModulationPolicy,
    notebookId?: string,
  ): ContextAssemblyItem[] {
    const clampedWeight = Math.min(ap.affectiveWeight, MAX_AFFECTIVE_WEIGHT);
    const items: ContextAssemblyItem[] = [];

    // ── Item 1: astro_state node ──────────────────────────────────────────────
    const astroContent = ap.requireLabeling
      ? `${AFFECTIVE_LABEL_PREFIX}${this._summariseAstroText(stateText)}`
      : this._summariseAstroText(stateText);

    items.push({
      content: astroContent,
      selectionClass: 'graph_context',
      sourceType: 'astro_state',
      sourceKey: `astro_state:${notebookId ?? 'global'}`,
      title: 'Affective state (astro)',
      score: clampedWeight,
      graphEdgeType: 'modulates',
      graphEdgeTrust: 'session_only',
      metadata: {
        affective: true,
        affectiveNodeType: 'astro_state',
        allowToneModulation: ap.allowToneModulation,
        allowGraphOrderingInfluence: ap.allowGraphOrderingInfluence,
        rawAstroState: rawState ?? null,
      },
    });

    // ── Item 2: emotion_tag node (only when mood label is available) ──────────
    const moodLabel = rawState?.mood_label;
    if (moodLabel && typeof moodLabel === 'string' && moodLabel.trim().length > 0) {
      const moodContent = ap.requireLabeling
        ? `${AFFECTIVE_LABEL_PREFIX}Current mood: ${moodLabel.trim()}`
        : `Current mood: ${moodLabel.trim()}`;

      items.push({
        content: moodContent,
        selectionClass: 'graph_context',
        sourceType: 'emotion_tag',
        sourceKey: `emotion_tag:${moodLabel.trim().toLowerCase().replace(/\s+/g, '_')}`,
        title: `Mood: ${moodLabel.trim()}`,
        score: clampedWeight * 0.8,   // emotion_tag items rank slightly below astro_state
        graphEdgeType: 'modulates',
        graphEdgeTrust: 'session_only',
        metadata: {
          affective: true,
          affectiveNodeType: 'emotion_tag',
          moodLabel: moodLabel.trim(),
          emotionalVector: rawState?.emotional_vector ?? null,
        },
      });
    }

    return items;
  }

  /**
   * Produce a safe, concise summary from the raw astro state text.
   *
   * Limits output to the first 400 characters of the [ASTRO STATE] block to
   * prevent token-budget exhaustion from a verbose engine response.
   * Strips the leading "[ASTRO STATE]" marker if present.
   */
  private _summariseAstroText(stateText: string): string {
    const cleaned = stateText.replace(/^\[ASTRO STATE\][:\s]*/i, '').trim();
    return cleaned.length > 400 ? cleaned.slice(0, 400) + '…' : cleaned;
  }
}
