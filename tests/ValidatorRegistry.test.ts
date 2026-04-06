/**
 * ValidatorRegistry.test.ts
 *
 * Unit tests for the guardrail validator execution layer.
 *
 * Test groups:
 *   1.  Registry — adapter registration and providerKind resolution
 *   2.  Adapter selection — correct adapter dispatched per providerKind
 *   3.  Stub adapters — local stubs pass by default
 *   4.  failOpen / failClosed behavior
 *   5.  Timeout — remote adapters abort on timeout
 *   6.  Unknown providerKind — error result with failOpen/Closed applied
 *   7.  Disabled bindings — skipped
 *   8.  Priority ordering — results in priority order
 *   9.  Aggregation — shouldDenyOverall, allSucceeded, allViolations
 *   10. Empty bindings — aggregated result for zero bindings
 *   11. OPA response parsing — LocalOPAAdapter and RemoteOPAAdapter
 *   12. runRuleBindings — convenience rule lookup
 *   13. Custom adapter override — test injection
 *
 * No DB, no IPC, no real HTTP calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidatorRegistry, validatorRegistry } from '../electron/services/guardrails/ValidatorRegistry';
import { LocalOPAAdapter } from '../electron/services/guardrails/adapters/LocalOPAAdapter';
import { RemoteOPAAdapter } from '../electron/services/guardrails/adapters/RemoteOPAAdapter';
import { LocalGuardrailsAIAdapter } from '../electron/services/guardrails/adapters/LocalGuardrailsAIAdapter';
import { LocalPresidioAdapter } from '../electron/services/guardrails/adapters/LocalPresidioAdapter';
import { LocalNeMoGuardrailsAdapter } from '../electron/services/guardrails/adapters/LocalNeMoGuardrailsAdapter';
import { makeErrorResult, makePassResult, makeViolationResult } from '../electron/services/guardrails/types';
import type {
    IGuardrailAdapter,
    GuardrailValidationRequest,
    GuardrailValidationResult,
} from '../electron/services/guardrails/types';
import type { ValidatorBinding, GuardrailPolicyConfig } from '../shared/guardrails/guardrailPolicyTypes';
import { makeDefaultGuardrailPolicyConfig } from '../shared/guardrails/guardrailPolicyTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBinding(overrides: Partial<ValidatorBinding> = {}): ValidatorBinding {
    return {
        id: 'test-binding-1',
        name: 'Test Binding',
        providerKind: 'local_guardrails_ai',
        enabled: true,
        executionScopes: [],
        supportedActions: ['require_validation'],
        failOpen: false,
        priority: 0,
        ...overrides,
    };
}

function makeRequest(overrides: Partial<GuardrailValidationRequest> = {}): GuardrailValidationRequest {
    return {
        content: 'test content',
        executionMode: 'assistant',
        executionOrigin: 'user',
        executionType: 'chat_turn',
        actionKind: 'tool_invoke',
        ...overrides,
    };
}

/** A mock adapter that always passes. */
class PassAdapter implements IGuardrailAdapter {
    readonly providerKind: string;
    constructor(kind: string) { this.providerKind = kind; }
    async execute(binding: ValidatorBinding, _req: GuardrailValidationRequest): Promise<GuardrailValidationResult> {
        return makePassResult(binding, 1);
    }
}

/** A mock adapter that always blocks. */
class BlockAdapter implements IGuardrailAdapter {
    readonly providerKind: string;
    constructor(kind: string) { this.providerKind = kind; }
    async execute(binding: ValidatorBinding, _req: GuardrailValidationRequest): Promise<GuardrailValidationResult> {
        return makeViolationResult(binding, [{ ruleId: 'test:block', message: 'Blocked by mock' }], 1);
    }
}

/** A mock adapter that throws (simulates engine crash). */
class ThrowAdapter implements IGuardrailAdapter {
    readonly providerKind: string;
    constructor(kind: string) { this.providerKind = kind; }
    async execute(binding: ValidatorBinding, _req: GuardrailValidationRequest): Promise<GuardrailValidationResult> {
        return makeErrorResult(binding, new Error('Simulated crash'), 5);
    }
}

