/**
 * MemoryIntegrityPolicy.ts — Memory Integrity Policy evaluator
 *
 * Evaluates the real runtime state of every memory subsystem component and
 * produces a MemoryHealthStatus.  This is a pure evaluation layer — it does
 * not mutate state, start/stop services, or perform IO.
 *
 * Architecture
 * ────────────
 * Inputs (all optional, gracefully handled when absent):
 *   - canonicalReady     : boolean  — canonical Postgres store is reachable
 *   - mem0Ready          : boolean  — mem0 MCP client is connected
 *   - resolvedMode       : MemoryRuntimeMode | undefined — current runtime mode
 *   - extractionEnabled  : boolean  — extraction provider was resolved
 *   - embeddingsEnabled  : boolean  — embeddings provider was resolved
 *   - graphAvailable     : boolean  — graph projection service is reachable
 *   - ragAvailable       : boolean  — RAG interaction log is reachable
 *   - integrityMode      : MemoryIntegrityMode — strictness level (default: balanced)
 *
 * State derivation rules
 * ──────────────────────
 * healthy   canonical + extraction + embeddings + mem0 + no major failures
 * reduced   canonical + at least one auxiliary capability missing
 * degraded  canonical + memory substantially impaired (mem0 down / canonical-only)
 * critical  canonical unavailable
 * disabled  integrityMode = strict AND required capabilities absent
 *           OR hard_disable explicitly passed
 */

import type { MemoryRuntimeMode } from '../../../shared/memory/MemoryRuntimeResolution';
import type {
    MemoryCapabilityState,
    MemoryFailureReason,
    MemoryHealthStatus,
    MemoryIntegrityMode,
    MemorySubsystemState,
} from '../../../shared/memory/MemoryHealthStatus';

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface MemoryIntegrityPolicyInputs {
    /** True when the canonical Postgres store is reachable and accepting writes. */
    canonicalReady: boolean;
    /** True when the mem0 MCP client is connected and responding. */
    mem0Ready: boolean;
    /**
     * Resolved memory runtime mode produced by MemoryProviderResolver.
     * Undefined when the resolver has not run yet (e.g. during early startup).
     */
    resolvedMode?: MemoryRuntimeMode;
    /** True when an extraction (LLM) provider was resolved. */
    extractionEnabled: boolean;
    /** True when an embeddings provider was resolved. */
    embeddingsEnabled: boolean;
    /** True when the graph projection service is considered available. */
    graphAvailable: boolean;
    /** True when the RAG interaction log is available. */
    ragAvailable: boolean;
    /**
     * Policy strictness mode.  Defaults to 'balanced' when omitted.
     * Pass 'strict' for Phase 4+ autonomy contexts.
     */
    integrityMode?: MemoryIntegrityMode;
    /**
     * When true, the policy unconditionally returns state = disabled regardless
     * of capability availability.  Used for intentional runtime disabling.
     */
    forceDisable?: boolean;
}

// ---------------------------------------------------------------------------
// MemoryIntegrityPolicy
// ---------------------------------------------------------------------------

