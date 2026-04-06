/**
 * ValidatorRegistry.ts
 *
 * Runtime registry for guardrail validator adapters.
 *
 * Architecture position:
 *   GuardrailPolicyConfig (authored by UI) →
 *   ValidatorRegistry.runBindings() →
 *   Adapters (engine-specific execution) →
 *   AggregatedValidationResult →
 *   PolicyGate (enforcement decision)
 *
 * Responsibilities:
 *   1. Maintain a map of ValidatorProviderKind → IGuardrailAdapter.
 *   2. Resolve which validator bindings apply to a given request context.
 *   3. Execute bindings in priority order (lower priority number = runs first;
 *      ties broken by insertion order).
 *   4. Aggregate normalized results deterministically into AggregatedValidationResult.
 *   5. Honor failOpen / failClosed semantics per-binding (enforced in adapters).
 *   6. Never throw — all errors are returned as result records.
 *
 * PolicyGate integration:
 *   PolicyGate reads AggregatedValidationResult.shouldDenyOverall and:
 *     - true  → block the side effect (throw PolicyDeniedError)
 *     - false → permit the side effect
 *
 * Node.js (electron/) only.
 */

import type { ValidatorBinding, GuardrailPolicyConfig } from '../../../shared/guardrails/guardrailPolicyTypes';
import type {
    IGuardrailAdapter,
    GuardrailValidationRequest,
    GuardrailValidationResult,
    AggregatedValidationResult,
} from './types';

// ─── Built-in adapters ────────────────────────────────────────────────────────

import { localGuardrailsAIAdapter } from './adapters/LocalGuardrailsAIAdapter';
import { localPresidioAdapter } from './adapters/LocalPresidioAdapter';
import { localNeMoGuardrailsAdapter } from './adapters/LocalNeMoGuardrailsAdapter';
import { localOPAAdapter } from './adapters/LocalOPAAdapter';
import { remoteGuardrailsServiceAdapter } from './adapters/RemoteGuardrailsServiceAdapter';
import { remoteNeMoGuardrailsAdapter } from './adapters/RemoteNeMoGuardrailsAdapter';
import { remoteOPAAdapter } from './adapters/RemoteOPAAdapter';

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * ValidatorRegistry
 *
 * Resolves adapter instances for configured validator bindings and runs them
 * against a validation request, aggregating results deterministically.
 */
export class ValidatorRegistry {

    /** Map of providerKind → adapter. */
    private readonly _adapters = new Map<string, IGuardrailAdapter>();

    constructor() {
        // Register all built-in adapters
        this._register(localGuardrailsAIAdapter);
        this._register(localPresidioAdapter);
        this._register(localNeMoGuardrailsAdapter);
        this._register(localOPAAdapter);
        this._register(remoteGuardrailsServiceAdapter);
        this._register(remoteNeMoGuardrailsAdapter);
        this._register(remoteOPAAdapter);
    }

    /**
     * Register an adapter for its providerKind.
     * Replaces any existing adapter for the same kind (useful for testing).
     */
    register(adapter: IGuardrailAdapter): void {
        this._register(adapter);
    }

    /**
     * Execute a set of validator bindings against a request.
     *
     * Bindings are sorted by priority (ascending) before execution.
     * Ties in priority are broken by insertion order (stable sort).
     * Disabled bindings are skipped.
     * Unknown providerKind bindings produce an error result (failOpen/Closed applied).
     *
     * @param bindings  ValidatorBinding[] from a GuardrailRule.validatorBindings.
     * @param request   The normalized validation request.
     * @returns         AggregatedValidationResult.
     */
    async runBindings(
        bindings: ValidatorBinding[],
        request: GuardrailValidationRequest,
    ): Promise<AggregatedValidationResult> {
        // Filter to enabled bindings, then sort by priority (stable)
        const active = [...bindings.filter(b => b.enabled)]
            .sort((a, b) => a.priority - b.priority);

        if (active.length === 0) {
            return this._makeAggregated([]);
        }

        const results: GuardrailValidationResult[] = [];

        for (const binding of active) {
            const adapter = this._adapters.get(binding.providerKind);
            if (!adapter) {
                // Unknown provider kind — synthesize an error result
                const errResult: GuardrailValidationResult = {
                    validatorId: binding.id,
                    validatorName: binding.name,
                    engineKind: binding.providerKind,
                    success: false,
                    passed: undefined,
                    shouldDeny: !binding.failOpen,
                    violations: [],
                    evidence: [],
                    warnings: [],
                    durationMs: 0,
                    error: `No adapter registered for providerKind '${binding.providerKind}'`,
                    resolvedByFailOpen: binding.failOpen ? true : undefined,
                    resolvedByFailClosed: !binding.failOpen ? true : undefined,
                };
                results.push(errResult);
                continue;
            }

            const result = await adapter.execute(binding, request);
            results.push(result);
        }

        return this._makeAggregated(results);
    }

    /**
     * Resolve and run all applicable validator bindings for a policy rule
     * referenced by ID from a GuardrailPolicyConfig.
     *
     * This convenience method looks up the rule in the config, extracts its
     * bindings, filters to those that are enabled and match the request scope,
     * and delegates to runBindings().
     *
     * @param config    The active GuardrailPolicyConfig.
     * @param ruleId    ID of the GuardrailRule to evaluate.
     * @param request   The validation request.
     */
    async runRuleBindings(
        config: GuardrailPolicyConfig,
        ruleId: string,
        request: GuardrailValidationRequest,
    ): Promise<AggregatedValidationResult> {
        const rule = config.rules.find(r => r.id === ruleId);
        if (!rule || !rule.enabled) {
            return this._makeAggregated([]);
        }
        return this.runBindings(rule.validatorBindings, request);
    }

    /**
     * Return the list of registered providerKind strings.
     * Useful for diagnostics and testing.
     */
    registeredKinds(): string[] {
        return [...this._adapters.keys()];
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    private _register(adapter: IGuardrailAdapter): void {
        this._adapters.set(adapter.providerKind, adapter);
    }

    /**
     * Aggregate a list of individual results into a single deterministic outcome.
     *
     * Aggregation rules:
     *   - shouldDenyOverall = true if ANY result has shouldDeny=true
     *   - allSucceeded      = true if ALL results have success=true
     *   - overallPassed     = allSucceeded && !shouldDenyOverall
     *   - totalDurationMs   = sum of individual durationMs
     *   - allViolations     = flat list in execution order
     *   - allWarnings       = flat list in execution order
     */
    private _makeAggregated(results: GuardrailValidationResult[]): AggregatedValidationResult {
        const shouldDenyOverall = results.some(r => r.shouldDeny);
        const allSucceeded = results.length === 0 || results.every(r => r.success);
        const overallPassed = allSucceeded && !shouldDenyOverall;
        const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
        const allViolations = results.flatMap(r => r.violations);
        const allWarnings = results.flatMap(r => r.warnings);

        return {
            allSucceeded,
            shouldDenyOverall,
            overallPassed,
            results,
            totalDurationMs,
            allViolations,
            allWarnings,
        };
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/**
 * Module-level singleton ValidatorRegistry.
 *
 * Used by PolicyGate and guardrail services across the Tala runtime.
 * Stateless beyond adapter registration, so sharing is safe.
 */
export const validatorRegistry = new ValidatorRegistry();
