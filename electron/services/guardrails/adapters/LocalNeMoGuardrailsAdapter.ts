/**
 * LocalNeMoGuardrailsAdapter.ts
 *
 * Adapter for NVIDIA NeMo Guardrails running locally.
 *
 * Engine: NVIDIA NeMo Guardrails (https://github.com/NVIDIA/NeMo-Guardrails)
 *
 * Integration seam:
 *   NeMo Guardrails supports multiple rail types:
 *     - Input rails  — validate user input before it reaches the LLM
 *     - Output rails — validate LLM output before it reaches the user
 *     - Retrieval rails — validate RAG/retrieval results
 *     - Dialog rails  — steer conversation flow
 *
 *   In a live deployment this adapter calls a locally-running NeMo Guardrails
 *   server (nemoguardrails serve --port 8000) with the configured railSet.
 *   The server evaluates the content against the named Colang configuration
 *   and returns a policy decision.
 *
 *   NeMo can also run as a library (import nemoguardrails), but the server
 *   mode is preferred here because Tala runs Python tools as subprocesses.
 *
 *   Current status: HTTP call is a future-safe boundary stub.
 *   The `_evalWithNeMo` method returns a pass result until the server is wired.
 *
 *   To activate: replace `_evalWithNeMo` with a real fetch/POST to
 *   http://localhost:8000/v1/chat/completions or /rails/check.
 *
 * Node.js (electron/) only.
 */

import type { ValidatorBinding } from '../../../../shared/guardrails/guardrailPolicyTypes';
import type {
    IGuardrailAdapter,
    GuardrailValidationRequest,
    GuardrailValidationResult,
    GuardrailViolation,
    GuardrailEvidence,
} from '../types';
import { makeErrorResult, makePassResult, makeViolationResult } from '../types';

// ─── Engine-specific types (internal to this adapter) ────────────────────────

/** Raw result returned by a NeMo Guardrails rail evaluation. */
interface RawNeMoResult {
    allowed: boolean;
    reason?: string;
    rail?: string;
    metadata?: Record<string, unknown>;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * LocalNeMoGuardrailsAdapter
 *
 * Validates content using NVIDIA NeMo Guardrails running as a local server.
 * The rail set (Colang config name) is specified in the binding's `railSet`
 * field. Supports input, output, and retrieval rail evaluation.
 */
export class LocalNeMoGuardrailsAdapter implements IGuardrailAdapter {
    readonly providerKind = 'local_nemo_guardrails';

    /** Default local NeMo Guardrails server endpoint. */
    static readonly DEFAULT_ENDPOINT = 'http://localhost:8000';

    async execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult> {
        const start = Date.now();
        try {
            const content = typeof request.content === 'string'
                ? request.content
                : JSON.stringify(request.content);

            const railSet = binding.railSet ?? 'default';
            const endpoint = binding.endpointUrl ?? LocalNeMoGuardrailsAdapter.DEFAULT_ENDPOINT;
            const timeoutMs = binding.timeoutMs ?? 8000;

            const raw = await this._evalWithNeMo(
                content,
                railSet,
                request.contentRole ?? 'both',
                endpoint,
                timeoutMs,
            );

            const durationMs = Date.now() - start;

            if (raw.allowed) {
                const evidence: GuardrailEvidence[] = [{
                    kind: 'nemo_pass',
                    description: `Rail '${railSet}' allowed the content`,
                    raw: raw.metadata,
                }];
                return makePassResult(binding, durationMs, evidence);
            }

            const violations: GuardrailViolation[] = [{
                ruleId: `nemo:${railSet}:${raw.rail ?? 'rail'}`,
                message: raw.reason ?? `NeMo Guardrails rail '${railSet}' blocked the content`,
            }];
            const evidence: GuardrailEvidence[] = [{
                kind: 'nemo_block',
                description: `Rail '${railSet}' blocked content`,
                raw: raw.metadata,
            }];
            return makeViolationResult(binding, violations, durationMs, evidence);

        } catch (err) {
            return makeErrorResult(binding, err, Date.now() - start);
        }
    }

    /**
     * Evaluate content against a NeMo Guardrails rail set.
     *
     * Integration boundary: replace this stub with a real HTTP call to the
     * NeMo Guardrails server:
     *   POST <endpoint>/rails/check
     *   Body: { rail_set: railSet, content, role }
     *   Response: { allowed: bool, reason?: string, rail?: string }
     *
     * Alternatively, use the /v1/chat/completions endpoint and inspect the
     * response for blocked content markers in the NeMo output.
     *
     * The stub returns allowed=true so the adapter is safe to wire without
     * a running NeMo server.
     */
    private async _evalWithNeMo(
        _content: string,
        _railSet: string,
        _role: string,
        _endpoint: string,
        _timeoutMs: number,
    ): Promise<RawNeMoResult> {
        // Stub: always passes until server integration is activated.
        return { allowed: true };
    }
}

/** Shared singleton. */
export const localNeMoGuardrailsAdapter = new LocalNeMoGuardrailsAdapter();