// ─── Group 1: Registry — adapter registration ─────────────────────────────────

describe('ValidatorRegistry — adapter registration', () => {
    it('VR01: singleton validatorRegistry is a ValidatorRegistry instance', () => {
        expect(validatorRegistry).toBeInstanceOf(ValidatorRegistry);
    });

    it('VR02: new registry has all 7 built-in adapter kinds registered', () => {
        const registry = new ValidatorRegistry();
        const kinds = registry.registeredKinds();
        expect(kinds).toContain('local_guardrails_ai');
        expect(kinds).toContain('local_presidio');
        expect(kinds).toContain('local_nemo_guardrails');
        expect(kinds).toContain('local_opa');
        expect(kinds).toContain('remote_guardrails_service');
        expect(kinds).toContain('remote_nemo_guardrails');
        expect(kinds).toContain('remote_opa');
        expect(kinds).toHaveLength(7);
    });

    it('VR03: register() replaces existing adapter for same kind', () => {
        const registry = new ValidatorRegistry();
        const custom = new PassAdapter('local_guardrails_ai');
        registry.register(custom);
        expect(registry.registeredKinds()).toContain('local_guardrails_ai');
        // Still 7 kinds (replaced, not added)
        expect(registry.registeredKinds()).toHaveLength(7);
    });

    it('VR04: register() adds new kind not in built-ins', () => {
        const registry = new ValidatorRegistry();
        registry.register(new PassAdapter('custom_validator'));
        expect(registry.registeredKinds()).toContain('custom_validator');
        expect(registry.registeredKinds()).toHaveLength(8);
    });
});

// ─── Group 2: Adapter selection ───────────────────────────────────────────────

describe('ValidatorRegistry — adapter selection', () => {
    it('VR05: dispatches to correct adapter for local_guardrails_ai', async () => {
        const registry = new ValidatorRegistry();
        const mock = new PassAdapter('local_guardrails_ai');
        const spy = vi.spyOn(mock, 'execute');
        registry.register(mock);

        const binding = makeBinding({ providerKind: 'local_guardrails_ai' });
        await registry.runBindings([binding], makeRequest());
        expect(spy).toHaveBeenCalledOnce();
    });

    it('VR06: dispatches to correct adapter for local_presidio', async () => {
        const registry = new ValidatorRegistry();
        const mock = new PassAdapter('local_presidio');
        const spy = vi.spyOn(mock, 'execute');
        registry.register(mock);

        const binding = makeBinding({ providerKind: 'local_presidio' });
        await registry.runBindings([binding], makeRequest());
        expect(spy).toHaveBeenCalledOnce();
    });

    it('VR07: dispatches to correct adapter for remote_opa', async () => {
        const registry = new ValidatorRegistry();
        const mock = new PassAdapter('remote_opa');
        const spy = vi.spyOn(mock, 'execute');
        registry.register(mock);

        const binding = makeBinding({ providerKind: 'remote_opa' });
        await registry.runBindings([binding], makeRequest());
        expect(spy).toHaveBeenCalledOnce();
    });
});

// ─── Group 3: Stub adapters (local) pass by default ───────────────────────────

