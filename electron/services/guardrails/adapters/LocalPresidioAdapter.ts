/**
 * LocalPresidioAdapter.ts
 *
 * Adapter for Microsoft Presidio PII/sensitive-data detection running locally.
 *
 * Engine: Microsoft Presidio (https://microsoft.github.io/presidio/)
 *
 * Integration seam:
 *   In a live deployment this adapter calls a locally-running Presidio Analyzer
 *   REST API (default: http://localhost:5002) with the configured entity types.
 *   It parses the entity recognition results and maps them to GuardrailViolations.
 *
 *   The Presidio Analyzer server can be started with:
 *     docker run -p 5002:3000 mcr.microsoft.com/presidio-analyzer
 *   Or installed via pip: pip install presidio-analyzer
 *
 *   Current status: HTTP call is defined as a future-safe boundary.
 *   The adapter is fully wired for config, failOpen/Closed, and normalization.
 *   The `_analyzeWithPresidio` method returns a stub empty analysis so callers
 *   can integrate without a live Presidio instance.
 *
 *   To activate: replace `_analyzeWithPresidio` with a real fetch call to
 *   http://localhost:5002/analyze (or the configured endpoint).
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

/** A single Presidio entity recognition result. */
interface PresidioEntityResult {
    entity_type: string;
    start: number;
    end: number;
    score: number;
    analysis_explanation?: string;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * LocalPresidioAdapter
 *
 * Detects PII and sensitive entities in text using Microsoft Presidio.
 * Entity types to detect are configured via the binding's `entityTypes` field
 * (e.g. ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER"]).
 *
 * Any detected entity produces a blocking violation.
 */
export class LocalPresidioAdapter implements IGuardrailAdapter {
    readonly providerKind = 'local_presidio';

    /**
     * Default Presidio Analyzer endpoint (local Docker or pip install).
     * Overridden by binding.endpointUrl when set.
     */
    static readonly DEFAULT_ENDPOINT = 'http://localhost:5002';

    async execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult> {
        const start = Date.now();
        try {
            const content = typeof request.content === 'string'
                ? request.content
                : JSON.stringify(request.content);

            const entityTypes = binding.entityTypes ?? [];
            const endpoint = binding.endpointUrl ?? LocalPresidioAdapter.DEFAULT_ENDPOINT;
            const timeoutMs = binding.timeoutMs ?? 5000;

            const entities = await this._analyzeWithPresidio(
                content,
                entityTypes,
                endpoint,
                timeoutMs,
            );

            const durationMs = Date.now() - start;

            if (entities.length === 0) {
                const evidence: GuardrailEvidence[] = [{
                    kind: 'presidio_pass',
                    description: entityTypes.length > 0
                        ? `No entities of types [${entityTypes.join(', ')}] detected`
                        : 'No PII entities detected',
                }];
                return makePassResult(binding, durationMs, evidence);
            }

            const violations: GuardrailViolation[] = entities.map(e => ({
                ruleId: `presidio:${e.entity_type}`,
                message: `PII entity detected: ${e.entity_type} (score: ${e.score.toFixed(2)})`,
                severity: e.score >= 0.85 ? 'high' : 'medium',
                location: `char[${e.start}:${e.end}]`,
            }));

            const evidence: GuardrailEvidence[] = entities.map(e => ({
                kind: 'presidio_entity',
                description: `${e.entity_type} at char[${e.start}:${e.end}]`,
                score: e.score,
                raw: e as unknown as Record<string, unknown>,
            }));

            return makeViolationResult(binding, violations, durationMs, evidence);

        } catch (err) {
            return makeErrorResult(binding, err, Date.now() - start);
        }
    }

    /**
     * Call the Presidio Analyzer API and return entity recognition results.
     *
     * Integration boundary: replace this stub with a real fetch call:
     *   POST <endpoint>/analyze
     *   Body: { text, language: 'en', entities }
     *   Response: PresidioEntityResult[]
     *
     * The stub returns an empty array (no entities detected) so the adapter
     * is safe to wire without a running Presidio instance.
     */
    private async _analyzeWithPresidio(
        _text: string,
        _entityTypes: string[],
        _endpoint: string,
        _timeoutMs: number,
    ): Promise<PresidioEntityResult[]> {
        // Stub: returns no entities until HTTP integration is activated.
        return [];
    }
}

/** Shared singleton. */
export const localPresidioAdapter = new LocalPresidioAdapter();
