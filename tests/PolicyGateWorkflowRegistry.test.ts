/**
 * PolicyGateWorkflowRegistry.test.ts
 *
 * Integration tests for PolicyGate enforcement in WorkflowRegistry.executeWorkflow().
 *
 * Validates that policyGate.assertSideEffect() is called before each step's tool
 * execution, that PolicyDeniedError propagates correctly, and that the executionMode
 * parameter is threaded through to the gate check.
 *
 * WRG1   assertSideEffect is called with actionKind='workflow_action'
 * WRG2   assertSideEffect receives targetSubsystem='workflow'
 * WRG3   mutationIntent includes the step tool name (mcp_node_execute:<tool>)
 * WRG4   assertSideEffect is called once per step in a two-step workflow
 * WRG5   blocked step causes executeWorkflow() to reject with PolicyDeniedError
 * WRG6   blocked step prevents toolDef.execute from being called
 * WRG7   PolicyDeniedError propagates with correct decision code
 * WRG8   executionMode is forwarded to assertSideEffect when provided
 * WRG9   executionMode defaults to 'system' when not provided
 * WRG10  rp mode causes POLICY_WORKFLOW_RP_BLOCK to fire (real policyGate, no mock)
 * WRG11  assistant mode does not block execution
 * WRG12  backward compat — executeWorkflow() with no executionMode arg does not throw
 *
 * No DB, no IPC, no Electron.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { policyGate, PolicyDeniedError } from '../electron/services/policy/PolicyGate';
import { WorkflowRegistry } from '../electron/services/router/WorkflowRegistry';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBlockDecision() {
    return { allowed: false, reason: 'blocked by test rule', code: 'TEST_POLICY_BLOCK' };
}

/**
 * Build a WorkflowRegistry backed by a mock ToolService.
 * The mock toolService returns a controllable execute spy for any tool name.
 */
function buildRegistry(executeSpy = vi.fn().mockResolvedValue('ok')) {
    const mockToolService = {
        getToolDefinition: vi.fn().mockReturnValue({ execute: executeSpy }),
    } as any;
    const registry = new WorkflowRegistry(mockToolService);
    return { registry, mockToolService, executeSpy };
}

/**
 * Register a custom single-step workflow that uses the given tool name.
 * Bypasses the default workflows so tests are not tied to real shell commands.
 */
function registerSingleStep(registry: WorkflowRegistry, toolName = 'shell_run') {
    (registry as any).register({
        id: 'test_single',
        name: 'Test Single Step',
        description: 'Test workflow with one step.',
        steps: [
            {
                name: 'Step one',
                tool: toolName,
                getArgs: () => ({ command: 'echo hello' }),
            },
        ],
    });
}

/**
 * Register a custom two-step workflow, both steps using the given tool.
 */
function registerTwoStep(registry: WorkflowRegistry, toolName = 'shell_run') {
    (registry as any).register({
        id: 'test_two',
        name: 'Test Two Steps',
        description: 'Test workflow with two steps.',
        steps: [
            {
                name: 'Step one',
                tool: toolName,
                getArgs: () => ({ command: 'echo step1' }),
            },
            {
                name: 'Step two',
                tool: toolName,
                getArgs: () => ({ command: 'echo step2' }),
            },
        ],
    });
}

// ─── WRG1–WRG12 ───────────────────────────────────────────────────────────────

describe('WRG1–WRG12: WorkflowRegistry.executeWorkflow() — PolicyGate enforcement', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('WRG1: assertSideEffect is called with actionKind=workflow_action', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await registry.executeWorkflow('test_single');

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ actionKind: 'workflow_action' }),
        );
    });

    it('WRG2: assertSideEffect receives targetSubsystem=workflow', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await registry.executeWorkflow('test_single');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.targetSubsystem).toBe('workflow');
    });

    it('WRG3: mutationIntent includes the step tool name as mcp_node_execute:<tool>', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry, 'shell_run');
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await registry.executeWorkflow('test_single');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.mutationIntent).toBe('mcp_node_execute:shell_run');
    });

    it('WRG4: assertSideEffect is called once per step in a two-step workflow', async () => {
        const { registry } = buildRegistry();
        registerTwoStep(registry);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await registry.executeWorkflow('test_two');

        const workflowCalls = spy.mock.calls.filter(c => c[0].actionKind === 'workflow_action');
        expect(workflowCalls.length).toBe(2);
    });

    it('WRG5: blocked step causes executeWorkflow() to reject with PolicyDeniedError', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        await expect(
            registry.executeWorkflow('test_single'),
        ).rejects.toThrow(PolicyDeniedError);
    });

    it('WRG6: blocked step prevents toolDef.execute from being called', async () => {
        const executeSpy = vi.fn().mockResolvedValue('ok');
        const { registry } = buildRegistry(executeSpy);
        registerSingleStep(registry);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        try {
            await registry.executeWorkflow('test_single');
        } catch (_) {
            // expected
        }

        expect(executeSpy).not.toHaveBeenCalled();
    });

    it('WRG7: PolicyDeniedError propagates with correct decision code', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);
        vi.spyOn(policyGate, 'assertSideEffect').mockImplementation(() => {
            throw new PolicyDeniedError(makeBlockDecision());
        });

        let caught: unknown;
        try {
            await registry.executeWorkflow('test_single');
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(PolicyDeniedError);
        expect((caught as PolicyDeniedError).decision.code).toBe('TEST_POLICY_BLOCK');
    });

    it('WRG8: executionMode is forwarded to assertSideEffect when provided', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await registry.executeWorkflow('test_single', {}, 'assistant');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.executionMode).toBe('assistant');
    });

    it('WRG9: executionMode defaults to system when not provided', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);
        const spy = vi.spyOn(policyGate, 'assertSideEffect');

        await registry.executeWorkflow('test_single');

        const ctx = spy.mock.calls[0][0];
        expect(ctx.executionMode).toBe('system');
    });

    it('WRG10: rp mode causes POLICY_WORKFLOW_RP_BLOCK to fire (real policyGate)', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);

        let caught: unknown;
        try {
            await registry.executeWorkflow('test_single', {}, 'rp');
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.code).toBe('POLICY_WORKFLOW_RP_BLOCK');
        expect(denied.decision.allowed).toBe(false);
    });

    it('WRG11: assistant mode does not block execution', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);

        await expect(
            registry.executeWorkflow('test_single', {}, 'assistant'),
        ).resolves.toBeDefined();
    });

    it('WRG12: backward compat — executeWorkflow() with no executionMode does not throw', async () => {
        const { registry } = buildRegistry();
        registerSingleStep(registry);

        await expect(
            registry.executeWorkflow('test_single'),
        ).resolves.toBeDefined();
    });
});