describe('Stub adapters — default pass behavior', () => {
    it('VR08: LocalGuardrailsAIAdapter stub returns passed=true', async () => {
        const adapter = new LocalGuardrailsAIAdapter();
        const binding = makeBinding({ providerKind: 'local_guardrails_ai', validatorName: 'ToxicLanguage' });
        const result = await adapter.execute(binding, makeRequest());
        expect(result.success).toBe(true);
        expect(result.passed).toBe(true);
        expect(result.shouldDeny).toBe(false);
    });

    it('VR09: LocalPresidioAdapter stub returns passed=true (no entities)', async () => {
        const adapter = new LocalPresidioAdapter();
        const binding = makeBinding({ providerKind: 'local_presidio', entityTypes: ['PERSON'] });
        const result = await adapter.execute(binding, makeRequest());
        expect(result.success).toBe(true);
        expect(result.passed).toBe(true);
        expect(result.shouldDeny).toBe(false);
    });

    it('VR10: LocalNeMoGuardrailsAdapter stub returns passed=true', async () => {
        const adapter = new LocalNeMoGuardrailsAdapter();
        const binding = makeBinding({ providerKind: 'local_nemo_guardrails', railSet: 'safe_assistant' });
        const result = await adapter.execute(binding, makeRequest());
        expect(result.success).toBe(true);
        expect(result.passed).toBe(true);
        expect(result.shouldDeny).toBe(false);
    });

    it('VR11: LocalOPAAdapter stub returns passed=true', async () => {
        const adapter = new LocalOPAAdapter();
        const binding = makeBinding({ providerKind: 'local_opa', policyModule: 'policy/test', ruleName: 'allow' });
        const result = await adapter.execute(binding, makeRequest());
        expect(result.success).toBe(true);
        expect(result.passed).toBe(true);
        expect(result.shouldDeny).toBe(false);
    });
});

// ─── Group 4: failOpen / failClosed behavior ──────────────────────────────────

describe('failOpen / failClosed behavior', () => {
    it('VR12: failClosed binding → shouldDeny=true on adapter error', async () => {
        const registry = new ValidatorRegistry();
        registry.register(new ThrowAdapter('local_guardrails_ai'));
        const binding = makeBinding({ failOpen: false });
        const result = await registry.runBindings([binding], makeRequest());
        expect(result.shouldDenyOverall).toBe(true);
        expect(result.results[0].resolvedByFailClosed).toBe(true);
        expect(result.results[0].success).toBe(false);
    });

    it('VR13: failOpen binding → shouldDeny=false on adapter error', async () => {
        const registry = new ValidatorRegistry();
        registry.register(new ThrowAdapter('local_guardrails_ai'));
        const binding = makeBinding({ failOpen: true });
        const result = await registry.runBindings([binding], makeRequest());
        expect(result.shouldDenyOverall).toBe(false);
        expect(result.results[0].resolvedByFailOpen).toBe(true);
        expect(result.results[0].success).toBe(false);
    });

    it('VR14: failClosed binding → shouldDeny=true for unknown providerKind', async () => {
        const registry = new ValidatorRegistry();
        const binding = makeBinding({ providerKind: 'totally_unknown', failOpen: false });
        const result = await registry.runBindings([binding], makeRequest());
        expect(result.shouldDenyOverall).toBe(true);
        expect(result.results[0].success).toBe(false);
        expect(result.results[0].error).toContain('totally_unknown');
    });

    it('VR15: failOpen binding → shouldDeny=false for unknown providerKind', async () => {
        const registry = new ValidatorRegistry();
        const binding = makeBinding({ providerKind: 'totally_unknown', failOpen: true });
        const result = await registry.runBindings([binding], makeRequest());
        expect(result.shouldDenyOverall).toBe(false);
        expect(result.results[0].resolvedByFailOpen).toBe(true);
    });
});

// ─── Group 5: Timeout handling ────────────────────────────────────────────────

