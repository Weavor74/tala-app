/**
 * LocalGuardrailsAIAdapter.ts
 *
 * Adapter for GuardrailsAI validators running locally via a Python subprocess.
 *
 * Engine: GuardrailsAI (https://guardrailsai.com/)
 *
 * Integration seam:
 *   In a live deployment this adapter spawns a short-lived Python subprocess
 *   using the configured `validatorName` and `validatorArgs` from the binding.
 *   The subprocess loads `guardrails-ai`, instantiates the named Validator, and
 *   validates the supplied content string, returning a JSON result on stdout.
 *
 *   Current status: subprocess integration is defined as a future-safe boundary.
 *   The adapter skeleton is fully wired (config, error handling, failOpen/Closed,
 *   result normalization) and the execute() method returns a deterministic stub
 *   result so callers can integrate without a live Python environment.
 *
 *   To activate: replace the `_runGuardrailsValidator` method body with a real
 *   `child_process.spawn` call that writes JSON to stdout and reads it back.
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

/** Raw result produced by a GuardrailsAI Validator subprocess call. */
interface RawGuardrailsAIResult {
    passed: boolean;
    output?: string;
    error_message?: string;
    fixed_value?: string;
    validator_name: string;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * LocalGuardrailsAIAdapter
 *
 * Validates content using a GuardrailsAI Validator class running locally.
 * One validator class per binding (e.g. "ToxicLanguage", "DetectPII").
 */
export class LocalGuardrailsAIAdapter implements IGuardrailAdapter {
    readonly providerKind = 'local_guardrails_ai';

    async execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult> {
        const start = Date.now();
        try {
            const content = typeof request.content === 'string'
                ? request.content
                : JSON.stringify(request.content);

            const validatorName = binding.validatorName ?? 'UnknownValidator';
            const raw = await this._runGuardrailsValidator(
                validatorName,
                binding.validatorArgs ?? {},
                content,
                binding.timeoutMs ?? 10000,
            );

            const durationMs = Date.now() - start;

            if (raw.passed) {
                const evidence: GuardrailEvidence[] = [{
                    kind: 'guardrails_ai_pass',
                    description: `Validator '${validatorName}' passed`,
                }];
                return makePassResult(binding, durationMs, evidence);
            }

            const violations: GuardrailViolation[] = [{
                ruleId: `guardrails_ai:${validatorName}`,
                message: raw.error_message ?? `Validator '${validatorName}' failed`,
                fixedValue: raw.fixed_value,
            }];
            const evidence: GuardrailEvidence[] = [{
                kind: 'guardrails_ai_fail',
                description: `Validator '${validatorName}' detected a violation`,
                raw: raw as unknown as Record<string, unknown>,
            }];
            return makeViolationResult(binding, violations, durationMs, evidence);

        } catch (err) {
            return makeErrorResult(binding, err, Date.now() - start);
        }
    }

    /**
     * Invoke a GuardrailsAI validator subprocess and return its raw result.
     *
     * Integration boundary: replace this stub with a real child_process.spawn
     * call that runs:
     *   python -c "
     *     from guardrails.hub import <validatorName>
     *     import json, sys
     *     v = <validatorName>(**args)
     *     result = v.validate(content, {})
     *     print(json.dumps({'passed': result.__class__.__name__ == 'PassResult', ...}))
     *   "
     *
     * For now returns a pass result so the adapter is safe to wire without
     * a live Python environment.
     */
    private async _runGuardrailsValidator(
        validatorName: string,
        _args: Record<string, unknown>,
        _content: string,
        _timeoutMs: number,
    ): Promise<RawGuardrailsAIResult> {
        // Stub: always passes until subprocess integration is activated.
        return {
            passed: true,
            validator_name: validatorName,
        };
    }
}

/** Shared singleton. */
export const localGuardrailsAIAdapter = new LocalGuardrailsAIAdapter();
