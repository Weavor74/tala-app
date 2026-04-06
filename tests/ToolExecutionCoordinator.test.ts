/**
 * ToolExecutionCoordinator.test.ts
 *
 * Unit tests for ToolExecutionCoordinator (Phase 3).
 *
 * Covers:
 *   TEC1  – coordinator.executeTool() delegates to ToolService.executeTool()
 *   TEC2  – allowed tool execution succeeds when enforcePolicy is true
 *   TEC3  – blocked tool execution throws PolicyDeniedError when enforcePolicy is true
 *   TEC4  – no policy check when enforcePolicy is omitted/false
 *   TEC5  – execution context fields are forwarded to PolicyGate correctly
 *   TEC6  – allowedNames are forwarded to ToolService unchanged
 *   TEC7  – PolicyDeniedError from coordinator propagates to caller
 *   TEC8  – coordinator passes capability = tool name to PolicyGate
 *   TEC9  – coordinator passes mutationIntent to PolicyGate
 *   TEC10 – tool.requested is emitted before execution
 *   TEC11 – tool.completed is emitted on success
 *   TEC12 – tool.failed is emitted on error
 *   TEC13 – durationMs is captured in result and telemetry payload
 *   TEC14 – normalized result shape matches ToolInvocationResult contract
 *   TEC15 – PolicyDeniedError blocks execution; no telemetry emitted after block
 *   TEC16 – tool error is re-thrown; ToolInvocationResult shape in tool.failed payload
 *
 * No DB, no IPC, no Electron.  Uses vi.mock() stubs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutionCoordinator, type ToolInvocationContext, type ToolInvocationResult } from '../electron/services/tools/ToolExecutionCoordinator';
import { PolicyDeniedError } from '../electron/services/policy/PolicyGate';

// ─── Mock PolicyGate module ───────────────────────────────────────────────────

vi.mock('../electron/services/policy/PolicyGate', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../electron/services/policy/PolicyGate')>();
    return {
        ...actual,
        policyGate: {
            assertSideEffect: vi.fn(),
        },
    };
});

// ─── Mock TelemetryBus ────────────────────────────────────────────────────────

const mockEmit = vi.fn();

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({ emit: mockEmit }),
    },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeToolService(result: any = 'tool-result') {
    return {
        executeTool: vi.fn().mockResolvedValue(result),
    } as any;
}

async function importMockPolicyGate() {
    const mod = await import('../electron/services/policy/PolicyGate');
    return mod.policyGate as { assertSideEffect: ReturnType<typeof vi.fn> };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolExecutionCoordinator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── TEC1 ─────────────────────────────────────────────────────────────────
    it('TEC1 – delegates to ToolService.executeTool() and returns normalized result', async () => {
        const tools = makeToolService('hello');
        const coordinator = new ToolExecutionCoordinator(tools);

        const result = await coordinator.executeTool('my_tool', { key: 'value' });

        expect(tools.executeTool).toHaveBeenCalledOnce();
        expect(tools.executeTool).toHaveBeenCalledWith('my_tool', { key: 'value' }, undefined);
        expect(result.success).toBe(true);
        expect(result.toolName).toBe('my_tool');
        expect(result.data).toBe('hello');
    });

    // ── TEC2 ─────────────────────────────────────────────────────────────────
    it('TEC2 – allowed tool execution succeeds when enforcePolicy is true', async () => {
        const tools = makeToolService({ result: 'ok', requires_llm: false, success: true });
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();
        pg.assertSideEffect.mockReturnValue(undefined); // allow

        const ctx: ToolInvocationContext = {
            executionId: 'turn-123',
            executionMode: 'assistant',
            enforcePolicy: true,
        };
        const result = await coordinator.executeTool('fs_read_text', { path: '/a.txt' }, undefined, ctx);

        expect(pg.assertSideEffect).toHaveBeenCalledOnce();
        expect(tools.executeTool).toHaveBeenCalledOnce();
        expect(result.success).toBe(true);
        expect(result.toolName).toBe('fs_read_text');
        expect(result.data).toEqual({ result: 'ok', requires_llm: false, success: true });
    });

    // ── TEC3 ─────────────────────────────────────────────────────────────────
    it('TEC3 – blocked tool execution throws PolicyDeniedError when enforcePolicy is true', async () => {
        const tools = makeToolService('should-not-reach');
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();
        pg.assertSideEffect.mockImplementation(() => {
            throw new PolicyDeniedError({ allowed: false, reason: 'blocked in rp mode', code: 'POLICY_FILE_WRITE_RP_BLOCK' });
        });

        const ctx: ToolInvocationContext = {
            executionMode: 'rp',
            enforcePolicy: true,
        };

        await expect(
            coordinator.executeTool('fs_write_text', { path: '/a.txt', content: 'x' }, undefined, ctx),
        ).rejects.toThrow(PolicyDeniedError);

        expect(tools.executeTool).not.toHaveBeenCalled();
    });

    // ── TEC4 ─────────────────────────────────────────────────────────────────
    it('TEC4 – no policy check when enforcePolicy is omitted', async () => {
        const tools = makeToolService('result');
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();

        await coordinator.executeTool('any_tool', {});

        expect(pg.assertSideEffect).not.toHaveBeenCalled();
        expect(tools.executeTool).toHaveBeenCalledOnce();
    });

    // ── TEC4b ────────────────────────────────────────────────────────────────
    it('TEC4b – no policy check when enforcePolicy is false', async () => {
        const tools = makeToolService('result');
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();

        await coordinator.executeTool('any_tool', {}, undefined, { enforcePolicy: false });

        expect(pg.assertSideEffect).not.toHaveBeenCalled();
        expect(tools.executeTool).toHaveBeenCalledOnce();
    });

    // ── TEC5 ─────────────────────────────────────────────────────────────────
    it('TEC5 – full execution context fields are forwarded to PolicyGate', async () => {
        const tools = makeToolService('ok');
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();
        pg.assertSideEffect.mockReturnValue(undefined);

        const ctx: ToolInvocationContext = {
            executionId: 'turn-abc',
            executionType: 'chat_turn',
            executionOrigin: 'ipc',
            executionMode: 'assistant',
            enforcePolicy: true,
        };
        await coordinator.executeTool('shell_run', { cmd: 'echo hi' }, undefined, ctx);

        expect(pg.assertSideEffect).toHaveBeenCalledWith(
            expect.objectContaining({
                actionKind: 'tool_invoke',
                executionId: 'turn-abc',
                executionType: 'chat_turn',
                executionOrigin: 'ipc',
                executionMode: 'assistant',
            }),
        );
    });

    // ── TEC6 ─────────────────────────────────────────────────────────────────
    it('TEC6 – allowedNames are forwarded to ToolService unchanged', async () => {
        const tools = makeToolService('result');
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();
        pg.assertSideEffect.mockReturnValue(undefined);

        const allowed = new Set(['fs_read_text']);
        await coordinator.executeTool('fs_read_text', {}, allowed, { enforcePolicy: true, executionMode: 'assistant' });

        expect(tools.executeTool).toHaveBeenCalledWith('fs_read_text', {}, allowed);
    });

    // ── TEC7 ─────────────────────────────────────────────────────────────────
    it('TEC7 – PolicyDeniedError from coordinator propagates to caller unchanged', async () => {
        const tools = makeToolService();
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();
        const denied = new PolicyDeniedError({
            allowed: false,
            reason: 'test denial',
            code: 'TEST_BLOCK',
        });
        pg.assertSideEffect.mockImplementation(() => { throw denied; });

        let caught: unknown;
        try {
            await coordinator.executeTool('blocked_tool', {}, undefined, { enforcePolicy: true });
        } catch (e) {
            caught = e;
        }

        expect(caught).toBe(denied);
    });

    // ── TEC8 ─────────────────────────────────────────────────────────────────
    it('TEC8 – coordinator passes capability = tool name to PolicyGate', async () => {
        const tools = makeToolService('ok');
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();
        pg.assertSideEffect.mockReturnValue(undefined);

        await coordinator.executeTool('mem0_add', { text: 'hi' }, undefined, {
            enforcePolicy: true,
            executionMode: 'assistant',
        });

        expect(pg.assertSideEffect).toHaveBeenCalledWith(
            expect.objectContaining({ capability: 'mem0_add' }),
        );
    });

    // ── TEC9 ─────────────────────────────────────────────────────────────────
    it('TEC9 – coordinator passes mutationIntent to PolicyGate', async () => {
        const tools = makeToolService('ok');
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();
        pg.assertSideEffect.mockReturnValue(undefined);

        await coordinator.executeTool('fs_write_text', { path: '/x' }, undefined, {
            enforcePolicy: true,
            executionMode: 'hybrid',
        });

        expect(pg.assertSideEffect).toHaveBeenCalledWith(
            expect.objectContaining({ mutationIntent: 'tool invocation: fs_write_text' }),
        );
    });

    // ── TEC10 ────────────────────────────────────────────────────────────────
    it('TEC10 – tool.requested is emitted before execution begins', async () => {
        const tools = makeToolService('ok');
        const coordinator = new ToolExecutionCoordinator(tools);

        let requestedBeforeExecution = false;
        tools.executeTool.mockImplementation(() => {
            // Check that tool.requested was already emitted when the tool runs
            requestedBeforeExecution = mockEmit.mock.calls.some(
                ([evt]: [any]) => evt.event === 'tool.requested',
            );
            return Promise.resolve('ok');
        });

        const ctx: ToolInvocationContext = { executionId: 'turn-10', executionMode: 'assistant' };
        await coordinator.executeTool('my_tool', {}, undefined, ctx);

        expect(requestedBeforeExecution).toBe(true);
        const requestedEvent = mockEmit.mock.calls.find(([evt]: [any]) => evt.event === 'tool.requested')?.[0];
        expect(requestedEvent).toBeDefined();
        expect(requestedEvent.executionId).toBe('turn-10');
        expect(requestedEvent.subsystem).toBe('tools');
        expect(requestedEvent.payload?.toolName).toBe('my_tool');
    });

    // ── TEC11 ────────────────────────────────────────────────────────────────
    it('TEC11 – tool.completed is emitted after successful execution', async () => {
        const tools = makeToolService('done');
        const coordinator = new ToolExecutionCoordinator(tools);

        const ctx: ToolInvocationContext = { executionId: 'turn-11', executionMode: 'hybrid' };
        await coordinator.executeTool('fs_read_text', { path: '/a' }, undefined, ctx);

        const completedCall = mockEmit.mock.calls.find(([evt]: [any]) => evt.event === 'tool.completed');
        expect(completedCall).toBeDefined();
        const completedEvent = completedCall![0];
        expect(completedEvent.executionId).toBe('turn-11');
        expect(completedEvent.subsystem).toBe('tools');
        expect(completedEvent.payload?.toolName).toBe('fs_read_text');
        expect(typeof completedEvent.payload?.durationMs).toBe('number');
    });

    // ── TEC12 ────────────────────────────────────────────────────────────────
    it('TEC12 – tool.failed is emitted when ToolService throws', async () => {
        const tools = makeToolService();
        tools.executeTool.mockRejectedValue(new Error('disk error'));
        const coordinator = new ToolExecutionCoordinator(tools);

        const ctx: ToolInvocationContext = { executionId: 'turn-12', executionMode: 'assistant' };
        await expect(coordinator.executeTool('fs_write_text', {}, undefined, ctx)).rejects.toThrow('disk error');

        const failedCall = mockEmit.mock.calls.find(([evt]: [any]) => evt.event === 'tool.failed');
        expect(failedCall).toBeDefined();
        const failedEvent = failedCall![0];
        expect(failedEvent.executionId).toBe('turn-12');
        expect(failedEvent.subsystem).toBe('tools');
        expect(failedEvent.payload?.toolName).toBe('fs_write_text');
        expect(failedEvent.payload?.error).toBe('disk error');
        expect(typeof failedEvent.payload?.durationMs).toBe('number');
    });

    // ── TEC13 ────────────────────────────────────────────────────────────────
    it('TEC13 – durationMs is present in the normalized result and in the telemetry payload', async () => {
        const tools = makeToolService('timed-result');
        const coordinator = new ToolExecutionCoordinator(tools);

        const result: ToolInvocationResult = await coordinator.executeTool('timer_tool', {});

        expect(typeof result.durationMs).toBe('number');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        const completedEvent = mockEmit.mock.calls.find(([evt]: [any]) => evt.event === 'tool.completed')?.[0];
        expect(typeof completedEvent?.payload?.durationMs).toBe('number');
    });

    // ── TEC14 ────────────────────────────────────────────────────────────────
    it('TEC14 – normalized result shape matches ToolInvocationResult on success', async () => {
        const rawData = { result: 'file-contents', requires_llm: false, success: true };
        const tools = makeToolService(rawData);
        const coordinator = new ToolExecutionCoordinator(tools);

        const result: ToolInvocationResult = await coordinator.executeTool('fs_read_text', { path: '/x' });

        expect(result.success).toBe(true);
        expect(result.toolName).toBe('fs_read_text');
        expect(result.data).toEqual(rawData);
        expect(typeof result.durationMs).toBe('number');
        expect(result.error).toBeUndefined();
        expect(result.timedOut).toBeUndefined();
    });

    // ── TEC15 ────────────────────────────────────────────────────────────────
    it('TEC15 – PolicyDeniedError blocks execution; no telemetry emitted after block', async () => {
        const tools = makeToolService('should-not-run');
        const coordinator = new ToolExecutionCoordinator(tools);
        const pg = await importMockPolicyGate();
        pg.assertSideEffect.mockImplementation(() => {
            throw new PolicyDeniedError({ allowed: false, reason: 'rp block', code: 'POLICY_FILE_WRITE_RP_BLOCK' });
        });

        const ctx: ToolInvocationContext = { executionMode: 'rp', enforcePolicy: true };
        await expect(coordinator.executeTool('fs_write_text', {}, undefined, ctx)).rejects.toThrow(PolicyDeniedError);

        // No telemetry at all — policy gate fires before tool.requested
        expect(mockEmit).not.toHaveBeenCalled();
        expect(tools.executeTool).not.toHaveBeenCalled();
    });

    // ── TEC16 ────────────────────────────────────────────────────────────────
    it('TEC16 – tool error is re-thrown and tool.failed payload contains error message', async () => {
        const tools = makeToolService();
        const boom = new Error('network timeout');
        tools.executeTool.mockRejectedValue(boom);
        const coordinator = new ToolExecutionCoordinator(tools);

        let caught: unknown;
        try {
            await coordinator.executeTool('http_get', { url: 'https://x.example' });
        } catch (e) {
            caught = e;
        }

        // Original error is re-thrown unchanged
        expect(caught).toBe(boom);

        // tool.failed payload carries the error message
        const failedEvent = mockEmit.mock.calls.find(([evt]: [any]) => evt.event === 'tool.failed')?.[0];
        expect(failedEvent?.payload?.error).toBe('network timeout');
    });
});


