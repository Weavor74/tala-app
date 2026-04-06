/**
 * RemoteGuardrailsServiceAdapter.ts
 *
 * Adapter for a hosted/remote Guardrails REST validation service.
 *
 * Engine target: any HTTP endpoint that accepts a validation request and
 * returns a structured pass/fail response (e.g. a cloud-hosted guardrails
 * microservice or a custom Guardrails AI server instance).
 *
 * Integration seam:
 *   Sends content + context to the configured `endpointUrl` via HTTP POST.
 *   The binding's `timeoutMs` governs the request deadline.
 *   The adapter handles failOpen / failClosed resolution if the endpoint is
 *   unreachable or returns an error.
 *
 *   Expected request body sent to the remote service:
 *     { content, executionMode, executionOrigin, executionType, actionKind,
 *       validatorName?, validatorArgs? }
 *
 *   Expected response body from the remote service:
 *     { passed: bool, violations?: [{ruleId, message, severity?, fixedValue?}],
 *       warnings?: string[], evidence?: [...] }
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

/** Expected response shape from the remote guardrails service. */
interface RemoteGuardrailsResponse {
    passed: boolean;
    violations?: Array<{
        ruleId: string;
        message: string;
        severity?: string;
        location?: string;
        fixedValue?: string;
    }>;
    warnings?: string[];
    evidence?: Array<{
        kind: string;
        description: string;
        score?: number;
        raw?: Record<string, unknown>;
    }>;
    error?: string;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * RemoteGuardrailsServiceAdapter
 *
 * Validates content by forwarding it to a remote Guardrails validation endpoint.
 * Supports configurable timeout and failOpen/failClosed semantics for network
 * failures and non-200 responses.
 */
export class RemoteGuardrailsServiceAdapter implements IGuardrailAdapter {
    readonly providerKind = 'remote_guardrails_service';

    async execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult> {
        const start = Date.now();

        if (!binding.endpointUrl) {
            return makeErrorResult(
                binding,
                new Error('RemoteGuardrailsServiceAdapter: endpointUrl is required'),
                0,
            );
        }

        try {
            const response = await this._post(
                binding.endpointUrl,
                {
                    content: request.content,
                    executionMode: request.executionMode,
                    executionOrigin: request.executionOrigin,
                    executionType: request.executionType,
                    actionKind: request.actionKind,
                    validatorName: binding.validatorName,
                    validatorArgs: binding.validatorArgs,
                },
                binding.timeoutMs ?? 5000,
            );

            const durationMs = Date.now() - start;

            if (response.passed) {
                const evidence: GuardrailEvidence[] = (response.evidence ?? []).map(e => ({
                    kind: e.kind,
                    description: e.description,
                    score: e.score,
                    raw: e.raw,
                }));
                return makePassResult(binding, durationMs, evidence, response.warnings ?? []);
            }

            const violations: GuardrailViolation[] = (response.violations ?? []).map(v => ({
                ruleId: v.ruleId,
                message: v.message,
                severity: v.severity,
                location: v.location,
                fixedValue: v.fixedValue,
            }));
            const evidence: GuardrailEvidence[] = (response.evidence ?? []).map(e => ({
                kind: e.kind,
                description: e.description,
                score: e.score,
                raw: e.raw,
            }));
            return makeViolationResult(
                binding,
                violations,
                durationMs,
                evidence,
                response.warnings ?? [],
            );

        } catch (err) {
            return makeErrorResult(binding, err, Date.now() - start);
        }
    }

    /**
     * POST content to the remote guardrails endpoint with timeout support.
     *
     * Integration boundary: this uses the global fetch API (available in
     * Node.js 18+ and Electron). For older environments, use node-fetch.
     *
     * The AbortController handles the configured timeout.
     */
    private async _post(
        url: string,
        body: Record<string, unknown>,
        timeoutMs: number,
    ): Promise<RemoteGuardrailsResponse> {
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
                throw new Error(`Remote guardrails service returned HTTP ${res.status}: ${res.statusText}`);
            }

            const data = await res.json() as RemoteGuardrailsResponse;
            return data;
        } finally {
            clearTimeout(timer);
        }
    }
}

/** Shared singleton. */
export const remoteGuardrailsServiceAdapter = new RemoteGuardrailsServiceAdapter();
