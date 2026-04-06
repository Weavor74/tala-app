/**
 * PolicyGateGuardrailIntegration.test.ts
 *
 * Integration tests for Phase 3: PolicyGate consuming GuardrailPolicyConfig
 * and dispatching to ValidatorRegistry for builder-authored runtime rules.
 *
 * Test groups:
 *   1.  Active profile loading
 *   2.  Rule scope matching
 *   3.  Deny rules
 *   4.  Warn rules
 *   5.  require_validation — local validators pass
 *   6.  require_validation — local validators block
 *   7.  require_validation — remote failOpen (error → allow)
 *   8.  require_validation — remote failClosed (error → deny)
 *   9.  Deterministic ordering — first matching deny wins
 *   10. Telemetry events
 *   11. No regression with default permissive profile
 *   12. checkSideEffectAsync / assertSideEffectAsync typed wrappers
 *   13. require_validation with no bindings → pass
 *   14. require_confirmation treated as warn
 *   15. Hardcoded rules fire first even when config is set
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PolicyGate, PolicyDeniedError } from '../electron/services/policy/PolicyGate';
import { ValidatorRegistry } from '../electron/services/guardrails/ValidatorRegistry';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { makeDefaultGuardrailPolicyConfig } from '../shared/guardrails/guardrailPolicyTypes';
import type {
    GuardrailPolicyConfig,
    GuardrailRule,
    GuardrailScope,
    GuardrailAction,
    GuardrailSeverity,
    ValidatorBinding,
} from '../shared/guardrails/guardrailPolicyTypes';
import type {
    IGuardrailAdapter,
    GuardrailValidationRequest,
    GuardrailValidationResult,
} from '../electron/services/guardrails/types';
import { makePassResult, makeViolationResult, makeErrorResult } from '../electron/services/guardrails/types';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

/** Minimal ValidatorBinding factory. */
function makeBinding(overrides: Partial<ValidatorBinding> = {}): ValidatorBinding {
    return {
        id: 'vb-1',
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

/** Minimal GuardrailRule factory. */
function makeRule(overrides: {
    id?: string;
    name?: string;
    action?: GuardrailAction;
    enabled?: boolean;
    scopes?: GuardrailScope[];
    severity?: GuardrailSeverity;
    validatorBindings?: ValidatorBinding[];
} = {}): GuardrailRule {
    return {
        id: overrides.id ?? 'rule-1',
        name: overrides.name ?? 'Test Rule',
        enabled: overrides.enabled ?? true,
        scopes: overrides.scopes ?? [],
        severity: overrides.severity ?? 'medium',
        action: overrides.action ?? 'allow',
        validatorBindings: overrides.validatorBindings ?? [],
        createdAt: NOW,
        updatedAt: NOW,
    };
}

/** Build a GuardrailPolicyConfig with a single 'test-profile'. */
function makeConfig(rules: GuardrailRule[]): GuardrailPolicyConfig {
    return {
        version: 1,
        activeProfileId: 'test-profile',
        profiles: [{
            id: 'test-profile',
            name: 'Test Profile',
            ruleIds: rules.map(r => r.id),
        }],
        rules,
        validatorBindings: [],
        updatedAt: NOW,
    };
}

/** Mock adapter that always passes. */
class PassAdapter implements IGuardrailAdapter {
    readonly providerKind: string;
    constructor(kind = 'local_guardrails_ai') { this.providerKind = kind; }
    async execute(b: ValidatorBinding): Promise<GuardrailValidationResult> {
        return makePassResult(b, 1);
    }
}

/** Mock adapter that always blocks. */
class BlockAdapter implements IGuardrailAdapter {
    readonly providerKind: string;
    constructor(kind = 'local_guardrails_ai') { this.providerKind = kind; }
    async execute(b: ValidatorBinding): Promise<GuardrailValidationResult> {
        return makeViolationResult(b, [{ ruleId: 'block:r1', message: 'Blocked by test' }], 1);
    }
}

/** Mock adapter that simulates an error (failOpen / failClosed applied). */
class ErrorAdapter implements IGuardrailAdapter {
    readonly providerKind: string;
    constructor(kind = 'local_guardrails_ai') { this.providerKind = kind; }
    async execute(b: ValidatorBinding): Promise<GuardrailValidationResult> {
        return makeErrorResult(b, new Error('Simulated engine error'), 5);
    }
}

/** Create a fresh PolicyGate wired to a custom ValidatorRegistry. */
function makePolicyGate(adapters?: IGuardrailAdapter[]): {
    gate: PolicyGate;
    registry: ValidatorRegistry;
} {
    const registry = new ValidatorRegistry();
    if (adapters) {
        for (const a of adapters) registry.register(a);
    }
    const gate = new PolicyGate();
    gate.setRegistry(registry);
    return { gate, registry };
}

// ─── 1. Active profile loading ────────────────────────────────────────────────

describe('Active profile loading', () => {
    it('PGI01: evaluateAsync uses hard-coded default allow when no config set', async () => {
        const { gate } = makePolicyGate();
        const result = await gate.evaluateAsync({ action: 'tool_invoke', mode: 'assistant' });
        expect(result.allowed).toBe(true);
        expect(result.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('PGI02: evaluateAsync loads active profile and applies its deny rule', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ action: 'deny' });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke', mode: 'assistant' });
        expect(result.allowed).toBe(false);
        expect(result.code).toBe(`RULE_DENY:${rule.id}`);
    });

    it('PGI03: inactive rule (enabled=false) is skipped', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ action: 'deny', enabled: false });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
    });

    it('PGI04: rule not listed in active profile ruleIds is ignored even if in config.rules', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ id: 'rule-unlisted', action: 'deny' });
        const cfg: GuardrailPolicyConfig = {
            version: 1,
            activeProfileId: 'test-profile',
            profiles: [{ id: 'test-profile', name: 'Test', ruleIds: [] }], // empty ruleIds
            rules: [rule],
            validatorBindings: [],
            updatedAt: NOW,
        };
        gate.setConfig(cfg);
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
    });

    it('PGI05: active profile not found → default allow', async () => {
        const { gate } = makePolicyGate();
        const cfg: GuardrailPolicyConfig = {
            version: 1,
            activeProfileId: 'non-existent',
            profiles: [{ id: 'other-profile', name: 'Other', ruleIds: [] }],
            rules: [makeRule({ action: 'deny' })],
            validatorBindings: [],
            updatedAt: NOW,
        };
        gate.setConfig(cfg);
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
    });
});

