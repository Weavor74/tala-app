/**
 * PolicyGateRule.test.ts
 *
 * Tests for the first concrete PolicyGate enforcement rule:
 *   POLICY_FILE_WRITE_RP_BLOCK — blocks file_write actions when executionMode === 'rp'
 *
 * Validates:
 *   PGR1  Rule fires: evaluate() returns allowed=false for file_write in rp mode
 *   PGR2  Rule is specific: tool_invoke in rp mode is still allowed
 *   PGR3  Rule is mode-scoped: file_write in non-rp modes is allowed
 *   PGR4  Rule is mode-scoped: file_write with no mode set is allowed
 *   PGR5  Rule returns the correct code: POLICY_FILE_WRITE_RP_BLOCK
 *   PGR6  Rule returns the correct reason string
 *   PGR7  checkSideEffect() propagates the block for file_write/rp
 *   PGR8  assertSideEffect() throws PolicyDeniedError for file_write in rp mode
 *   PGR9  assertSideEffect() throws with decision carrying POLICY_FILE_WRITE_RP_BLOCK
 *   PGR10 assertSideEffect() does NOT throw for tool_invoke in rp mode
 *   PGR11 checkSideEffect() returns POLICY_DEFAULT_ALLOW for tool_invoke in rp mode
 *   PGR12 evaluate() falls through to POLICY_DEFAULT_ALLOW for all non-rp file_write variants
 *
 * No DB, no IPC, no Electron.
 */

import { describe, it, expect } from 'vitest';
import {
    PolicyGate,
    PolicyDeniedError,
    policyGate,
    type SideEffectContext,
} from '../electron/services/policy/PolicyGate';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFileWriteCtx(overrides: Partial<SideEffectContext> = {}): SideEffectContext {
    return {
        actionKind: 'file_write',
        executionId: 'exec-rule-01',
        executionType: 'chat_turn',
        executionOrigin: 'ipc',
        executionMode: 'rp',
        capability: 'fs_write_text',
        targetSubsystem: 'ToolService',
        mutationIntent: 'file write: fs_write_text',
        ...overrides,
    };
}

// ─── PGR1–PGR6: evaluate() rule behaviour ────────────────────────────────────

describe('PGR1–PGR6: evaluate() — file_write/rp rule', () => {
    it('PGR1: returns allowed=false for file_write in rp mode', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write', mode: 'rp' });
        expect(decision.allowed).toBe(false);
    });

    it('PGR2: returns allowed=true for tool_invoke in rp mode', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'tool_invoke', mode: 'rp' });
        expect(decision.allowed).toBe(true);
    });

    it('PGR3a: returns allowed=true for file_write in assistant mode', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write', mode: 'assistant' });
        expect(decision.allowed).toBe(true);
    });

    it('PGR3b: returns allowed=true for file_write in hybrid mode', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write', mode: 'hybrid' });
        expect(decision.allowed).toBe(true);
    });

    it('PGR3c: returns allowed=true for file_write in system mode', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write', mode: 'system' });
        expect(decision.allowed).toBe(true);
    });

    it('PGR4: returns allowed=true for file_write with no mode set', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write' });
        expect(decision.allowed).toBe(true);
    });

    it('PGR5: returns code POLICY_FILE_WRITE_RP_BLOCK when rule fires', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write', mode: 'rp' });
        expect(decision.code).toBe('POLICY_FILE_WRITE_RP_BLOCK');
    });

    it('PGR6: returns a reason string containing "file_write" and "rp mode"', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write', mode: 'rp' });
        expect(decision.reason).toContain('file_write');
        expect(decision.reason).toContain('rp mode');
    });
});

// ─── PGR7: checkSideEffect() propagation ─────────────────────────────────────

describe('PGR7: checkSideEffect() propagates file_write/rp block', () => {
    it('returns allowed=false for actionKind=file_write in rp mode', () => {
        const gate = new PolicyGate();
        const decision = gate.checkSideEffect(makeFileWriteCtx({ executionMode: 'rp' }));
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('POLICY_FILE_WRITE_RP_BLOCK');
    });

    it('returns allowed=true for actionKind=file_write in assistant mode', () => {
        const gate = new PolicyGate();
        const decision = gate.checkSideEffect(makeFileWriteCtx({ executionMode: 'assistant' }));
        expect(decision.allowed).toBe(true);
        expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('PGR11: returns POLICY_DEFAULT_ALLOW for tool_invoke in rp mode', () => {
        const gate = new PolicyGate();
        const decision = gate.checkSideEffect({
            actionKind: 'tool_invoke',
            executionMode: 'rp',
            capability: 'shell_run',
        });
        expect(decision.allowed).toBe(true);
        expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
    });
});

// ─── PGR8–PGR10: assertSideEffect() throwing behaviour ───────────────────────

describe('PGR8–PGR10: assertSideEffect() — file_write/rp block throws', () => {
    it('PGR8: throws PolicyDeniedError for file_write in rp mode', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertSideEffect(makeFileWriteCtx({ executionMode: 'rp' }))).toThrow(PolicyDeniedError);
    });

    it('PGR9: thrown error carries decision with POLICY_FILE_WRITE_RP_BLOCK code', () => {
        const gate = new PolicyGate();
        let caught: unknown;
        try {
            gate.assertSideEffect(makeFileWriteCtx({ executionMode: 'rp' }));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.allowed).toBe(false);
        expect(denied.decision.code).toBe('POLICY_FILE_WRITE_RP_BLOCK');
        expect(denied.decision.reason).toContain('rp mode');
    });

    it('PGR10: does NOT throw for tool_invoke in rp mode', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertSideEffect({
            actionKind: 'tool_invoke',
            executionMode: 'rp',
            capability: 'shell_run',
        })).not.toThrow();
    });

    it('does NOT throw for file_write in non-rp modes', () => {
        const gate = new PolicyGate();
        for (const mode of ['assistant', 'hybrid', 'system']) {
            expect(() => gate.assertSideEffect(makeFileWriteCtx({ executionMode: mode }))).not.toThrow();
        }
    });

    it('does NOT throw for file_write with no mode', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertSideEffect({
            actionKind: 'file_write',
        })).not.toThrow();
    });
});

// ─── PGR12: default allow falls through for non-rp file_write ─────────────────

describe('PGR12: evaluate() default-allow fallthrough for non-blocked actions', () => {
    it('returns POLICY_DEFAULT_ALLOW for file_write in assistant mode', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'file_write', mode: 'assistant' });
        expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
        expect(decision.allowed).toBe(true);
    });

    it('returns POLICY_DEFAULT_ALLOW for memory_write in rp mode', () => {
        const gate = new PolicyGate();
        const decision = gate.evaluate({ action: 'memory_write', mode: 'rp' });
        expect(decision.code).toBe('POLICY_DEFAULT_ALLOW');
        expect(decision.allowed).toBe(true);
    });

    it('policyGate singleton also enforces the rule', () => {
        const decision = policyGate.evaluate({ action: 'file_write', mode: 'rp' });
        expect(decision.allowed).toBe(false);
        expect(decision.code).toBe('POLICY_FILE_WRITE_RP_BLOCK');
    });
});
