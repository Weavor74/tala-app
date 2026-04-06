/**
 * LocalOPAAdapter.ts
 *
 * Adapter for Open Policy Agent (OPA) running locally.
 *
 * Engine: Open Policy Agent (https://www.openpolicyagent.org/)
 *
 * Integration seam:
 *   OPA evaluates Rego policies against a structured JSON input document and
 *   returns a structured allow/deny decision. The local adapter calls a locally-
 *   running OPA server (default: http://localhost:8181).
 *
 *   The OPA server can be started with:
 *     opa run --server --addr :8181
 *   Or embedded via the Node.js OPA wasm module.
 *
 *   Binding configuration:
 *     policyModule — OPA policy package path (e.g. "data/policy/guardrails")
 *     ruleName     — Rego rule to evaluate (e.g. "allow" or "deny")
 *     endpointUrl  — OPA REST API endpoint (optional, defaults to localhost:8181)
 *
 *   The content field in the request is the "input" document sent to Rego.
 *   If content is a string, it is wrapped as { text: content }.
 *   Execution context (mode, origin, etc.) is also injected into the input
 *   document so Rego policies can make context-aware decisions.
 *
 *   Current status: HTTP call is a future-safe boundary stub.
 *
 *   To activate: replace `_evalWithOPA` with a real fetch to
 *   POST <endpoint>/v1/data/<policyModule>/<ruleName>
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

/** OPA REST API response shape. */
interface OPADecisionResponse {
    result: boolean | Record<string, unknown>;
    decision_id?: string;
}

/** Structured OPA decision after normalization. */
interface OPADecision {
    /** True when OPA's rule evaluates to a truthy allow / false deny result. */
    allowed: boolean;
    /** Machine-readable reason if the policy provides one. */
    reason?: string;
    /** Additional details from the OPA response. */
    metadata?: Record<string, unknown>;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * LocalOPAAdapter
 *
 * Evaluates structured input against an OPA Rego policy running locally.
 * The policy module path and rule name come from the binding configuration.
 * The full execution context is forwarded as part of the OPA input document.
 */
export class LocalOPAAdapter implements IGuardrailAdapter {
    readonly providerKind = 'local_opa';

    /** Default local OPA REST API endpoint. */
    static readonly DEFAULT_ENDPOINT = 'http://localhost:8181';

    async execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult> {
        const start = Date.now();
        try {
            // Build the OPA input document from request context + content
            const opaInput = this._buildOPAInput(request);
            const policyModule = binding.policyModule ?? 'data/policy/guardrails';
            const ruleName = binding.ruleName ?? 'allow';
            const endpoint = binding.endpointUrl ?? LocalOPAAdapter.DEFAULT_ENDPOINT;
            const timeoutMs = binding.timeoutMs ?? 5000;

            const decision = await this._evalWithOPA(
                opaInput,
                policyModule,
                ruleName,
                endpoint,
                timeoutMs,
            );

            const durationMs = Date.now() - start;

            if (decision.allowed) {
                const evidence: GuardrailEvidence[] = [{
                    kind: 'opa_allow',
                    description: `OPA rule '${policyModule}/${ruleName}' allowed`,
                    raw: decision.metadata,
                }];
                return makePassResult(binding, durationMs, evidence);
            }

            const violations: GuardrailViolation[] = [{
                ruleId: `opa:${policyModule}/${ruleName}`,
                message: decision.reason ?? `OPA policy '${policyModule}/${ruleName}' denied the action`,
            }];
            const evidence: GuardrailEvidence[] = [{
                kind: 'opa_deny',
                description: `OPA rule '${policyModule}/${ruleName}' denied`,
                raw: decision.metadata,
            }];
            return makeViolationResult(binding, violations, durationMs, evidence);

        } catch (err) {
            return makeErrorResult(binding, err, Date.now() - start);
        }
    }

    /**
     * Build the OPA input document by merging request context and content.
     *
     * Rego policies can reference:
     *   input.text              — string content (when content is a string)
     *   input.content           — structured content (when content is an object)
     *   input.executionMode     — active agent mode
     *   input.executionOrigin   — request origin
     *   input.executionType     — logical execution type
     *   input.actionKind        — side-effect action kind
     *   input.targetSubsystem   — target subsystem
     *   input.metadata          — arbitrary caller metadata
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
     * Call the OPA REST API and return a normalized policy decision.
     *
     * Integration boundary: replace this stub with a real fetch call:
     *   POST <endpoint>/v1/data/<policyModule>/<ruleName>
     *   Body: { input: opaInput }
     *   Response: { result: bool | object }
     *
     * The `result` field is interpreted as:
     *   - boolean true  → allowed
     *   - boolean false → denied
     *   - object with `allow` key → allowed when allow === true
     *   - object with `deny` key  → denied when deny === true
     *
     * The stub always returns allowed=true so the adapter is safe to wire
     * without a running OPA server.
     */
    private async _evalWithOPA(
        _input: Record<string, unknown>,
        _policyModule: string,
        _ruleName: string,
        _endpoint: string,
        _timeoutMs: number,
    ): Promise<OPADecision> {
        // Stub: always allows until HTTP integration is activated.
        return { allowed: true };
    }

    /**
     * Parse a raw OPA API response into a normalized OPADecision.
     * Exported for unit testing.
     */
    _parseOPAResponse(raw: OPADecisionResponse): OPADecision {
        const { result } = raw;
        if (typeof result === 'boolean') {
            return { allowed: result };
        }
        if (typeof result === 'object' && result !== null) {
            // Common Rego patterns: { allow: true } or { deny: false }
            if ('allow' in result) {
                return {
                    allowed: !!result['allow'],
                    reason: result['reason'] as string | undefined,
                    metadata: result as Record<string, unknown>,
                };
            }
            if ('deny' in result) {
                return {
                    allowed: !result['deny'],
                    reason: result['reason'] as string | undefined,
                    metadata: result as Record<string, unknown>,
                };
            }
        }
        // Unknown result shape → allow (fail open on parse ambiguity)
        return { allowed: true, reason: 'OPA result shape unrecognized — defaulting to allow' };
    }
}

/** Shared singleton. */
export const localOPAAdapter = new LocalOPAAdapter();
