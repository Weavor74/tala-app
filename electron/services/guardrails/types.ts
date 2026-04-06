/**
 * electron/services/guardrails/types.ts
 *
 * Normalized validator request/result contracts for the Tala guardrail
 * execution layer.
 *
 * Architecture position:
 *   UI (authoring) → GuardrailPolicyConfig (shared/guardrails/) →
 *   ValidatorRegistry (resolves bindings) →
 *   Adapters (invoke engines) →
 *   GuardrailValidationResult (normalized outcome) →
 *   PolicyGate (enforcement decision)
 *
 * Design principles:
 *   - All adapter return values are normalized to GuardrailValidationResult.
 *   - No adapter-specific types leak beyond the adapter boundary.
 *   - Callers depend only on this contract — not on engine details.
 *   - failOpen / failClosed resolution is recorded in results, not enforced here.
 *   - Node.js (electron/) only. Not imported by renderer code.
 */

import type { ValidatorBinding, GuardrailScope } from '../../../shared/guardrails/guardrailPolicyTypes';

// ─── Validation request ───────────────────────────────────────────────────────

/**
 * GuardrailValidationRequest — input passed to every adapter via execute().
 *
 * Carries both the content to validate and the execution context so adapters
 * can make context-aware decisions (e.g. OPA can include mode in Rego input).
 */
export interface GuardrailValidationRequest {
    /** ID of the parent execution for correlation (e.g. chat turn ID). */
    executionId?: string;
    /** Logical type of the originating execution (e.g. 'chat_turn'). */
    executionType?: string;
    /** Subsystem that originated the request (e.g. 'ipc', 'autonomy_engine'). */
    executionOrigin?: string;
    /** Active interaction mode at time of request (e.g. 'rp', 'hybrid'). */
    executionMode?: string;
    /**
     * The primary content being validated.
     * For LLM I/O validators this is the text to inspect.
     * For OPA this is the structured fact object for Rego input.
     */
    content: string | Record<string, unknown>;
    /** Where the content came from in the data flow. */
    contentRole?: 'input' | 'output' | 'both';
    /** The subsystem that will act on the content (for scoping / audit). */
    targetSubsystem?: string;
    /** The side-effect action kind being gated (e.g. 'tool_invoke'). */
    actionKind?: string;
    /** Arbitrary additional context a caller wants to forward to adapters. */
    metadata?: Record<string, unknown>;
}

// ─── Validation result ────────────────────────────────────────────────────────

/**
 * A single matched violation reported by a validator.
 *
 * Validators produce zero or more violations per request.
 * An empty violations array means the content passed cleanly.
 */
export interface GuardrailViolation {
    /** Short machine-readable identifier for the violated rule or pattern. */
    ruleId: string;
    /** Human-readable explanation of the violation. */
    message: string;
    /** Severity of this specific violation (optional; engine may not report it). */
    severity?: string;
    /**
     * The span of text or the structured field that triggered the violation.
     * Absent when the engine does not support location reporting.
     */
    location?: string;
    /** The replacement / redacted value produced by fix/refrain actions. */
    fixedValue?: string;
}

/**
 * Structured evidence produced by a validator to support its decision.
 *
 * Evidence enriches the validation result with engine-specific detail
 * without leaking raw engine types to callers.
 */
export interface GuardrailEvidence {
    /** Short label describing this piece of evidence (e.g. 'entity_detected'). */
    kind: string;
    /** Human-readable description. */
    description: string;
    /** Confidence score in [0, 1] if the engine provides it. */
    score?: number;
    /** Raw structured payload from the engine, for logging/audit. */
    raw?: Record<string, unknown>;
}

/**
 * GuardrailValidationResult — normalized outcome of a single adapter execution.
 *
 * All adapters return exactly one of these per request, regardless of the
 * underlying engine. Callers and ValidatorRegistry aggregate across adapters
 * using only this type.
 */
export interface GuardrailValidationResult {
    /** ID of the ValidatorBinding that produced this result. */
    validatorId: string;
    /** Human-readable display name of the binding. */
    validatorName: string;
    /** Engine kind string (e.g. 'local_guardrails_ai'). */
    engineKind: string;
    /**
     * True when the validator ran to completion without error.
     * False when the adapter threw or the remote timed out.
     */
    success: boolean;
    /**
     * True when the content passed all checks (no blocking violations).
     * False when at least one violation is blocking.
     * Undefined if success is false (could not determine).
     */
    passed?: boolean;
    /**
     * True when the caller should deny the guarded action.
     *
     * This is the primary enforcement signal returned to PolicyGate.
     * Computed by the adapter based on violations + failOpen/failClosed.
     *
     * If success is false:
     *   failOpen  binding → shouldDeny = false (allow on failure)
     *   failClosed binding → shouldDeny = true  (deny on failure)
     */
    shouldDeny: boolean;
    /** Violations detected. Empty when passed=true. */
    violations: GuardrailViolation[];
    /** Structured evidence items supporting the decision. */
    evidence: GuardrailEvidence[];
    /** Warnings that are non-blocking but should be surfaced. */
    warnings: string[];
    /** Wall-clock time for this adapter's execution in ms. */
    durationMs: number;
    /** Error message if success=false. */
    error?: string;
    /** True when the result reflects failOpen resolution of a validator error. */
    resolvedByFailOpen?: boolean;
    /** True when the result reflects failClosed resolution of a validator error. */
    resolvedByFailClosed?: boolean;
}