describe('Timeout handling', () => {
    it('VR16: RemoteGuardrailsServiceAdapter with missing endpointUrl returns error result', async () => {
        const { RemoteGuardrailsServiceAdapter } = await import('../electron/services/guardrails/adapters/RemoteGuardrailsServiceAdapter');
        const adapter = new RemoteGuardrailsServiceAdapter();
        const binding = makeBinding({ providerKind: 'remote_guardrails_service', endpointUrl: undefined, failOpen: true });
        const result = await adapter.execute(binding, makeRequest());
        expect(result.success).toBe(false);
        expect(result.error).toContain('endpointUrl is required');
        expect(result.resolvedByFailOpen).toBe(true);
    });

    it('VR17: RemoteNeMoGuardrailsAdapter with missing endpointUrl returns error result', async () => {
        const { RemoteNeMoGuardrailsAdapter } = await import('../electron/services/guardrails/adapters/RemoteNeMoGuardrailsAdapter');
        const adapter = new RemoteNeMoGuardrailsAdapter();
        const binding = makeBinding({ providerKind: 'remote_nemo_guardrails', endpointUrl: undefined, failOpen: false });
        const result = await adapter.execute(binding, makeRequest());
        expect(result.success).toBe(false);
        expect(result.error).toContain('endpointUrl is required');
        expect(result.resolvedByFailClosed).toBe(true);
    });

    it('VR18: RemoteOPAAdapter with missing endpointUrl returns error result', async () => {
        const { RemoteOPAAdapter } = await import('../electron/services/guardrails/adapters/RemoteOPAAdapter');
        const adapter = new RemoteOPAAdapter();
        const binding = makeBinding({ providerKind: 'remote_opa', endpointUrl: undefined, failOpen: false });
        const result = await adapter.execute(binding, makeRequest());
        expect(result.success).toBe(false);
        expect(result.error).toContain('endpointUrl is required');
    });
});

// ─── Group 6: Unknown providerKind ────────────────────────────────────────────

describe('Unknown providerKind', () => {
    it('VR19: unknown kind produces an error result with non-zero priority', async () => {
        const registry = new ValidatorRegistry();
        const binding = makeBinding({ id: 'unk-1', providerKind: 'non_existent_kind', failOpen: false, priority: 5 });
        const result = await registry.runBindings([binding], makeRequest());
        expect(result.results).toHaveLength(1);
        expect(result.results[0].success).toBe(false);
        expect(result.results[0].validatorId).toBe('unk-1');
    });
});

// ─── Group 7: Disabled bindings ───────────────────────────────────────────────

describe('Disabled bindings', () => {
    it('VR20: disabled binding is skipped', async () => {
        const registry = new ValidatorRegistry();
        const mock = new BlockAdapter('local_guardrails_ai');
        const spy = vi.spyOn(mock, 'execute');
        registry.register(mock);

        const binding = makeBinding({ enabled: false });
        const result = await registry.runBindings([binding], makeRequest());
        expect(spy).not.toHaveBeenCalled();
        expect(result.results).toHaveLength(0);
        expect(result.shouldDenyOverall).toBe(false);
    });

    it('VR21: mix of enabled and disabled — only enabled run', async () => {
        const registry = new ValidatorRegistry();
        const mock = new PassAdapter('local_guardrails_ai');
        const spy = vi.spyOn(mock, 'execute');
        registry.register(mock);

        const b1 = makeBinding({ id: 'b1', enabled: false });
        const b2 = makeBinding({ id: 'b2', enabled: true });
        await registry.runBindings([b1, b2], makeRequest());
        expect(spy).toHaveBeenCalledOnce();
    });
});

// ─── Group 8: Priority ordering ───────────────────────────────────────────────