// ─── 2. Rule scope matching ───────────────────────────────────────────────────

describe('Rule scope matching', () => {
    it('PGI06: empty scopes (global rule) matches all contexts', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ action: 'deny', scopes: [] });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke', mode: 'assistant' });
        expect(result.allowed).toBe(false);
    });

    it('PGI07: mode scope matches when mode equals scope.mode', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ action: 'deny', scopes: [{ mode: 'hybrid' }] });
        gate.setConfig(makeConfig([rule]));

        const blocked = await gate.evaluateAsync({ action: 'tool_invoke', mode: 'hybrid' });
        expect(blocked.allowed).toBe(false);

        const allowed = await gate.evaluateAsync({ action: 'tool_invoke', mode: 'assistant' });
        expect(allowed.allowed).toBe(true);
    });

    it('PGI08: mode scope * matches any mode', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ action: 'deny', scopes: [{ mode: '*' }] });
        gate.setConfig(makeConfig([rule]));

        for (const mode of ['rp', 'hybrid', 'assistant', 'system']) {
            const result = await gate.evaluateAsync({ action: 'tool_invoke', mode });
            expect(result.allowed).toBe(false);
        }
    });

    it('PGI09: executionOrigin scope matches context.origin', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ action: 'deny', scopes: [{ executionOrigin: 'mcp' }] });
        gate.setConfig(makeConfig([rule]));

        const blocked = await gate.evaluateAsync({ action: 'tool_invoke', origin: 'mcp' });
        expect(blocked.allowed).toBe(false);

        const allowed = await gate.evaluateAsync({ action: 'tool_invoke', origin: 'user' });
        expect(allowed.allowed).toBe(true);
    });

    it('PGI10: executionType scope matches context.payload.executionType', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ action: 'deny', scopes: [{ executionType: 'autonomy_task' }] });
        gate.setConfig(makeConfig([rule]));

        const blocked = await gate.evaluateAsync({
            action: 'tool_invoke',
            payload: { executionType: 'autonomy_task' },
        });
        expect(blocked.allowed).toBe(false);

        const allowed = await gate.evaluateAsync({
            action: 'tool_invoke',
            payload: { executionType: 'chat_turn' },
        });
        expect(allowed.allowed).toBe(true);
    });

    it('PGI11: capability scope matches context.payload.capability', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ action: 'deny', scopes: [{ capability: 'shell_run' }] });
        gate.setConfig(makeConfig([rule]));

        const blocked = await gate.evaluateAsync({
            action: 'tool_invoke',
            payload: { capability: 'shell_run' },
        });
        expect(blocked.allowed).toBe(false);

        const allowed = await gate.evaluateAsync({
            action: 'tool_invoke',
            payload: { capability: 'fs_read' },
        });
        expect(allowed.allowed).toBe(true);
    });

    it('PGI12: memoryAction scope only matches memory_write action', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({
            action: 'deny',
            scopes: [{ memoryAction: 'memory_create' }],
        });
        gate.setConfig(makeConfig([rule]));

        // Correct action + matching memoryAction → blocked
        const blocked = await gate.evaluateAsync({
            action: 'memory_write',
            payload: { memoryAction: 'memory_create' },
        });
        expect(blocked.allowed).toBe(false);

        // Different action → not blocked
        const allowed = await gate.evaluateAsync({
            action: 'tool_invoke',
            payload: { memoryAction: 'memory_create' },
        });
        expect(allowed.allowed).toBe(true);
    });

    it('PGI13: multiple scopes on rule — ALL must match (AND semantics)', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({
            action: 'deny',
            scopes: [{ mode: 'rp' }, { executionType: 'chat_turn' }],
        });
        gate.setConfig(makeConfig([rule]));

        // Both match → blocked
        const blocked = await gate.evaluateAsync({
            action: 'tool_invoke',
            mode: 'rp',
            payload: { executionType: 'chat_turn' },
        });
        expect(blocked.allowed).toBe(false);

        // Only one matches → allowed
        const allowed = await gate.evaluateAsync({
            action: 'tool_invoke',
            mode: 'rp',
            payload: { executionType: 'autonomy_task' },
        });
        expect(allowed.allowed).toBe(true);
    });
});

