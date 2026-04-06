/**
 * PolicyGateExpanded.test.ts
 *
 * Tests for the expanded PolicyGate surface introduced in Phase 2:
 *   - ExecutionAdmissionContext shape and checkExecution()
 *   - SideEffectContext shape and checkSideEffect()
 *   - assertSideEffect() convenience wrapper
 *   - All side-effect action kinds produce valid decisions
 *   - Typed contexts produce decisions compatible with the existing execution model
 *   - No regression in normal (allow-all) flows
 *   - checkExecution() decision shape aligns with evaluate()
 *   - checkSideEffect() decision shape aligns with evaluate()
 *
 * No DB, no IPC, no Electron.
 * All tests operate on the pure PolicyGate class or the shared singleton.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    PolicyGate,
    PolicyDeniedError,
    policyGate,
    type PolicyDecision,
    type PolicyContext,
    type ExecutionAdmissionContext,
    type SideEffectContext,
    type SideEffectActionKind,
} from '../electron/services/policy/PolicyGate';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAdmissionCtx(overrides: Partial<ExecutionAdmissionContext> = {}): ExecutionAdmissionContext {
    return {
        executionType: 'chat_turn',
        executionOrigin: 'ipc',
        executionMode: 'assistant',
        executionId: 'exec-test-01',
        ...overrides,
    };
}

function makeSideEffectCtx(overrides: Partial<SideEffectContext> = {}): SideEffectContext {
    return {
        actionKind: 'tool_invoke',
        executionId: 'exec-test-01',
        executionType: 'chat_turn',
        executionOrigin: 'ipc',
        executionMode: 'assistant',
        capability: 'fs_read_text',
        targetSubsystem: 'ToolService',
        mutationIntent: 'tool invocation: fs_read_text',
        ...overrides,
    };
}

// ─── PGE1: checkExecution() shape and behavior ────────────────────────────────

describe('PGE1: checkExecution() — typed execution admission', () => {
    it('returns a PolicyDecision for a standard chat_turn admission', () => {
        const gate = new PolicyGate();
        const decision = gate.checkExecution(makeAdmissionCtx());
        expect(decision).toBeDefined();
        expect(typeof decision.allowed).toBe('boolean');
        expect(typeof decision.reason).toBe('string');
    });

    it('returns allowed=true in the stub implementation', () => {
        const gate = new PolicyGate();
        const decision = gate.checkExecution(makeAdmissionCtx({ executionType: 'chat_turn' }));
        expect(decision.allowed).toBe(true);
    });

    it('returns POLICY_DEFAULT_ALLOW code in the stub', () => {
        const gate = new PolicyGate();
        const decision = gate.checkExecution(makeAdmissionCtx());
        expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('reason is always a non-empty string', () => {
        const gate = new PolicyGate();
        const decision = gate.checkExecution(makeAdmissionCtx({ executionType: 'autonomy_task' }));
        expect(decision.reason.length).toBeGreaterThan(0);
    });

    it('accepts autonomy_task execution type', () => {
        const gate = new PolicyGate();
        const decision = gate.checkExecution(makeAdmissionCtx({
            executionType: 'autonomy_task',
            executionOrigin: 'autonomy_engine',
            executionMode: 'system',
        }));
        expect(decision.allowed).toBe(true);
    });

    it('accepts reflection_task execution type', () => {
        const gate = new PolicyGate();
        const decision = gate.checkExecution(makeAdmissionCtx({
            executionType: 'reflection_task',
            executionOrigin: 'system',
            executionMode: 'system',
        }));
        expect(decision.allowed).toBe(true);
    });

    it('accepts execution context with only executionType (all optional fields absent)', () => {
        const gate = new PolicyGate();
        const decision = gate.checkExecution({ executionType: 'chat_turn' });
        expect(decision.allowed).toBe(true);
    });

    it('delegates to evaluate() with action=execution.admit', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkExecution(makeAdmissionCtx({ executionType: 'chat_turn', executionMode: 'rp' }));
        expect(spy).toHaveBeenCalledOnce();
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.action).toBe('execution.admit');
        expect(ctx.mode).toBe('rp');
    });

    it('passes executionId into the evaluate payload', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkExecution(makeAdmissionCtx({ executionId: 'exec-correlation-99' }));
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.payload?.['executionId']).toBe('exec-correlation-99');
    });

    it('passes executionType into the evaluate payload as type', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkExecution(makeAdmissionCtx({ executionType: 'workflow_run' }));
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.payload?.['type']).toBe('workflow_run');
    });
});

// ─── PGE2: checkSideEffect() shape and behavior ───────────────────────────────

describe('PGE2: checkSideEffect() — typed side-effect pre-check', () => {
    it('returns a PolicyDecision for a tool_invoke side effect', () => {
        const gate = new PolicyGate();
        const decision = gate.checkSideEffect(makeSideEffectCtx({ actionKind: 'tool_invoke' }));
        expect(decision).toBeDefined();
        expect(typeof decision.allowed).toBe('boolean');
    });

    it('returns allowed=true in the stub implementation', () => {
        const gate = new PolicyGate();
        const decision = gate.checkSideEffect(makeSideEffectCtx());
        expect(decision.allowed).toBe(true);
    });

    it('returns POLICY_DEFAULT_ALLOW code in the stub', () => {
        const gate = new PolicyGate();
        const decision = gate.checkSideEffect(makeSideEffectCtx());
        expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('reason is always a non-empty string', () => {
        const gate = new PolicyGate();
        const decision = gate.checkSideEffect(makeSideEffectCtx({ actionKind: 'memory_write' }));
        expect(decision.reason.length).toBeGreaterThan(0);
    });

    it('delegates to evaluate() with action=actionKind', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkSideEffect(makeSideEffectCtx({ actionKind: 'file_write' }));
        expect(spy).toHaveBeenCalledOnce();
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.action).toBe('file_write');
    });

    it('passes executionMode as context mode', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkSideEffect(makeSideEffectCtx({ actionKind: 'tool_invoke', executionMode: 'rp' }));
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.mode).toBe('rp');
    });

    it('passes executionOrigin as context origin', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkSideEffect(makeSideEffectCtx({ executionOrigin: 'autonomy_engine' }));
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.origin).toBe('autonomy_engine');
    });

    it('passes executionId into evaluate payload', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkSideEffect(makeSideEffectCtx({ executionId: 'exec-se-42' }));
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.payload?.['executionId']).toBe('exec-se-42');
    });

    it('passes capability into evaluate payload', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkSideEffect(makeSideEffectCtx({ capability: 'shell_run' }));
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.payload?.['capability']).toBe('shell_run');
    });

    it('passes targetSubsystem into evaluate payload', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkSideEffect(makeSideEffectCtx({ targetSubsystem: 'MemoryService' }));
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.payload?.['targetSubsystem']).toBe('MemoryService');
    });

    it('passes mutationIntent into evaluate payload', () => {
        const gate = new PolicyGate();
        const spy = vi.spyOn(gate, 'evaluate');
        gate.checkSideEffect(makeSideEffectCtx({ mutationIntent: 'mem0 write: post-turn memory' }));
        const ctx = spy.mock.calls[0][0] as PolicyContext;
        expect(ctx.payload?.['mutationIntent']).toBe('mem0 write: post-turn memory');
    });

    it('accepts a context with only actionKind specified', () => {
        const gate = new PolicyGate();
        const decision = gate.checkSideEffect({ actionKind: 'memory_write' });
        expect(decision.allowed).toBe(true);
    });
});

// ─── PGE3: all SideEffectActionKind variants ──────────────────────────────────

describe('PGE3: all SideEffectActionKind variants are accepted', () => {
    const allKinds: SideEffectActionKind[] = [
        'tool_invoke',
        'memory_write',
        'file_write',
        'workflow_action',
        'autonomy_action',
    ];

    for (const kind of allKinds) {
        it(`checkSideEffect() returns allowed=true for actionKind='${kind}'`, () => {
            const gate = new PolicyGate();
            const decision = gate.checkSideEffect({ actionKind: kind });
            expect(decision.allowed).toBe(true);
            expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
        });
    }
});

// ─── PGE4: assertSideEffect() ─────────────────────────────────────────────────

describe('PGE4: assertSideEffect() — typed side-effect guard', () => {
    it('does not throw when checkSideEffect returns allowed=true', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertSideEffect(makeSideEffectCtx())).not.toThrow();
    });

    it('throws PolicyDeniedError when checkSideEffect returns allowed=false', () => {
        class DenyingGate extends PolicyGate {
            evaluate(_ctx: PolicyContext): PolicyDecision {
                return { allowed: false, reason: 'side effect blocked by test', code: 'TEST_SE_DENY' };
            }
        }
        const gate = new DenyingGate();
        expect(() => gate.assertSideEffect(makeSideEffectCtx())).toThrow(PolicyDeniedError);
    });

    it('thrown PolicyDeniedError carries the decision from checkSideEffect', () => {
        class DenyingGate extends PolicyGate {
            evaluate(_ctx: PolicyContext): PolicyDecision {
                return { allowed: false, reason: 'tool_invoke blocked in rp mode', code: 'RP_TOOL_DENY' };
            }
        }
        const gate = new DenyingGate();
        let caught: unknown;
        try {
            gate.assertSideEffect(makeSideEffectCtx({ actionKind: 'tool_invoke', executionMode: 'rp' }));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.code).toBe('RP_TOOL_DENY');
        expect(denied.decision.reason).toContain('rp mode');
    });

    it('does not throw for any SideEffectActionKind in the stub', () => {
        const gate = new PolicyGate();
        const kinds: SideEffectActionKind[] = [
            'tool_invoke', 'memory_write', 'file_write', 'workflow_action', 'autonomy_action',
        ];
        for (const kind of kinds) {
            expect(() => gate.assertSideEffect({ actionKind: kind })).not.toThrow();
        }
    });
});

// ─── PGE5: compatibility with the existing execution model ────────────────────

describe('PGE5: compatibility with existing execution model', () => {
    it('checkExecution() for chat_turn produces same result as evaluate() with action=execution.admit', () => {
        const gate = new PolicyGate();
        const viaTyped = gate.checkExecution({
            executionType: 'chat_turn',
            executionMode: 'assistant',
            executionOrigin: 'ipc',
        });
        const viaDirect = gate.evaluate({
            action: 'execution.admit',
            mode: 'assistant',
            origin: 'ipc',
            payload: { type: 'chat_turn', executionId: undefined },
        });
        expect(viaTyped.allowed).toBe(viaDirect.allowed);
        expect(viaTyped.code).toBe(viaDirect.code);
    });

    it('checkSideEffect() for tool_invoke produces same result as evaluate() with action=tool_invoke', () => {
        const gate = new PolicyGate();
        const viaTyped = gate.checkSideEffect({
            actionKind: 'tool_invoke',
            executionMode: 'assistant',
            capability: 'fs_read_text',
        });
        const viaDirect = gate.evaluate({
            action: 'tool_invoke',
            mode: 'assistant',
            origin: undefined,
            payload: {
                executionId: undefined,
                executionType: undefined,
                capability: 'fs_read_text',
                targetSubsystem: undefined,
                mutationIntent: undefined,
            },
        });
        expect(viaTyped.allowed).toBe(viaDirect.allowed);
        expect(viaTyped.code).toBe(viaDirect.code);
    });

    it('existing evaluate() call signature still works unchanged', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'execution.admit', mode: 'assistant', origin: 'ipc' });
        expect(decision.allowed).toBe(true);
        expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('existing assertAllowed() still works unchanged', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertAllowed({ action: 'tool_invoke', mode: 'assistant' })).not.toThrow();
    });

    it('existing isAllowed() still works unchanged', () => {
        const gate = new PolicyGate();
        expect(gate.isAllowed({ action: 'memory_write', mode: 'rp' })).toBe(true);
    });

    it('policyGate singleton exposes checkExecution and checkSideEffect', () => {
        expect(typeof policyGate.checkExecution).toBe('function');
        expect(typeof policyGate.checkSideEffect).toBe('function');
        expect(typeof policyGate.assertSideEffect).toBe('function');
    });
});

// ─── PGE6: no regression — normal flows still complete without error ──────────

describe('PGE6: no regression — normal flows', () => {
    it('checkExecution() does not mutate the input context', () => {
        const gate = new PolicyGate();
        const ctx: ExecutionAdmissionContext = {
            executionType: 'chat_turn',
            executionOrigin: 'ipc',
            executionMode: 'assistant',
            executionId: 'exec-immutable',
        };
        gate.checkExecution(ctx);
        expect(ctx.executionType).toBe('chat_turn');
        expect(ctx.executionId).toBe('exec-immutable');
    });

    it('checkSideEffect() does not mutate the input context', () => {
        const gate = new PolicyGate();
        const ctx: SideEffectContext = {
            actionKind: 'tool_invoke',
            executionMode: 'assistant',
            capability: 'shell_run',
        };
        gate.checkSideEffect(ctx);
        expect(ctx.actionKind).toBe('tool_invoke');
        expect(ctx.capability).toBe('shell_run');
    });

    it('repeated checkExecution() calls produce identical decisions', () => {
        const gate = new PolicyGate();
        const ctx = makeAdmissionCtx();
        const d1 = gate.checkExecution(ctx);
        const d2 = gate.checkExecution(ctx);
        expect(d1.allowed).toBe(d2.allowed);
        expect(d1.code).toBe(d2.code);
        expect(d1.reason).toBe(d2.reason);
    });

    it('repeated checkSideEffect() calls produce identical decisions', () => {
        const gate = new PolicyGate();
        const ctx = makeSideEffectCtx();
        const d1 = gate.checkSideEffect(ctx);
        const d2 = gate.checkSideEffect(ctx);
        expect(d1.allowed).toBe(d2.allowed);
        expect(d1.code).toBe(d2.code);
        expect(d1.reason).toBe(d2.reason);
    });
});
