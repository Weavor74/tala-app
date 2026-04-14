import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutionCoordinator, type ToolInvocationContext } from '../electron/services/tools/ToolExecutionCoordinator';
import { PolicyDeniedError, type PolicyDecision } from '../electron/services/policy/PolicyGate';

const telemetryEvents: any[] = [];
const checkSideEffectAsyncMock = vi.fn<
    (ctx: unknown, content?: string | Record<string, unknown>) => Promise<PolicyDecision>
>();

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (evt: any) => telemetryEvents.push(evt),
        }),
    },
}));

vi.mock('../electron/services/policy/PolicyGate', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../electron/services/policy/PolicyGate')>();
    return {
        ...actual,
        policyGate: {
            ...actual.policyGate,
            getActiveProfileId: vi.fn(() => 'tool-runtime-test-profile'),
            checkSideEffectAsync: (...args: [unknown, string | Record<string, unknown> | undefined]) =>
                checkSideEffectAsyncMock(...args),
        },
    };
});

type FakeToolCall = { name: string; args?: Record<string, unknown>; ctx?: ToolInvocationContext };

async function runBoundedToolLoop(
    coordinator: ToolExecutionCoordinator,
    calls: FakeToolCall[],
    maxSteps = 8,
) {
    const executed: string[] = [];
    for (let i = 0; i < calls.length && i < maxSteps; i += 1) {
        const call = calls[i];
        const result = await coordinator.executeTool(call.name, call.args ?? {}, undefined, call.ctx);
        executed.push(call.name);
        const payload = result.data as any;
        if (payload && typeof payload === 'object' && payload.requires_llm === false) {
            return { terminated: 'short_circuit', executed };
        }
    }
    return { terminated: calls.length > maxSteps ? 'max_steps' : 'complete', executed };
}