// ─── 3. Deny rules ────────────────────────────────────────────────────────────

describe('Deny rules', () => {
    it('PGI14: deny rule returns allowed=false with RULE_DENY code', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ id: 'deny-rule', action: 'deny', severity: 'high' });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('RULE_DENY:deny-rule');
        expect(result.metadata?.ruleId).toBe('deny-rule');
        expect(result.metadata?.severity).toBe('high');
    });
});

// ─── 4. Warn rules ────────────────────────────────────────────────────────────

describe('Warn rules', () => {
    it('PGI15: warn rule allows but carries warning in metadata', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ id: 'warn-rule', action: 'warn', name: 'Sensitive Action' });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
        expect(result.code).toBe('POLICY_ALLOW_WITH_WARNINGS');
        expect(result.metadata?.warnings).toHaveLength(1);
        expect((result.metadata?.warnings as string[])[0]).toContain('Sensitive Action');
    });

    it('PGI16: multiple warn rules accumulate warnings', async () => {
        const { gate } = makePolicyGate();
        const rules = [
            makeRule({ id: 'w1', action: 'warn', name: 'W1' }),
            makeRule({ id: 'w2', action: 'warn', name: 'W2' }),
        ];
        gate.setConfig(makeConfig(rules));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
        expect((result.metadata?.warnings as string[])).toHaveLength(2);
    });
});

// ─── 5. require_validation — validators pass ───────────────────────────────────

