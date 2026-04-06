/**
 * RemoteOPAAdapter.ts
 *
 * Adapter for Open Policy Agent (OPA) running as a remote policy server.
 *
 * Engine: Open Policy Agent REST API (https://www.openpolicyagent.org/docs/latest/rest-api/)
 *
 * Integration seam:
 *   Sends a structured input document to a remote OPA server's data API
 *   endpoint and interprets the Rego rule result as allow/deny.
 *
 *   OPA REST API format:
 *     POST <endpointUrl>/v1/data/<policyModule>/<ruleName>
 *     Body: { input: { ... } }
 *     Response: { result: bool | object, decision_id?: string }
 *
 *   Binding configuration:
 *     endpointUrl   — base URL of the remote OPA server
 *     policyModule  — policy package path (e.g. "policy/guardrails")
 *     ruleName      — rule to evaluate (e.g. "allow" or "deny")
 *
 *   The full execution context is forwarded as OPA input fields so Rego
 *   policies can make context-sensitive decisions.
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

/** Raw OPA REST API response. */
interface OPARestResponse {
    result: boolean | Record<string, unknown> | null;
    decision_id?: string;
}

/** Normalized OPA decision after parsing. */
interface OPADecision {
    allowed: boolean;
    reason?: string;
    metadata?: Record<string, unknown>;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * RemoteOPAAdapter
 *
 * Evaluates structured input against a remote OPA Rego policy.
 * The policy module path and rule name come from the binding configuration.
 * The full execution context is forwarded as part of the OPA input document.
 */
export class RemoteOPAAdapter implements IGuardrailAdapter {
    readonly providerKind = 'remote_opa';

    async execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult> {
        const start = Date.now();

        if (!binding.endpointUrl) {
            return makeErrorResult(
                binding,
                new Error('RemoteOPAAdapter: endpointUrl is required'),
                0,
            );
        }

        try {
            const opaInput = this._buildOPAInput(request);
            const policyModule = binding.policyModule ?? 'policy/guardrails';
            const ruleName = binding.ruleName ?? 'allow';
            const timeoutMs = binding.timeoutMs ?? 5000;

            const decision = await this._callOPA(
                binding.endpointUrl,
                policyModule,
                ruleName,
                opaInput,
                timeoutMs,
            );

            const durationMs = Date.now() - start;

            if (decision.allowed) {
                const evidence: GuardrailEvidence[] = [{
                    kind: 'opa_remote_allow',
                    description: `Remote OPA rule '${policyModule}/${ruleName}' allowed`,
                    raw: decision.metadata,
                }];
                return makePassResult(binding, durationMs, evidence);
            }

            const violations: GuardrailViolation[] = [{
                ruleId: `opa_remote:${policyModule}/${ruleName}`,
                message: decision.reason ?? `Remote OPA policy '${policyModule}/${ruleName}' denied`,
            }];
            const evidence: GuardrailEvidence[] = [{
                kind: 'opa_remote_deny',
                description: `Remote OPA rule '${policyModule}/${ruleName}' denied`,
                raw: decision.metadata,
            }];
            return makeViolationResult(binding, violations, durationMs, evidence);

        } catch (err) {
            return makeErrorResult(binding, err, Date.now() - start);
        }
    }

    /**
     * Build the OPA input document from the validation request.
     * Identical to LocalOPAAdapter._buildOPAInput so Rego policies work with both.
     */
    private _buildOPAInput(request: GuardrailValidationRequest): Record<string, unknown> {
        const base: Record<string, unknown> = {
            executionMode: request.executionMode,
            executionOrigin: request.executionOrigin,
            executionType: request.executionType,
            executionId: request.executionId,
            actionKind: request.actionKind,
            targetSubsystem: request.targetSubsystem,
            metadata: request.metadata,
        };
        if (typeof request.content === 'string') {
            base.text = request.content;
        } else {
            base.content = request.content;
        }
        return base;
    }

    /**
     * POST the input document to the remote OPA data API and return a decision.
     *
     * OPA REST API path: POST /v1/data/<policyModule>/<ruleName>
     * With input: Body = { input: opaInput }
     */
    private async _callOPA(
        baseUrl: string,
        policyModule: string,
        ruleName: string,
        input: Record<string, unknown>,
        timeoutMs: number,
    ): Promise<OPADecision> {
        // Normalize the path: replace dots with slashes for OPA package paths
        const path = policyModule.replace(/\./g, '/');
        const url = `${baseUrl.replace(/\/$/, '')}/v1/data/${path}/${ruleName}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input }),
                signal: controller.signal,
            });

            if (!res.ok) {
                throw new Error(`Remote OPA server returned HTTP ${res.status}: ${res.statusText}`);
            }

            const data = await res.json() as OPARestResponse;
            return this._parseOPAResponse(data);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Parse a raw OPA API response into a normalized decision.
     * Exported for unit testing.
     */
    _parseOPAResponse(raw: OPARestResponse): OPADecision {
        const { result } = raw;
        if (result === null || result === undefined) {
            // Undefined result usually means policy was not found — allow to avoid false denials
            return { allowed: true, reason: 'OPA returned undefined result (policy not found)' };
        }
        if (typeof result === 'boolean') {
            return { allowed: result };
        }
        if (typeof result === 'object') {
            if ('allow' in result) {
                return {
                    allowed: !!result['allow'],
                    reason: result['reason'] as string | undefined,
                    metadata: result,
                };
            }
            if ('deny' in result) {
                return {
                    allowed: !result['deny'],
                    reason: result['reason'] as string | undefined,
                    metadata: result,
                };
            }
        }
        return { allowed: true, reason: 'OPA result shape unrecognized — defaulting to allow' };
    }
}

/** Shared singleton. */
export const remoteOPAAdapter = new RemoteOPAAdapter();
