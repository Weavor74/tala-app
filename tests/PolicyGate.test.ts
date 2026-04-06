/**
 * PolicyGate.test.ts
 *
 * Unit tests for PolicyGate — the lightweight runtime enforcement stub.
 *
 * Validates:
 *   - evaluate() returns a PolicyDecision with allowed=true for any action
 *     in the current stub (default-allow) implementation.
 *   - PolicyDecision shape is always fully populated (allowed, reason, code).
 *   - isAllowed() delegates correctly to evaluate().
 *   - assertAllowed() does not throw when evaluate() returns allowed=true.
 *   - assertAllowed() throws PolicyDeniedError when allowed=false.
 *   - PolicyDeniedError carries the originating decision and a descriptive
 *     message.
 *   - evaluate() is deterministic: same context → same decision.
 *   - Optional PolicyContext fields (mode, origin, payload) are accepted
 *     without errors.
 *   - The module-level singleton (policyGate) is an instance of PolicyGate.
 *
 * No DB, no IPC, no Electron.
 */

import { describe, it, expect } from 'vitest';
import {
    PolicyGate,
    PolicyDeniedError,
    policyGate,
    type PolicyContext,
    type PolicyDecision,
} from '../electron/services/policy/PolicyGate';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
    return {
        action: 'test_action',
        mode: 'assistant',
        origin: 'kernel',
        ...overrides,
    };
}

// ─── Test group 1: evaluate() — default-allow stub ────────────────────────────

describe('PolicyGate.evaluate() — default-allow stub', () => {
    it('returns allowed=true for a standard action', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate(makeContext({ action: 'tool_invoke' }));
        expect(decision.allowed).toBe(true);
    });

    it('always populates reason', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate(makeContext());
        expect(typeof decision.reason).toBe('string');
        expect(decision.reason.length).toBeGreaterThan(0);
    });

    it('always populates code', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate(makeContext());
        expect(decision.code).toBeDefined();
        expect((decision.code as string).length).toBeGreaterThan(0);
    });

    it('returns POLICY_DEFAULT_ALLOW code for all stub decisions', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate(makeContext({ action: 'memory_write' }));
        expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('reason includes the action name', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate(makeContext({ action: 'autonomy_task' }));
        expect(decision.reason).toContain('autonomy_task');
    });
});

// ─── Test group 2: evaluate() — optional context fields ───────────────────────

describe('PolicyGate.evaluate() — optional context fields', () => {
    it('accepts a context with only action specified', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write' });
        expect(decision.allowed).toBe(true);
    });

    it('accepts mode, origin, and payload without error', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({
            action: 'mcp_tool',
            mode: 'rp',
            origin: 'autonomy_engine',
            payload: { toolName: 'shell_run', riskLevel: 'medium' },
        });
        expect(decision.allowed).toBe(true);
    });

    it('treats absent optional fields the same as present ones', () => {
        const gate = new PolicyGate();
        const withExtras = gate.evaluate(makeContext({ mode: 'hybrid', origin: 'mcp' }));
        const withoutExtras = gate.evaluate({ action: 'test_action' });
        expect(withExtras.allowed).toBe(withoutExtras.allowed);
        expect(withExtras.code).toBe(withoutExtras.code);
    });
});

// ─── Test group 3: evaluate() — determinism ───────────────────────────────────

describe('PolicyGate.evaluate() — determinism', () => {
    it('returns identical decisions for the same context called twice', () => {
        const gate = new PolicyGate();
        const ctx = makeContext({ action: 'tool_invoke', mode: 'assistant' });
        const d1 = gate.evaluate(ctx);
        const d2 = gate.evaluate(ctx);
        expect(d1.allowed).toBe(d2.allowed);
        expect(d1.reason).toBe(d2.reason);
        expect(d1.code).toBe(d2.code);
    });

    it('does not mutate the input context', () => {
        const gate = new PolicyGate();
        const ctx: PolicyContext = { action: 'memory_write', mode: 'assistant', origin: 'kernel' };
        gate.evaluate(ctx);
        expect(ctx.action).toBe('memory_write');
        expect(ctx.mode).toBe('assistant');
        expect(ctx.origin).toBe('kernel');
    });
});

// ─── Test group 4: isAllowed() ────────────────────────────────────────────────