describe('ToolExecution Runtime Loop Integration', () => {
    beforeEach(() => {
        telemetryEvents.length = 0;
        vi.clearAllMocks();
        vi.useRealTimers();
        checkSideEffectAsyncMock.mockResolvedValue({
            allowed: true,
            reason: 'allowed for test',
            code: 'POLICY_DEFAULT_ALLOW',
        });
    });

    it('single allowed tool call completes normally with requested/completed lifecycle and no double execution', async () => {
        const executeTool = vi.fn().mockResolvedValue({ result: 'ok', requires_llm: true, success: true });
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        const out = await coordinator.executeTool('shell_run', { command: 'echo hi' }, undefined, {
            executionId: 'turn-single',
            executionMode: 'assistant',
        });

        expect(out.success).toBe(true);
        expect(executeTool).toHaveBeenCalledTimes(1);
        const toolEvents = telemetryEvents.filter((e) => e.subsystem === 'tools').map((e) => e.event);
        expect(toolEvents).toEqual(['tool.requested', 'tool.completed']);
    });

    it('multiple sequential tool calls complete in valid order and do not poison each other', async () => {
        const executeTool = vi
            .fn()
            .mockResolvedValueOnce({ result: 'a', requires_llm: true, success: true })
            .mockResolvedValueOnce({ result: 'b', requires_llm: true, success: true });
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        await coordinator.executeTool('fs_read_text', { path: 'a.txt' }, undefined, { executionId: 'turn-multi' });
        await coordinator.executeTool('mem0_search', { query: 'a' }, undefined, { executionId: 'turn-multi' });

        expect(executeTool).toHaveBeenNthCalledWith(1, 'fs_read_text', { path: 'a.txt' }, undefined);
        expect(executeTool).toHaveBeenNthCalledWith(2, 'mem0_search', { query: 'a' }, undefined);
        const toolEvents = telemetryEvents
            .filter((e) => e.subsystem === 'tools')
            .map((e) => `${e.event}:${e.payload?.toolName}`);
        expect(toolEvents).toEqual([
            'tool.requested:fs_read_text',
            'tool.completed:fs_read_text',
            'tool.requested:mem0_search',
            'tool.completed:mem0_search',
        ]);
    });

    it('timeout on a tool call is enforced and does not stall the turn indefinitely', async () => {
        vi.useFakeTimers();
        const executeTool = vi.fn().mockImplementation(() => new Promise(() => {}));
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        const pending = coordinator.executeTool('fs_read_text', { path: 'slow.txt' }, undefined, {
            executionId: 'turn-timeout',
            toolTimeoutMs: 25,
        });
        const assertion = expect(pending).rejects.toThrow('timed out');

        await vi.advanceTimersByTimeAsync(30);
        await assertion;
        expect(executeTool).toHaveBeenCalledTimes(1);

        const events = telemetryEvents.filter((e) => e.subsystem === 'tools').map((e) => e.event);
        expect(events).toEqual(['tool.requested', 'tool.failed']);
    });

    it('retry behavior occurs for retry-safe transient failures', async () => {
        const executeTool = vi
            .fn()
            .mockRejectedValueOnce(new Error('ETIMEDOUT transient'))
            .mockResolvedValueOnce({ result: 'ok after retry', requires_llm: true, success: true });
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        const out = await coordinator.executeTool('fs_read_text', { path: 'a.txt' }, undefined, {
            executionId: 'turn-retry',
        });

        expect(out.success).toBe(true);
        expect(executeTool).toHaveBeenCalledTimes(2);
    });

    it('retry stops at configured limit (maxAttempts=2 for retry-safe tools)', async () => {
        const executeTool = vi.fn().mockRejectedValue(new Error('timeout'));
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        await expect(
            coordinator.executeTool('fs_read_text', { path: 'a.txt' }, undefined, { executionId: 'turn-retry-limit' }),
        ).rejects.toThrow('timeout');

        expect(executeTool).toHaveBeenCalledTimes(2);
        const toolEvents = telemetryEvents.filter((e) => e.subsystem === 'tools').map((e) => e.event);
        expect(toolEvents).toEqual(['tool.requested', 'tool.failed']);
    });

    it('repeated failure opens the circuit breaker and blocks further executions for that tool', async () => {
        const executeTool = vi.fn().mockRejectedValue(new Error('boom'));
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        for (let i = 0; i < 3; i += 1) {
            await expect(
                coordinator.executeTool('fs_write_text', { path: `x${i}.txt`, content: 'x' }, undefined, { executionId: `turn-cb-${i}` }),
            ).rejects.toThrow('boom');
        }

        await expect(
            coordinator.executeTool('fs_write_text', { path: 'x4.txt', content: 'x' }, undefined, { executionId: 'turn-cb-4' }),
        ).rejects.toThrow('Circuit open for fs_write_text');

        expect(executeTool).toHaveBeenCalledTimes(3);
    });

    it('circuit breaker recovery path works after reset window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-14T10:00:00.000Z'));

        const executeTool = vi
            .fn()
            .mockRejectedValueOnce(new Error('boom-1'))
            .mockRejectedValueOnce(new Error('boom-2'))
            .mockRejectedValueOnce(new Error('boom-3'))
            .mockResolvedValueOnce({ result: 'recovered', requires_llm: true, success: true })
            .mockResolvedValueOnce({ result: 'healthy', requires_llm: true, success: true });
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        for (let i = 0; i < 3; i += 1) {
            await expect(coordinator.executeTool('shell_run', { command: 'echo x' })).rejects.toThrow(/boom/);
        }
        await expect(coordinator.executeTool('shell_run', { command: 'echo blocked' })).rejects.toThrow('Circuit open');
        expect(executeTool).toHaveBeenCalledTimes(3);

        vi.setSystemTime(new Date('2026-04-14T10:00:16.000Z'));
        const recovered = await coordinator.executeTool('shell_run', { command: 'echo recovered' });
        expect(recovered.success).toBe(true);
        expect(recovered.data).toMatchObject({ result: 'recovered' });

        const followup = await coordinator.executeTool('shell_run', { command: 'echo healthy' });
        expect(followup.success).toBe(true);
        expect(executeTool).toHaveBeenCalledTimes(5);
    });

    it('disallowed tool call is blocked by policy and never reaches execution', async () => {
        checkSideEffectAsyncMock.mockResolvedValueOnce({
            allowed: false,
            reason: 'blocked by policy profile',
            code: 'RULE_DENY:tool-block',
        });
        const executeTool = vi.fn().mockResolvedValue({ result: 'should not run', requires_llm: true, success: true });
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        await expect(
            coordinator.executeTool('fs_write_text', { path: 'x.txt', content: 'x' }, undefined, {
                executionId: 'turn-policy-block',
                executionMode: 'rp',
            }),
        ).rejects.toThrow(PolicyDeniedError);

        expect(checkSideEffectAsyncMock).toHaveBeenCalledTimes(1);
        expect(executeTool).not.toHaveBeenCalled();
        expect(telemetryEvents.some((e) => e.subsystem === 'tools' && e.event === 'tool.requested')).toBe(false);
    });

    it('tool result with requires_llm=false short-circuits bounded loop orchestration', async () => {
        const executeTool = vi
            .fn()
            .mockResolvedValueOnce({ result: 'tool only', requires_llm: false, success: true })
            .mockResolvedValueOnce({ result: 'should never run', requires_llm: true, success: true });
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        const run = await runBoundedToolLoop(coordinator, [
            { name: 'fs_read_text', args: { path: 'one.txt' } },
            { name: 'mem0_search', args: { query: 'unused' } },
        ]);

        expect(run.terminated).toBe('short_circuit');
        expect(run.executed).toEqual(['fs_read_text']);
        expect(executeTool).toHaveBeenCalledTimes(1);
    });

    it('failed tool call emits proper failure lifecycle events and does not poison unrelated future call', async () => {
        const executeTool = vi
            .fn()
            .mockRejectedValueOnce(new Error('first failed'))
            .mockResolvedValueOnce({ result: 'second ok', requires_llm: true, success: true });
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        await expect(coordinator.executeTool('fs_write_text', { path: 'a.txt', content: 'x' })).rejects.toThrow('first failed');
        const second = await coordinator.executeTool('mem0_search', { query: 'ok' });

        expect(second.success).toBe(true);
        const toolEvents = telemetryEvents
            .filter((e) => e.subsystem === 'tools')
            .map((e) => `${e.event}:${e.payload?.toolName}`);
        expect(toolEvents).toEqual([
            'tool.requested:fs_write_text',
            'tool.failed:fs_write_text',
            'tool.requested:mem0_search',
            'tool.completed:mem0_search',
        ]);
    });

    it('orchestration terminates deterministically at bounded max steps (no infinite recursion/re-entry)', async () => {
        const executeTool = vi.fn().mockResolvedValue({ result: 'continue', requires_llm: true, success: true });
        const coordinator = new ToolExecutionCoordinator({ executeTool } as any);

        const calls: FakeToolCall[] = Array.from({ length: 20 }, (_v, i) => ({
            name: i % 2 === 0 ? 'fs_read_text' : 'mem0_search',
            args: i % 2 === 0 ? { path: `f${i}.txt` } : { query: `q${i}` },
        }));
        const run = await runBoundedToolLoop(coordinator, calls, 8);

        expect(run.terminated).toBe('max_steps');
        expect(run.executed).toHaveLength(8);
        expect(executeTool).toHaveBeenCalledTimes(8);
    });
});