describe('Priority ordering', () => {
    it('VR22: bindings executed in priority order (ascending)', async () => {
        const registry = new ValidatorRegistry();
        const order: string[] = [];

        class OrderedAdapter implements IGuardrailAdapter {
            readonly providerKind: string;
            constructor(kind: string, private readonly label: string) {
                this.providerKind = kind;
            }
            async execute(binding: ValidatorBinding, _r: GuardrailValidationRequest): Promise<GuardrailValidationResult> {
                order.push(this.label);
                return makePassResult(binding, 1);
            }
        }

        registry.register(new OrderedAdapter('local_guardrails_ai', 'A'));
        registry.register(new OrderedAdapter('local_presidio', 'B'));
        registry.register(new OrderedAdapter('local_opa', 'C'));

        const bindings = [
            makeBinding({ id: 'b1', providerKind: 'local_opa', priority: 3 }),
            makeBinding({ id: 'b2', providerKind: 'local_guardrails_ai', priority: 1 }),
            makeBinding({ id: 'b3', providerKind: 'local_presidio', priority: 2 }),
        ];

        await registry.runBindings(bindings, makeRequest());
        expect(order).toEqual(['A', 'B', 'C']); // sorted by priority: 1, 2, 3
    });

    it('VR23: ties in priority preserved by insertion order', async () => {
        const registry = new ValidatorRegistry();
        const order: string[] = [];

        class OrderedAdapter2 implements IGuardrailAdapter {
            readonly providerKind: string;
            constructor(kind: string, private readonly label: string) {
                this.providerKind = kind;
            }
            async execute(binding: ValidatorBinding, _r: GuardrailValidationRequest): Promise<GuardrailValidationResult> {
                order.push(this.label);
                return makePassResult(binding, 1);
            }
        }

        registry.register(new OrderedAdapter2('local_guardrails_ai', 'First'));
        registry.register(new OrderedAdapter2('local_presidio', 'Second'));

        const bindings = [
            makeBinding({ id: 'b1', providerKind: 'local_guardrails_ai', priority: 0 }),
            makeBinding({ id: 'b2', providerKind: 'local_presidio', priority: 0 }),
        ];

        await registry.runBindings(bindings, makeRequest());
        expect(order).toEqual(['First', 'Second']);
    });
});

// ─── Group 9: Aggregation ─────────────────────────────────────────────────────

describe('Aggregation — shouldDenyOverall and allViolations', () => {
    it('VR24: all pass → shouldDenyOverall=false, overallPassed=true', async () => {
        const registry = new ValidatorRegistry();
        registry.register(new PassAdapter('local_guardrails_ai'));
        registry.register(new PassAdapter('local_presidio'));

        const bindings = [
            makeBinding({ id: 'b1', providerKind: 'local_guardrails_ai' }),
            makeBinding({ id: 'b2', providerKind: 'local_presidio' }),
        ];
        const result = await registry.runBindings(bindings, makeRequest());
        expect(result.shouldDenyOverall).toBe(false);
        expect(result.overallPassed).toBe(true);
        expect(result.allSucceeded).toBe(true);
        expect(result.results).toHaveLength(2);
    });

    it('VR25: one blocks → shouldDenyOverall=true even if others pass', async () => {
        const registry = new ValidatorRegistry();
        registry.register(new PassAdapter('local_guardrails_ai'));
        registry.register(new BlockAdapter('local_presidio'));

        const bindings = [
            makeBinding({ id: 'b1', providerKind: 'local_guardrails_ai' }),
            makeBinding({ id: 'b2', providerKind: 'local_presidio' }),
        ];
        const result = await registry.runBindings(bindings, makeRequest());
        expect(result.shouldDenyOverall).toBe(true);
        expect(result.overallPassed).toBe(false);
        expect(result.allSucceeded).toBe(true); // block is still 'success' (no error)
    });

    it('VR26: allViolations collects violations from all blocking adapters', async () => {
        const registry = new ValidatorRegistry();

        class TwoViolationAdapter implements IGuardrailAdapter {
            readonly providerKind = 'local_guardrails_ai';
            async execute(b: ValidatorBinding): Promise<GuardrailValidationResult> {
                return makeViolationResult(b, [
                    { ruleId: 'r1', message: 'V1' },
                    { ruleId: 'r2', message: 'V2' },
                ], 1);
            }
        }
        registry.register(new TwoViolationAdapter());

        const binding = makeBinding({ providerKind: 'local_guardrails_ai' });
        const result = await registry.runBindings([binding], makeRequest());
        expect(result.allViolations).toHaveLength(2);
        expect(result.allViolations[0].ruleId).toBe('r1');
        expect(result.allViolations[1].ruleId).toBe('r2');
    });

    it('VR27: allSucceeded=false when at least one adapter errored', async () => {
        const registry = new ValidatorRegistry();
        registry.register(new PassAdapter('local_guardrails_ai'));
        registry.register(new ThrowAdapter('local_presidio'));

        const bindings = [
            makeBinding({ id: 'b1', providerKind: 'local_guardrails_ai', failOpen: false }),
            makeBinding({ id: 'b2', providerKind: 'local_presidio', failOpen: false }),
        ];
        const result = await registry.runBindings(bindings, makeRequest());
        expect(result.allSucceeded).toBe(false);
        expect(result.shouldDenyOverall).toBe(true); // failClosed
    });

    it('VR28: totalDurationMs is sum of all individual durationMs', async () => {
        const registry = new ValidatorRegistry();

        class TimedAdapter implements IGuardrailAdapter {
            readonly providerKind: string;
            constructor(kind: string, private readonly dur: number) { this.providerKind = kind; }
            async execute(b: ValidatorBinding): Promise<GuardrailValidationResult> {
                return makePassResult(b, this.dur);
            }
        }

        registry.register(new TimedAdapter('local_guardrails_ai', 10));
        registry.register(new TimedAdapter('local_presidio', 20));

        const bindings = [
            makeBinding({ id: 'b1', providerKind: 'local_guardrails_ai' }),
            makeBinding({ id: 'b2', providerKind: 'local_presidio' }),
        ];
        const result = await registry.runBindings(bindings, makeRequest());
        expect(result.totalDurationMs).toBe(30);
    });
});

