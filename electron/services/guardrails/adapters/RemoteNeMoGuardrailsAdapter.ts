/**
 * RemoteNeMoGuardrailsAdapter.ts
 *
 * Adapter for NVIDIA NeMo Guardrails running as a remote microservice.
 *
 * Engine: NeMo Guardrails server (https://github.com/NVIDIA/NeMo-Guardrails)
 *
 * Integration seam:
 *   NeMo Guardrails supports standalone microservice deployment where it sits
 *   between the application and the LLM. This adapter communicates with the
 *   NeMo server via its REST API using the configured endpointUrl and railSet.
 *
 *   The NeMo server can be started with:
 *     nemoguardrails server --port 8000 --config-path ./config
 *
 *   This adapter sends the content to the NeMo server for rail evaluation
 *   and maps the response to a normalized GuardrailValidationResult.
 *
 *   Expected endpoint behavior:
 *     POST <endpointUrl>/v1/rails/check
 *     Body: { rail_set: string, content: string, role: 'input'|'output'|'both' }
 *     Response: { allowed: bool, reason?: string, rail?: string,
 *                 metadata?: Record<string, unknown> }
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

/** Expected response from the remote NeMo Guardrails server. */
interface RemoteNeMoResponse {
    allowed: boolean;
    reason?: string;
    rail?: string;
    metadata?: Record<string, unknown>;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * RemoteNeMoGuardrailsAdapter
 *
 * Validates content using a remote NeMo Guardrails microservice.
 * The rail set (Colang config name) and endpoint are specified in the binding.
 * Supports configurable timeout and failOpen/failClosed for network failures.
 */
export class RemoteNeMoGuardrailsAdapter implements IGuardrailAdapter {
    readonly providerKind = 'remote_nemo_guardrails';

    async execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult> {
        const start = Date.now();

        if (!binding.endpointUrl) {
            return makeErrorResult(
                binding,
                new Error('RemoteNeMoGuardrailsAdapter: endpointUrl is required'),
                0,
            );
        }

        try {
            const content = typeof request.content === 'string'
                ? request.content
                : JSON.stringify(request.content);

            const railSet = binding.railSet ?? 'default';
            const timeoutMs = binding.timeoutMs ?? 8000;

            const raw = await this._callNeMoServer(
                binding.endpointUrl,
                {
                    rail_set: railSet,
                    content,
                    role: request.contentRole ?? 'both',
                },
                timeoutMs,
            );

            const durationMs = Date.now() - start;

            if (raw.allowed) {
                const evidence: GuardrailEvidence[] = [{
                    kind: 'nemo_remote_pass',
                    description: `Remote NeMo rail '${railSet}' allowed the content`,
                    raw: raw.metadata,
                }];
                return makePassResult(binding, durationMs, evidence);
            }

            const violations: GuardrailViolation[] = [{
                ruleId: `nemo_remote:${railSet}:${raw.rail ?? 'rail'}`,
                message: raw.reason ?? `Remote NeMo rail '${railSet}' blocked the content`,
            }];
            const evidence: GuardrailEvidence[] = [{
                kind: 'nemo_remote_block',
                description: `Remote NeMo rail '${railSet}' blocked content`,
                raw: raw.metadata,
            }];
            return makeViolationResult(binding, violations, durationMs, evidence);

        } catch (err) {
            return makeErrorResult(binding, err, Date.now() - start);
        }
    }

    /**
     * POST a rail check request to the remote NeMo Guardrails server.
     *
     * Uses AbortController for timeout support (requires Node.js 18+ / Electron).
     */
    private async _callNeMoServer(
        baseUrl: string,
        body: Record<string, unknown>,
        timeoutMs: number,
    ): Promise<RemoteNeMoResponse> {
        const url = `${baseUrl.replace(/\/$/, '')}/v1/rails/check`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!res.ok) {
                throw new Error(`NeMo Guardrails remote server returned HTTP ${res.status}: ${res.statusText}`);
            }

            return await res.json() as RemoteNeMoResponse;
        } finally {
            clearTimeout(timer);
        }
    }
}

/** Shared singleton. */
export const remoteNeMoGuardrailsAdapter = new RemoteNeMoGuardrailsAdapter();
