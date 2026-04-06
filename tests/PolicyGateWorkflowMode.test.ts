/**
 * PolicyGateWorkflowMode.test.ts
 *
 * Tests for executionMode threading through WorkflowEngine.executeWorkflow().
 *
 * Validates that:
 *   - executionMode is forwarded to policyGate.assertSideEffect()
 *   - rp mode causes POLICY_WORKFLOW_RP_BLOCK to fire and block execution
 *   - assistant/system modes allow execution
 *   - omitting executionMode preserves backward compatibility (no error)
 *
 * WM1   executionMode is passed to assertSideEffect when provided
 * WM2   executionMode=rp causes assertSideEffect to receive executionMode=rp
 * WM3   workflow blocked when executionMode=rp (real policyGate — no mock)
 * WM4   blocked decision has code POLICY_WORKFLOW_RP_BLOCK
 * WM5   workflow allowed when executionMode=assistant
 * WM6   workflow allowed when executionMode=system
 * WM7   workflow allowed when executionMode=hybrid
 * WM8   backward compat: executeWorkflow() without executionMode does not throw
 * WM9   backward compat: executionMode=undefined does not throw
 * WM10  no execution occurs when rp-blocked (executeNode not called)
 * WM11  PolicyDeniedError propagates cleanly from executeWorkflow in rp mode
 * WM12  two-node workflow: both nodes receive the same executionMode
 *
 * No DB, no IPC, no Electron.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { policyGate, PolicyDeniedError } from '../electron/services/policy/PolicyGate';

vi.mock('electron', () => ({
    app: { getPath: () => '/tmp/tala-wm-test' },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    ipcMain: { handle: vi.fn() },
}));

vi.mock('imapflow', () => ({}));

import { WorkflowEngine } from '../electron/services/WorkflowEngine';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildEngine() {
    const mockFunctionService = { call: vi.fn().mockResolvedValue('fn-result') } as any;
    const mockAgentService = { chat: vi.fn().mockResolvedValue({ reply: 'ok' }) } as any;
    return new WorkflowEngine(mockFunctionService, mockAgentService);
}

function makeSingleNodeWorkflow(nodeType = 'start') {
    return {
        nodes: [{ id: 'node-1', type: nodeType, data: {}, position: { x: 0, y: 0 } }],
        edges: [],
    };
}

function makeTwoNodeWorkflow() {
    return {
        nodes: [
            { id: 'n1', type: 'start', data: {}, position: { x: 0, y: 0 } },
            { id: 'n2', type: 'merge', data: {}, position: { x: 100, y: 0 } },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
}

// ─── WM1–WM12: executionMode threading tests ──────────────────────────────────

describe('WM1–WM12: WorkflowEngine.executeWorkflow() — executionMode threading', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('WM1: executionMode is forwarded to assertSideEffect when provided', async () => {
        const engine = buildEngine();
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'assistant');

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ executionMode: 'assistant' }),
        );
    });

    it('WM2: executionMode=rp is received by assertSideEffect', async () => {
        const engine = buildEngine();
        // Use a mock so the rp rule doesn't block us here — we just want to verify the value
        const spy = vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {});

        await engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'rp');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.executionMode).toBe('rp');
    });

    it('WM3: workflow is blocked by real policyGate when executionMode=rp', async () => {
        const engine = buildEngine();
        // Real policyGate, no mock — POLICY_WORKFLOW_RP_BLOCK should fire
        await expect(
            engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'rp'),
        ).rejects.toThrow(PolicyDeniedError);
    });

    it('WM4: blocked decision has code POLICY_WORKFLOW_RP_BLOCK', async () => {
        const engine = buildEngine();
        let caught: unknown;
        try {
            await engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'rp');
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.code).toBe('POLICY_WORKFLOW_RP_BLOCK');
    });

    it('WM5: workflow is allowed when executionMode=assistant', async () => {
        const engine = buildEngine();
        await expect(
            engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'assistant'),
        ).resolves.toBeDefined();
    });

    it('WM6: workflow is allowed when executionMode=system', async () => {
        const engine = buildEngine();
        await expect(
            engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'system'),
        ).resolves.toBeDefined();
    });

    it('WM7: workflow is allowed when executionMode=hybrid', async () => {
        const engine = buildEngine();
        await expect(
            engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'hybrid'),
        ).resolves.toBeDefined();
    });

    it('WM8: backward compat — executeWorkflow() with no executionMode arg does not throw', async () => {
        const engine = buildEngine();
        await expect(
            engine.executeWorkflow(makeSingleNodeWorkflow('start')),
        ).resolves.toBeDefined();
    });

    it('WM9: backward compat — executionMode=undefined does not throw', async () => {
        const engine = buildEngine();
        await expect(
            engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, undefined),
        ).resolves.toBeDefined();
    });

    it('WM10: no node execution occurs when rp-blocked (executeNode not called)', async () => {
        const engine = buildEngine();
        const executeNodeSpy = vi.spyOn(engine as any, 'executeNode');

        try {
            await engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'rp');
        } catch (_) {
            // expected
        }

        expect(executeNodeSpy).not.toHaveBeenCalled();
    });

    it('WM11: PolicyDeniedError propagates cleanly from executeWorkflow in rp mode', async () => {
        const engine = buildEngine();
        let caught: unknown;
        try {
            await engine.executeWorkflow(makeSingleNodeWorkflow('start'), undefined, {}, 'rp');
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.reason).toContain('rp mode');
        expect(denied.decision.allowed).toBe(false);
    });

    it('WM12: two-node workflow — both nodes receive the same executionMode', async () => {
        const engine = buildEngine();
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await engine.executeWorkflow(makeTwoNodeWorkflow(), undefined, {}, 'assistant');

        const workflowCalls = spy.mock.calls.filter(c => c[0].actionKind === 'workflow_action');
        expect(workflowCalls.length).toBe(2);
        for (const call of workflowCalls) {
            expect(call[0].executionMode).toBe('assistant');
        }
    });
});
