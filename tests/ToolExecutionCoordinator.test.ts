/**
 * ToolExecutionCoordinator.test.ts
 *
 * Unit tests for ToolExecutionCoordinator (Phase 2).
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
 *
 * No DB, no IPC, no Electron.  Uses vi.mock() stubs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutionCoordinator, type ToolInvocationContext } from '../electron/services/tools/ToolExecutionCoordinator';
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
    it('TEC1 – delegates to ToolService.executeTool() and returns its result', async () => {
        const tools = makeToolService('hello');
        const coordinator = new ToolExecutionCoordinator(tools);

        const result = await coordinator.executeTool('my_tool', { key: 'value' });

        expect(tools.executeTool).toHaveBeenCalledOnce();
        expect(tools.executeTool).toHaveBeenCalledWith('my_tool', { key: 'value' }, undefined);
        expect(result).toBe('hello');
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
        expect(result).toEqual({ result: 'ok', requires_llm: false, success: true });
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
});