export class MemoryIntegrityPolicy {
    /**
     * Evaluate memory system state from the provided inputs and return a
     * fully populated MemoryHealthStatus.
     *
     * This method is pure: identical inputs always produce identical outputs.
     * It never throws — all edge-cases produce a valid (possibly critical/disabled)
     * MemoryHealthStatus.
     */
    static evaluate(inputs: MemoryIntegrityPolicyInputs): MemoryHealthStatus {
        const {
            canonicalReady,
            mem0Ready,
            resolvedMode,
            extractionEnabled,
            embeddingsEnabled,
            graphAvailable,
            ragAvailable,
            integrityMode = 'balanced',
            forceDisable = false,
        } = inputs;

        const evaluatedAt = new Date().toISOString();

        // ── Step 1: Force-disable shortcut ──────────────────────────────────
        if (forceDisable) {
            return {
                state: 'disabled',
                capabilities: {
                    canonical: false,
                    extraction: false,
                    embeddings: false,
                    mem0Runtime: false,
                    graphProjection: false,
                    ragLogging: false,
                },
                reasons: ['none'],
                mode: resolvedMode ?? 'unknown',
                hardDisabled: true,
                shouldTriggerRepair: false,
                shouldEscalate: false,
                summary: 'Memory subsystem intentionally disabled by policy.',
                evaluatedAt,
            };
        }

        // ── Step 2: Derive capability flags ─────────────────────────────────
        const capabilities: MemoryCapabilityState = {
            canonical: canonicalReady,
            extraction: extractionEnabled,
            embeddings: embeddingsEnabled,
            mem0Runtime: mem0Ready,
            graphProjection: graphAvailable,
            ragLogging: ragAvailable,
        };

        // ── Step 3: Collect failure reasons ─────────────────────────────────
        const reasons: MemoryFailureReason[] = [];

        if (!canonicalReady) reasons.push('canonical_unavailable');
        if (!mem0Ready) reasons.push('mem0_unavailable');
        if (!extractionEnabled) reasons.push('extraction_provider_unavailable');
        if (!embeddingsEnabled) reasons.push('embedding_provider_unavailable');
        if (!graphAvailable) reasons.push('graph_projection_unavailable');
        if (!ragAvailable) reasons.push('rag_logging_unavailable');

        // Detect canonical-only mode forced by missing extraction + embeddings
        if (canonicalReady && !extractionEnabled && !embeddingsEnabled && mem0Ready) {
            reasons.push('mem0_mode_canonical_only');
        }

        // ── Step 4: Derive runtime mode ──────────────────────────────────────
        const mode: MemoryHealthStatus['mode'] = resolvedMode ?? (
            extractionEnabled && embeddingsEnabled ? 'full_memory'
                : embeddingsEnabled ? 'canonical_plus_embeddings'
                    : canonicalReady ? 'canonical_only'
                        : 'unknown'
        );

        // ── Step 5: Derive state ─────────────────────────────────────────────
        const state = MemoryIntegrityPolicy._deriveState(
            canonicalReady,
            mem0Ready,
            extractionEnabled,
            embeddingsEnabled,
            graphAvailable,
            ragAvailable,
            mode,
            integrityMode,
        );

        // ── Step 6: Compute enforcement flags ───────────────────────────────
        const hardDisabled = MemoryIntegrityPolicy._isHardDisabled(state, integrityMode, capabilities);
        const shouldTriggerRepair = MemoryIntegrityPolicy._shouldTriggerRepair(state, reasons);
        const shouldEscalate = state === 'critical' || (state === 'degraded' && integrityMode !== 'lenient');

        // ── Step 7: Build human-readable summary ─────────────────────────────
        const summary = MemoryIntegrityPolicy._buildSummary(state, reasons, mode, hardDisabled);

        return {
            state,
            capabilities,
            reasons: reasons.length === 0 ? ['none'] : reasons,
            mode,
            hardDisabled,
            shouldTriggerRepair,
            shouldEscalate,
            summary,
            evaluatedAt,
        };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private static _deriveState(
        canonicalReady: boolean,
        mem0Ready: boolean,
        extractionEnabled: boolean,
        embeddingsEnabled: boolean,
        graphAvailable: boolean,
        ragAvailable: boolean,
        mode: MemoryHealthStatus['mode'],
        integrityMode: MemoryIntegrityMode,
    ): MemorySubsystemState {
        // critical: canonical store down
        if (!canonicalReady) {
            return 'critical';
        }

        // strict mode: all core capabilities required
        if (integrityMode === 'strict') {
            if (!extractionEnabled || !embeddingsEnabled || !mem0Ready) {
                return 'disabled';
            }
        }

        // healthy: canonical + extraction + embeddings + mem0 all up
        if (extractionEnabled && embeddingsEnabled && mem0Ready) {
            // Minor auxiliary failures (graph/rag) are still "healthy" from a
            // cognition standpoint; they are reflected in capability flags.
            return 'healthy';
        }

        // degraded: canonical only — substantially impaired (no extraction AND no embeddings)
        // or mem0 runtime is completely down while canonical is up
        if (!mem0Ready && !extractionEnabled && !embeddingsEnabled) {
            return 'degraded';
        }
        if (mode === 'canonical_only') {
            return 'degraded';
        }

        // reduced: canonical up + at least one auxiliary capability missing
        return 'reduced';
    }

    private static _isHardDisabled(
        state: MemorySubsystemState,
        integrityMode: MemoryIntegrityMode,
        capabilities: MemoryCapabilityState,
    ): boolean {
        if (state === 'disabled') return true;
        if (state === 'critical') return true;
        // In strict mode, degraded triggers hard-disable as well
        if (integrityMode === 'strict' && state === 'degraded') return true;
        return false;
    }

    private static _shouldTriggerRepair(
        state: MemorySubsystemState,
        reasons: MemoryFailureReason[],
    ): boolean {
        if (state === 'critical' || state === 'degraded') return true;
        // Also trigger repair if graph projection or rag logging are unavailable
        if (reasons.includes('graph_projection_unavailable')) return true;
        if (reasons.includes('rag_logging_unavailable')) return true;
        return false;
    }

    private static _buildSummary(
        state: MemorySubsystemState,
        reasons: MemoryFailureReason[],
        mode: MemoryHealthStatus['mode'],
        hardDisabled: boolean,
    ): string {
        const prefix = `Memory[${state.toUpperCase()}]`;
        if (state === 'healthy') {
            return `${prefix} All capabilities available. Mode: ${mode}.`;
        }
        if (state === 'disabled') {
            return `${prefix} Memory subsystem disabled by policy.`;
        }
        const filteredReasons = reasons.filter(r => r !== 'none');
        const reasonStr = filteredReasons.length > 0
            ? filteredReasons.join(', ')
            : 'no specific reason recorded';
        const disabledNote = hardDisabled ? ' Hard-disable active.' : '';
        return `${prefix} Mode: ${mode}. Failures: ${reasonStr}.${disabledNote}`;
    }
}