// ─── Group 10: Empty bindings ─────────────────────────────────────────────────

describe('Empty bindings', () => {
    it('VR29: empty bindings returns safe aggregated result (all pass, no deny)', async () => {
        const registry = new ValidatorRegistry();
        const result = await registry.runBindings([], makeRequest());
        expect(result.shouldDenyOverall).toBe(false);
        expect(result.overallPassed).toBe(true);
        expect(result.allSucceeded).toBe(true);
        expect(result.results).toHaveLength(0);
        expect(result.totalDurationMs).toBe(0);
    });
});

// ─── Group 11: OPA response parsing ──────────────────────────────────────────

describe('OPA response parsing', () => {
    it('VR30: LocalOPAAdapter parses boolean true result → allowed', () => {
        const adapter = new LocalOPAAdapter();
        const result = adapter._parseOPAResponse({ result: true });
        expect(result.allowed).toBe(true);
    });

    it('VR31: LocalOPAAdapter parses boolean false result → denied', () => {
        const adapter = new LocalOPAAdapter();
        const result = adapter._parseOPAResponse({ result: false });
        expect(result.allowed).toBe(false);
    });

    it('VR32: LocalOPAAdapter parses {allow: true} object → allowed', () => {
        const adapter = new LocalOPAAdapter();
        const result = adapter._parseOPAResponse({ result: { allow: true } });
        expect(result.allowed).toBe(true);
    });

    it('VR33: LocalOPAAdapter parses {deny: true} object → denied', () => {
        const adapter = new LocalOPAAdapter();
        const result = adapter._parseOPAResponse({ result: { deny: true } });
        expect(result.allowed).toBe(false);
    });

    it('VR34: LocalOPAAdapter parses {deny: false} object → allowed', () => {
        const adapter = new LocalOPAAdapter();
        const result = adapter._parseOPAResponse({ result: { deny: false } });
        expect(result.allowed).toBe(true);
    });

    it('VR35: LocalOPAAdapter parses unknown object shape → defaults to allow', () => {
        const adapter = new LocalOPAAdapter();
        const result = adapter._parseOPAResponse({ result: { something: 'else' } });
        expect(result.allowed).toBe(true);
    });

    it('VR36: RemoteOPAAdapter parses null result → defaults to allow', () => {
        const adapter = new RemoteOPAAdapter();
        const result = adapter._parseOPAResponse({ result: null });
        expect(result.allowed).toBe(true);
        expect(result.reason).toContain('undefined result');
    });

    it('VR37: RemoteOPAAdapter parses {allow: false} → denied with reason', () => {
        const adapter = new RemoteOPAAdapter();
        const result = adapter._parseOPAResponse({ result: { allow: false, reason: 'not permitted' } });
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('not permitted');
    });
});