// ─── Aggregated result ────────────────────────────────────────────────────────

/**
 * AggregatedValidationResult — combined outcome across all adapters invoked
 * for a single policy rule evaluation.
 *
 * ValidatorRegistry.runAll() returns this. PolicyGate reads shouldDenyOverall
 * to make its enforcement decision.
 */
export interface AggregatedValidationResult {
    /** True when ALL adapters executed successfully (success=true on each). */
    allSucceeded: boolean;
    /**
     * True when ANY adapter produced shouldDeny=true.
     * PolicyGate should block the action when this is true.
     */
    shouldDenyOverall: boolean;
    /** True when all adapters passed (no blocks, no errors). */
    overallPassed: boolean;
    /** Individual results in execution order (by priority, then insertion order). */
    results: GuardrailValidationResult[];
    /** Total wall-clock time across all adapters in ms. */
    totalDurationMs: number;
    /** All violations collected across all adapters. */
    allViolations: GuardrailViolation[];
    /** All warnings collected across all adapters. */
    allWarnings: string[];
}

// ─── Adapter interface ────────────────────────────────────────────────────────

/**
 * IGuardrailAdapter — the narrow contract every adapter must implement.
 *
 * Adapters are stateless value objects that wrap a single engine kind.
 * They receive a ValidatorBinding (config) and a GuardrailValidationRequest,
 * and return a normalised GuardrailValidationResult.
 *
 * Adapters must never throw. All errors must be caught and returned in the
 * result's error field with success=false. The failOpen/failClosed resolution
 * must be applied inside execute().
 */
export interface IGuardrailAdapter {
    /** The ValidatorProviderKind this adapter handles. */
    readonly providerKind: string;
    /**
     * Execute the validator described by `binding` against `request`.
     *
     * @param binding  The validator binding from GuardrailPolicyConfig.
     * @param request  The normalized validation request.
     * @returns        A normalized result. Never throws.
     */
    execute(
        binding: ValidatorBinding,
        request: GuardrailValidationRequest,
    ): Promise<GuardrailValidationResult>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a failed GuardrailValidationResult for use when an adapter catches
 * an unrecoverable error. Applies failOpen / failClosed semantics.
 *
 * @param binding    The binding that failed.
 * @param error      The caught error or message.
 * @param durationMs Wall-clock time before the failure.
 */
export function makeErrorResult(
    binding: ValidatorBinding,
    error: unknown,
    durationMs: number,
): GuardrailValidationResult {
    const message = error instanceof Error ? error.message : String(error);
    const shouldDeny = !binding.failOpen;
    return {
        validatorId: binding.id,
        validatorName: binding.name,
        engineKind: binding.providerKind,
        success: false,
        passed: undefined,
        shouldDeny,
        violations: [],
        evidence: [],
        warnings: [],
        durationMs,
        error: message,
        resolvedByFailOpen: binding.failOpen ? true : undefined,
        resolvedByFailClosed: !binding.failOpen ? true : undefined,
    };
}

/**
 * Builds a passing GuardrailValidationResult with no violations.
 */
export function makePassResult(
    binding: ValidatorBinding,
    durationMs: number,
    evidence: GuardrailEvidence[] = [],
    warnings: string[] = [],
): GuardrailValidationResult {
    return {
        validatorId: binding.id,
        validatorName: binding.name,
        engineKind: binding.providerKind,
        success: true,
        passed: true,
        shouldDeny: false,
        violations: [],
        evidence,
        warnings,
        durationMs,
    };
}

/**
 * Builds a blocking GuardrailValidationResult with one or more violations.
 */
export function makeViolationResult(
    binding: ValidatorBinding,
    violations: GuardrailViolation[],
    durationMs: number,
    evidence: GuardrailEvidence[] = [],
    warnings: string[] = [],
): GuardrailValidationResult {
    return {
        validatorId: binding.id,
        validatorName: binding.name,
        engineKind: binding.providerKind,
        success: true,
        passed: false,
        shouldDeny: true,
        violations,
        evidence,
        warnings,
        durationMs,
    };
}