describe('PolicyGate.isAllowed()', () => {
    it('returns true when evaluate() returns allowed=true', () => {
        const gate = new PolicyGate();
        expect(gate.isAllowed(makeContext({ action: 'tool_invoke' }))).toBe(true);
    });

    it('returns a boolean, not a PolicyDecision', () => {
        const gate = new PolicyGate();
        const result = gate.isAllowed(makeContext());
        expect(typeof result).toBe('boolean');
    });
});

// ─── Test group 5: assertAllowed() ────────────────────────────────────────────

describe('PolicyGate.assertAllowed()', () => {
    it('does not throw when the action is allowed', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertAllowed(makeContext({ action: 'tool_invoke' }))).not.toThrow();
    });

    it('throws PolicyDeniedError when the gate is overridden to deny', () => {
        // Subclass to simulate a real deny rule without modifying the production class.
        class DenyingGate extends PolicyGate {
            evaluate(_ctx: PolicyContext): PolicyDecision {
                return { allowed: false, reason: 'blocked by test rule', code: 'TEST_DENY' };
            }
        }
        const gate = new DenyingGate();
        expect(() => gate.assertAllowed(makeContext({ action: 'file_write' }))).toThrow(PolicyDeniedError);
    });

    it('thrown PolicyDeniedError carries the decision', () => {
        class DenyingGate extends PolicyGate {
            evaluate(_ctx: PolicyContext): PolicyDecision {
                return { allowed: false, reason: 'blocked by test rule', code: 'TEST_DENY' };
            }
        }
        const gate = new DenyingGate();
        let caught: unknown;
        try {
            gate.assertAllowed(makeContext());
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.allowed).toBe(false);
        expect(denied.decision.code).toBe('TEST_DENY');
    });

    it('thrown PolicyDeniedError has a descriptive message', () => {
        class DenyingGate extends PolicyGate {
            evaluate(_ctx: PolicyContext): PolicyDecision {
                return { allowed: false, reason: 'write not permitted in rp mode', code: 'RP_WRITE_DENIED' };
            }
        }
        const gate = new DenyingGate();
        let caught: unknown;
        try {
            gate.assertAllowed(makeContext());
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const msg = (caught as PolicyDeniedError).message;
        expect(msg).toContain('write not permitted in rp mode');
        expect(msg).toContain('RP_WRITE_DENIED');
    });
});

// ─── Test group 6: PolicyDeniedError ─────────────────────────────────────────

describe('PolicyDeniedError', () => {
    it('is an instance of Error', () => {
        const decision: PolicyDecision = { allowed: false, reason: 'denied', code: 'X' };
        const err = new PolicyDeniedError(decision);
        expect(err).toBeInstanceOf(Error);
    });

    it('name is PolicyDeniedError', () => {
        const decision: PolicyDecision = { allowed: false, reason: 'denied' };
        const err = new PolicyDeniedError(decision);
        expect(err.name).toBe('PolicyDeniedError');
    });

    it('message includes reason when code is absent', () => {
        const decision: PolicyDecision = { allowed: false, reason: 'no code here' };
        const err = new PolicyDeniedError(decision);
        expect(err.message).toContain('no code here');
        expect(err.message).not.toContain('[undefined]');
    });

    it('message includes code when present', () => {
        const decision: PolicyDecision = { allowed: false, reason: 'rule fired', code: 'RULE_X' };
        const err = new PolicyDeniedError(decision);
        expect(err.message).toContain('[RULE_X]');
    });

    it('exposes the original decision on .decision', () => {
        const decision: PolicyDecision = { allowed: false, reason: 'test', code: 'T', metadata: { foo: 'bar' } };
        const err = new PolicyDeniedError(decision);
        expect(err.decision).toBe(decision);
    });
});

// ─── Test group 7: module-level singleton ─────────────────────────────────────

describe('policyGate singleton', () => {
    it('is an instance of PolicyGate', () => {
        expect(policyGate).toBeInstanceOf(PolicyGate);
    });

    it('evaluate() works on the singleton', () => {
        const decision = policyGate.evaluate(makeContext({ action: 'system_check' }));
        expect(decision.allowed).toBe(true);
    });

    it('isAllowed() works on the singleton', () => {
        expect(policyGate.isAllowed(makeContext())).toBe(true);
    });
});