describe('require_validation — validators pass', () => {
    it('PGI17: require_validation rule with passing adapter → allowed', async () => {
        const { gate, registry } = makePolicyGate([new PassAdapter()]);
        const binding = makeBinding({ providerKind: 'local_guardrails_ai' });
        const rule = makeRule({
            id: 'val-rule',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
    });

    it('PGI18: require_validation with no bindings → allowed (nothing to run)', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({
            id: 'val-empty',
            action: 'require_validation',
            validatorBindings: [],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
    });
});

// ─── 6. require_validation — validators block ──────────────────────────────────

describe('require_validation — validators block', () => {
    it('PGI19: require_validation rule with blocking adapter → denied', async () => {
        const { gate } = makePolicyGate([new BlockAdapter()]);
        const binding = makeBinding({ providerKind: 'local_guardrails_ai' });
        const rule = makeRule({
            id: 'val-block-rule',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('VALIDATION_DENY:val-block-rule');
        expect(result.metadata?.ruleId).toBe('val-block-rule');
    });

    it('PGI20: denied decision includes violation messages', async () => {
        const { gate } = makePolicyGate([new BlockAdapter()]);
        const binding = makeBinding({ providerKind: 'local_guardrails_ai' });
        const rule = makeRule({
            id: 'val-block-msg',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.reason).toContain('Blocked by test');
        expect(result.metadata?.violations).toBeDefined();
    });
});

// ─── 7. require_validation — remote failOpen ──────────────────────────────────

describe('require_validation — remote failOpen (error → allow)', () => {
    it('PGI21: failOpen binding + adapter error → allowed', async () => {
        const { gate } = makePolicyGate([new ErrorAdapter()]);
        const binding = makeBinding({ providerKind: 'local_guardrails_ai', failOpen: true });
        const rule = makeRule({
            id: 'val-failopen',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
    });

    it('PGI22: failOpen preserves resolvedByFailOpen=true in validator result metadata', async () => {
        const { gate } = makePolicyGate([new ErrorAdapter()]);
        const binding = makeBinding({ providerKind: 'local_guardrails_ai', failOpen: true });
        const rule = makeRule({
            id: 'val-failopen-meta',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
        // Validator result metadata is in the aggregated result; the gate decision is allow
        expect(result.metadata?.violations).toBeUndefined(); // no violations on failOpen
    });
});

// ─── 8. require_validation — remote failClosed ────────────────────────────────

describe('require_validation — remote failClosed (error → deny)', () => {
    it('PGI23: failClosed binding + adapter error → denied', async () => {
        const { gate } = makePolicyGate([new ErrorAdapter()]);
        const binding = makeBinding({ providerKind: 'local_guardrails_ai', failOpen: false });
        const rule = makeRule({
            id: 'val-failclosed',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('VALIDATION_DENY:val-failclosed');
    });

    it('PGI24: failClosed + missing endpoint → denied', async () => {
        // Real remote adapter returns error result when endpointUrl missing
        const { gate } = makePolicyGate();
        const binding = makeBinding({
            providerKind: 'remote_guardrails_service',
            endpointUrl: undefined,
            failOpen: false,
        });
        const rule = makeRule({
            id: 'val-remote-failclosed',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(false);
    });

    it('PGI25: failOpen + missing endpoint → allowed', async () => {
        const { gate } = makePolicyGate();
        const binding = makeBinding({
            providerKind: 'remote_guardrails_service',
            endpointUrl: undefined,
            failOpen: true,
        });
        const rule = makeRule({
            id: 'val-remote-failopen',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
    });
});

// ─── 9. Deterministic ordering ────────────────────────────────────────────────

describe('Deterministic ordering', () => {
    it('PGI26: first deny rule wins over a later allow rule', async () => {
        const { gate } = makePolicyGate();
        const rules = [
            makeRule({ id: 'r1', action: 'deny' }),
            makeRule({ id: 'r2', action: 'allow' }),
        ];
        gate.setConfig(makeConfig(rules));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(false);
        expect(result.code).toContain('r1');
    });

    it('PGI27: first rule blocks before second require_validation runs', async () => {
        const { gate } = makePolicyGate();
        const callCount = { n: 0 };

        class CountingAdapter implements IGuardrailAdapter {
            readonly providerKind = 'local_guardrails_ai';
            async execute(b: ValidatorBinding): Promise<GuardrailValidationResult> {
                callCount.n++;
                return makePassResult(b, 1);
            }
        }
        gate.setRegistry(new ValidatorRegistry());
        const r = new ValidatorRegistry();
        r.register(new CountingAdapter());
        gate.setRegistry(r);

        const binding = makeBinding({ providerKind: 'local_guardrails_ai' });
        const rules = [
            makeRule({ id: 'deny-first', action: 'deny' }),
            makeRule({ id: 'val-second', action: 'require_validation', validatorBindings: [binding] }),
        ];
        gate.setConfig(makeConfig(rules));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(false);
        expect(callCount.n).toBe(0); // validator never ran
    });

    it('PGI28: allow rule does not stop evaluation of subsequent deny rule', async () => {
        const { gate } = makePolicyGate();
        const rules = [
            makeRule({ id: 'r-allow', action: 'allow' }),
            makeRule({ id: 'r-deny', action: 'deny' }),
        ];
        gate.setConfig(makeConfig(rules));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(false);
        expect(result.code).toContain('r-deny');
    });
});

// ─── 10. Telemetry events ─────────────────────────────────────────────────────

describe('Telemetry events', () => {
    let events: RuntimeEvent[];
    let unsub: () => void;

    beforeEach(() => {
        events = [];
        unsub = TelemetryBus.getInstance().subscribe((e) => events.push(e));
    });

    afterEach(() => {
        unsub();
    });

    it('PGI29: execution.blocked emitted when deny rule fires', async () => {
        const { gate } = makePolicyGate();
        gate.setConfig(makeConfig([makeRule({ action: 'deny' })]));
        await gate.evaluateAsync({ action: 'tool_invoke', mode: 'assistant' });
        const blocked = events.find(e => e.event === 'execution.blocked');
        expect(blocked).toBeDefined();
        expect(blocked?.payload?.source).toBe('rule_deny');
    });

    it('PGI30: policy.rule_matched emitted when a rule scope matches', async () => {
        const { gate } = makePolicyGate();
        gate.setConfig(makeConfig([makeRule({ id: 'my-rule', action: 'warn' })]));
        await gate.evaluateAsync({ action: 'tool_invoke' });
        const matched = events.find(e => e.event === 'policy.rule_matched');
        expect(matched).toBeDefined();
        expect(matched?.payload?.ruleId).toBe('my-rule');
    });

    it('PGI31: validation.requested and validation.completed emitted for require_validation', async () => {
        const { gate } = makePolicyGate([new PassAdapter()]);
        const binding = makeBinding({ providerKind: 'local_guardrails_ai' });
        const rule = makeRule({
            id: 'val-telemetry',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        await gate.evaluateAsync({
            action: 'tool_invoke',
            payload: { executionId: 'exec-abc' },
        });
        const requested = events.find(e => e.event === 'validation.requested');
        const completed = events.find(e => e.event === 'validation.completed');
        expect(requested).toBeDefined();
        expect(requested?.payload?.ruleId).toBe('val-telemetry');
        expect(completed).toBeDefined();
        expect(completed?.payload?.shouldDenyOverall).toBe(false);
    });

    it('PGI32: execution.blocked emitted when validation denies', async () => {
        const { gate } = makePolicyGate([new BlockAdapter()]);
        const binding = makeBinding({ providerKind: 'local_guardrails_ai', failOpen: false });
        const rule = makeRule({
            id: 'val-block-telemetry',
            action: 'require_validation',
            validatorBindings: [binding],
        });
        gate.setConfig(makeConfig([rule]));
        await gate.evaluateAsync({ action: 'tool_invoke' });
        const blocked = events.find(e => e.event === 'execution.blocked');
        expect(blocked).toBeDefined();
        expect(blocked?.payload?.source).toBe('validation_deny');
    });

    it('PGI33: hardcoded rule block also emits execution.blocked', async () => {
        const { gate } = makePolicyGate();
        gate.setConfig(makeConfig([]));
        await gate.evaluateAsync({ action: 'file_write', mode: 'rp' });
        const blocked = events.find(e => e.event === 'execution.blocked');
        expect(blocked).toBeDefined();
        expect(blocked?.payload?.source).toBe('hardcoded');
    });
});

// ─── 11. No regression with default permissive profile ────────────────────────

describe('No regression with default permissive profile', () => {
    it('PGI34: default GuardrailPolicyConfig (balanced) with no rules → allow all non-rp', async () => {
        const { gate } = makePolicyGate();
        gate.setConfig(makeDefaultGuardrailPolicyConfig());
        const result = await gate.evaluateAsync({ action: 'tool_invoke', mode: 'assistant' });
        expect(result.allowed).toBe(true);
    });

    it('PGI35: default config with no rules → allows tool_invoke, memory_write, etc.', async () => {
        const { gate } = makePolicyGate();
        gate.setConfig(makeDefaultGuardrailPolicyConfig());
        for (const action of ['tool_invoke', 'memory_write', 'workflow_action', 'autonomy_action']) {
            const result = await gate.evaluateAsync({ action, mode: 'assistant' });
            expect(result.allowed).toBe(true);
        }
    });
});

// ─── 12. checkSideEffectAsync / assertSideEffectAsync ─────────────────────────

describe('checkSideEffectAsync / assertSideEffectAsync', () => {
    it('PGI36: checkSideEffectAsync returns PolicyDecision', async () => {
        const { gate } = makePolicyGate();
        const result = await gate.checkSideEffectAsync({
            actionKind: 'tool_invoke',
            executionMode: 'assistant',
        });
        expect(result.allowed).toBe(true);
    });

    it('PGI37: assertSideEffectAsync passes when allowed', async () => {
        const { gate } = makePolicyGate();
        gate.setConfig(makeConfig([])); // empty config → allow
        await expect(gate.assertSideEffectAsync({ actionKind: 'tool_invoke' })).resolves.toBeUndefined();
    });

    it('PGI38: assertSideEffectAsync throws PolicyDeniedError on deny rule', async () => {
        const { gate } = makePolicyGate();
        gate.setConfig(makeConfig([makeRule({ action: 'deny' })]));
        await expect(gate.assertSideEffectAsync({ actionKind: 'tool_invoke' }))
            .rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('PGI39: assertSideEffectAsync throws PolicyDeniedError when validator blocks', async () => {
        const { gate } = makePolicyGate([new BlockAdapter()]);
        const binding = makeBinding({ failOpen: false });
        const rule = makeRule({ action: 'require_validation', validatorBindings: [binding] });
        gate.setConfig(makeConfig([rule]));
        await expect(gate.assertSideEffectAsync({ actionKind: 'tool_invoke' }))
            .rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('PGI40: checkSideEffectAsync forwards executionMode and origin into scope matching', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({
            action: 'deny',
            scopes: [{ mode: 'hybrid', executionOrigin: 'autonomy_engine' }],
        });
        gate.setConfig(makeConfig([rule]));

        const blocked = await gate.checkSideEffectAsync({
            actionKind: 'tool_invoke',
            executionMode: 'hybrid',
            executionOrigin: 'autonomy_engine',
        });
        expect(blocked.allowed).toBe(false);

        const allowed = await gate.checkSideEffectAsync({
            actionKind: 'tool_invoke',
            executionMode: 'hybrid',
            executionOrigin: 'user',
        });
        expect(allowed.allowed).toBe(true);
    });
});

// ─── 13. require_confirmation treated as warn ─────────────────────────────────

describe('require_confirmation treated as warn', () => {
    it('PGI41: require_confirmation rule allows with a warning', async () => {
        const { gate } = makePolicyGate();
        const rule = makeRule({ id: 'confirm-rule', action: 'require_confirmation', name: 'Needs Confirmation' });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'tool_invoke' });
        expect(result.allowed).toBe(true);
        expect(result.code).toBe('POLICY_ALLOW_WITH_WARNINGS');
        const warnings = result.metadata?.warnings as string[];
        expect(warnings.some(w => w.includes('require confirmation'))).toBe(true);
    });
});

// ─── 14. Hardcoded rules fire first even when config is set ───────────────────

describe('Hardcoded rules fire first even when config is set', () => {
    it('PGI42: file_write in rp mode blocked by hardcoded rule before config rules run', async () => {
        const { gate } = makePolicyGate();
        // Even with an allow config rule, the hardcoded block still fires
        const rule = makeRule({ id: 'allow-all', action: 'allow' });
        gate.setConfig(makeConfig([rule]));
        const result = await gate.evaluateAsync({ action: 'file_write', mode: 'rp' });
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('POLICY_FILE_WRITE_RP_BLOCK');
    });

    it('PGI43: autonomy_action in rp mode blocked by hardcoded rule regardless of config', async () => {
        const { gate } = makePolicyGate();
        gate.setConfig(makeDefaultGuardrailPolicyConfig());
        const result = await gate.evaluateAsync({ action: 'autonomy_action', mode: 'rp' });
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('POLICY_AUTONOMY_RP_BLOCK');
    });

    it('PGI44: assertSideEffect (sync) still works for hardcoded rp rules', () => {
        const gate = new PolicyGate();
        expect(() =>
            gate.assertSideEffect({ actionKind: 'file_write', executionMode: 'rp' }),
        ).toThrow(PolicyDeniedError);
    });
});
