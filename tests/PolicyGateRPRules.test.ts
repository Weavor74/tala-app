/**
 * PolicyGateRPRules.test.ts
 *
 * Tests for the rp-mode enforcement rules introduced in PolicyGate:
 *   POLICY_AUTONOMY_RP_BLOCK — blocks autonomy_action when executionMode === 'rp'
 *   POLICY_WORKFLOW_RP_BLOCK — blocks workflow_action when executionMode === 'rp'
 *
 * Validates:
 *   PRR1   autonomy_action is allowed in system mode
 *   PRR2   autonomy_action is allowed in assistant mode
 *   PRR3   autonomy_action is allowed in hybrid mode
 *   PRR4   autonomy_action is allowed with no mode set
 *   PRR5   autonomy_action is blocked in rp mode (allowed=false)
 *   PRR6   autonomy_action block returns code POLICY_AUTONOMY_RP_BLOCK
 *   PRR7   autonomy_action block returns a reason containing 'autonomy_action' and 'rp mode'
 *   PRR8   checkSideEffect() propagates the block for autonomy_action/rp
 *   PRR9   assertSideEffect() throws PolicyDeniedError for autonomy_action in rp mode
 *   PRR10  thrown error carries POLICY_AUTONOMY_RP_BLOCK code
 *   PRR11  assertSideEffect() does NOT throw for autonomy_action in non-rp modes
 *   PRR12  workflow_action is allowed in system mode
 *   PRR13  workflow_action is allowed in assistant mode
 *   PRR14  workflow_action is allowed in hybrid mode
 *   PRR15  workflow_action is allowed with no mode set
 *   PRR16  workflow_action is blocked in rp mode (allowed=false)
 *   PRR17  workflow_action block returns code POLICY_WORKFLOW_RP_BLOCK
 *   PRR18  workflow_action block returns a reason containing 'workflow_action' and 'rp mode'
 *   PRR19  checkSideEffect() propagates the block for workflow_action/rp
 *   PRR20  assertSideEffect() throws PolicyDeniedError for workflow_action in rp mode
 *   PRR21  thrown error carries POLICY_WORKFLOW_RP_BLOCK code
 *   PRR22  assertSideEffect() does NOT throw for workflow_action in non-rp modes
 *   PRR23  file_write in rp mode still returns POLICY_FILE_WRITE_RP_BLOCK (no regression)
 *   PRR24  policyGate singleton enforces all three rp-mode blocks
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

function makeAutonomyCtx(overrides: Partial<SideEffectContext> = {}): SideEffectContext {
    return {
        actionKind: 'autonomy_action',
        executionId: 'exec-prr-01',
        executionType: 'autonomy_task',
        executionOrigin: 'autonomy_engine',
        executionMode: 'rp',
        targetSubsystem: 'autonomy',
        mutationIntent: 'execute',
        ...overrides,
    };
}

function makeWorkflowCtx(overrides: Partial<SideEffectContext> = {}): SideEffectContext {
    return {
        actionKind: 'workflow_action',
        executionId: 'exec-prr-02',
        executionType: 'workflow_task',
        executionOrigin: 'workflow_engine',
        executionMode: 'rp',
        targetSubsystem: 'workflow',
        mutationIntent: 'execute node',
        ...overrides,
    };
}

// ─── PRR1–PRR11: autonomy_action rules ────────────────────────────────────────

describe('PRR1–PRR4: autonomy_action is allowed in non-rp modes', () => {
    it('PRR1: allowed in system mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'autonomy_action', mode: 'system' });
        expect(d.allowed).toBe(true);
        expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('PRR2: allowed in assistant mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'autonomy_action', mode: 'assistant' });
        expect(d.allowed).toBe(true);
        expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('PRR3: allowed in hybrid mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'autonomy_action', mode: 'hybrid' });
        expect(d.allowed).toBe(true);
        expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('PRR4: allowed with no mode set', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'autonomy_action' });
        expect(d.allowed).toBe(true);
        expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
    });
});

describe('PRR5–PRR7: autonomy_action is blocked in rp mode', () => {
    it('PRR5: returns allowed=false for autonomy_action in rp mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'autonomy_action', mode: 'rp' });
        expect(d.allowed).toBe(false);
    });

    it('PRR6: returns code POLICY_AUTONOMY_RP_BLOCK', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'autonomy_action', mode: 'rp' });
        expect(d.code).toBe('POLICY_AUTONOMY_RP_BLOCK');
    });

    it('PRR7: returns reason containing "autonomy_action" and "rp mode"', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'autonomy_action', mode: 'rp' });
        expect(d.reason).toContain('autonomy_action');
        expect(d.reason).toContain('rp mode');
    });
});

describe('PRR8–PRR11: checkSideEffect / assertSideEffect for autonomy_action', () => {
    it('PRR8: checkSideEffect() returns allowed=false for autonomy_action in rp mode', () => {
        const gate = new PolicyGate();
        const d = gate.checkSideEffect(makeAutonomyCtx({ executionMode: 'rp' }));
        expect(d.allowed).toBe(false);
        expect(d.code).toBe('POLICY_AUTONOMY_RP_BLOCK');
    });

    it('PRR9: assertSideEffect() throws PolicyDeniedError for autonomy_action in rp mode', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertSideEffect(makeAutonomyCtx({ executionMode: 'rp' }))).toThrow(PolicyDeniedError);
    });

    it('PRR10: thrown error carries decision with POLICY_AUTONOMY_RP_BLOCK code', () => {
        const gate = new PolicyGate();
        let caught: unknown;
        try {
            gate.assertSideEffect(makeAutonomyCtx({ executionMode: 'rp' }));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.allowed).toBe(false);
        expect(denied.decision.code).toBe('POLICY_AUTONOMY_RP_BLOCK');
        expect(denied.decision.reason).toContain('rp mode');
    });

    it('PRR11: assertSideEffect() does NOT throw for autonomy_action in non-rp modes', () => {
        const gate = new PolicyGate();
        for (const mode of ['system', 'assistant', 'hybrid']) {
            expect(() => gate.assertSideEffect(makeAutonomyCtx({ executionMode: mode }))).not.toThrow();
        }
        expect(() => gate.assertSideEffect(makeAutonomyCtx({ executionMode: undefined }))).not.toThrow();
    });
});

// ─── PRR12–PRR22: workflow_action rules ───────────────────────────────────────

describe('PRR12–PRR15: workflow_action is allowed in non-rp modes', () => {
    it('PRR12: allowed in system mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'workflow_action', mode: 'system' });
        expect(d.allowed).toBe(true);
        expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('PRR13: allowed in assistant mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'workflow_action', mode: 'assistant' });
        expect(d.allowed).toBe(true);
        expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('PRR14: allowed in hybrid mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'workflow_action', mode: 'hybrid' });
        expect(d.allowed).toBe(true);
        expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
    });

    it('PRR15: allowed with no mode set', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'workflow_action' });
        expect(d.allowed).toBe(true);
        expect(d.code).toBe('POLICY_DEFAULT_ALLOW');
    });
});

describe('PRR16–PRR18: workflow_action is blocked in rp mode', () => {
    it('PRR16: returns allowed=false for workflow_action in rp mode', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'workflow_action', mode: 'rp' });
        expect(d.allowed).toBe(false);
    });

    it('PRR17: returns code POLICY_WORKFLOW_RP_BLOCK', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'workflow_action', mode: 'rp' });
        expect(d.code).toBe('POLICY_WORKFLOW_RP_BLOCK');
    });

    it('PRR18: returns reason containing "workflow_action" and "rp mode"', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'workflow_action', mode: 'rp' });
        expect(d.reason).toContain('workflow_action');
        expect(d.reason).toContain('rp mode');
    });
});

describe('PRR19–PRR22: checkSideEffect / assertSideEffect for workflow_action', () => {
    it('PRR19: checkSideEffect() returns allowed=false for workflow_action in rp mode', () => {
        const gate = new PolicyGate();
        const d = gate.checkSideEffect(makeWorkflowCtx({ executionMode: 'rp' }));
        expect(d.allowed).toBe(false);
        expect(d.code).toBe('POLICY_WORKFLOW_RP_BLOCK');
    });

    it('PRR20: assertSideEffect() throws PolicyDeniedError for workflow_action in rp mode', () => {
        const gate = new PolicyGate();
        expect(() => gate.assertSideEffect(makeWorkflowCtx({ executionMode: 'rp' }))).toThrow(PolicyDeniedError);
    });

    it('PRR21: thrown error carries decision with POLICY_WORKFLOW_RP_BLOCK code', () => {
        const gate = new PolicyGate();
        let caught: unknown;
        try {
            gate.assertSideEffect(makeWorkflowCtx({ executionMode: 'rp' }));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.allowed).toBe(false);
        expect(denied.decision.code).toBe('POLICY_WORKFLOW_RP_BLOCK');
        expect(denied.decision.reason).toContain('rp mode');
    });

    it('PRR22: assertSideEffect() does NOT throw for workflow_action in non-rp modes', () => {
        const gate = new PolicyGate();
        for (const mode of ['system', 'assistant', 'hybrid']) {
            expect(() => gate.assertSideEffect(makeWorkflowCtx({ executionMode: mode }))).not.toThrow();
        }
        expect(() => gate.assertSideEffect(makeWorkflowCtx({ executionMode: undefined }))).not.toThrow();
    });
});

// ─── PRR23–PRR24: regression and singleton checks ─────────────────────────────

describe('PRR23–PRR24: regression and singleton enforcement', () => {
    it('PRR23: file_write in rp mode still returns POLICY_FILE_WRITE_RP_BLOCK (no regression)', () => {
        const gate = new PolicyGate();
        const d = gate.evaluate({ action: 'file_write', mode: 'rp' });
        expect(d.allowed).toBe(false);
        expect(d.code).toBe('POLICY_FILE_WRITE_RP_BLOCK');
    });

    it('PRR24: policyGate singleton enforces all three rp-mode blocks', () => {
        const autonomy = policyGate.evaluate({ action: 'autonomy_action', mode: 'rp' });
        expect(autonomy.allowed).toBe(false);
        expect(autonomy.code).toBe('POLICY_AUTONOMY_RP_BLOCK');

        const workflow = policyGate.evaluate({ action: 'workflow_action', mode: 'rp' });
        expect(workflow.allowed).toBe(false);
        expect(workflow.code).toBe('POLICY_WORKFLOW_RP_BLOCK');

        const fileWrite = policyGate.evaluate({ action: 'file_write', mode: 'rp' });
        expect(fileWrite.allowed).toBe(false);
        expect(fileWrite.code).toBe('POLICY_FILE_WRITE_RP_BLOCK');
    });
});