// ─── Group 12: runRuleBindings ────────────────────────────────────────────────

describe('runRuleBindings — config-based rule lookup', () => {
    function makeConfig(ruleBindings: ValidatorBinding[]): GuardrailPolicyConfig {
        const now = new Date().toISOString();
        const cfg = makeDefaultGuardrailPolicyConfig();
        return {
            ...cfg,
            rules: [{
                id: 'rule-1',
                name: 'Test Rule',
                enabled: true,
                scopes: [],
                severity: 'medium',
                action: 'require_validation',
                validatorBindings: ruleBindings,
                createdAt: now,
                updatedAt: now,
            }],
        };
    }

    it('VR38: runRuleBindings with valid rule runs its bindings', async () => {
        const registry = new ValidatorRegistry();
        const mock = new PassAdapter('local_guardrails_ai');
        const spy = vi.spyOn(mock, 'execute');
        registry.register(mock);

        const binding = makeBinding({ providerKind: 'local_guardrails_ai' });
        const config = makeConfig([binding]);
        const result = await registry.runRuleBindings(config, 'rule-1', makeRequest());
        expect(spy).toHaveBeenCalledOnce();
        expect(result.overallPassed).toBe(true);
    });

    it('VR39: runRuleBindings with unknown ruleId returns safe empty result', async () => {
        const registry = new ValidatorRegistry();
        const config = makeConfig([]);
        const result = await registry.runRuleBindings(config, 'non-existent-rule', makeRequest());
        expect(result.shouldDenyOverall).toBe(false);
        expect(result.results).toHaveLength(0);
    });

    it('VR40: runRuleBindings with disabled rule returns safe empty result', async () => {
        const registry = new ValidatorRegistry();
        const now = new Date().toISOString();
        const cfg: GuardrailPolicyConfig = {
            ...makeDefaultGuardrailPolicyConfig(),
            rules: [{
                id: 'rule-disabled',
                name: 'Disabled Rule',
                enabled: false,   // disabled
                scopes: [],
                severity: 'low',
                action: 'require_validation',
                validatorBindings: [makeBinding()],
                createdAt: now,
                updatedAt: now,
            }],
        };
        const result = await registry.runRuleBindings(cfg, 'rule-disabled', makeRequest());
        expect(result.shouldDenyOverall).toBe(false);
        expect(result.results).toHaveLength(0);
    });
});

// ─── Group 13: Custom adapter override (test injection) ───────────────────────

describe('Custom adapter override', () => {
    it('VR41: can replace built-in adapter with test double', async () => {
        const registry = new ValidatorRegistry();

        let captured: GuardrailValidationRequest | undefined;
        class CapturingAdapter implements IGuardrailAdapter {
            readonly providerKind = 'local_guardrails_ai';
            async execute(binding: ValidatorBinding, req: GuardrailValidationRequest): Promise<GuardrailValidationResult> {
                captured = req;
                return makePassResult(binding, 1);
            }
        }

        registry.register(new CapturingAdapter());
        const req = makeRequest({ executionMode: 'rp', content: 'hello world' });
        await registry.runBindings([makeBinding()], req);

        expect(captured).toBeDefined();
        expect(captured!.executionMode).toBe('rp');
        expect(captured!.content).toBe('hello world');
    });

    it('VR42: result validatorId and validatorName reflect binding config', async () => {
        const registry = new ValidatorRegistry();
        registry.register(new PassAdapter('local_guardrails_ai'));

        const binding = makeBinding({ id: 'my-binding-id', name: 'My Binding Name' });
        const result = await registry.runBindings([binding], makeRequest());
        expect(result.results[0].validatorId).toBe('my-binding-id');
        expect(result.results[0].validatorName).toBe('My Binding Name');
    });
});
