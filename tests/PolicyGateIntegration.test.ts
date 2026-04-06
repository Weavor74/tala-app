/**
 * PolicyGateIntegration.test.ts
 *
 * Integration tests for the PolicyGate seam inside AgentKernel.
 *
 * Validates:
 *   PG1  Allowed path — execute() proceeds and returns a KernelResult normally
 *   PG2  Allowed path — normal telemetry lifecycle (created → accepted → completed) still fires
 *   PG3  Allowed path — execution state ends as 'completed', not 'blocked'
 *   PG4  Denied path  — execute() throws PolicyDeniedError when gate rejects
 *   PG5  Denied path  — execution state is marked 'blocked' with the block reason
 *   PG6  Denied path  — execution.blocked event is emitted with reason and code
 *   PG7  Denied path  — execution.failed is NOT emitted when policy blocks
 *   PG8  Denied path  — execution.completed is NOT emitted when policy blocks
 *   PG9  Denied path  — PolicyDeniedError carries the originating PolicyDecision
 *   PG10 Block reason is present on both the stored state and the telemetry event
 *
 * No DB, no IPC, no Electron.  policyGate singleton is spied upon to simulate deny decisions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import { PolicyDeniedError, policyGate } from '../electron/services/policy/PolicyGate';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const stubTurnOutput = {
    message: 'response from agent',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat',
} as const;

function makeKernel() {
    const agentStub = { chat: vi.fn().mockResolvedValue(stubTurnOutput) };
    return { kernel: new AgentKernel(agentStub as any), agentStub };
}

/** Subscribes to TelemetryBus and collects all events emitted during a test. */
function captureEvents(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    TelemetryBus.getInstance().subscribe((evt) => events.push(evt));
    return events;
}

// ─── PG1–PG3: Allowed path ────────────────────────────────────────────────────

describe('PG1–PG3: PolicyGate allowed path — normal execution proceeds', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
        // Ensure the real policyGate (stub allow-all) is used — no spy needed.
        vi.restoreAllMocks();
    });

    it('PG1: execute() returns a KernelResult when policy allows', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'hello', origin: 'ipc', executionMode: 'assistant' });
        expect(result).toBeDefined();
        expect(result.meta).toBeDefined();
        expect(result.meta.executionId).toBeTruthy();
        expect(result.executionState).toBeDefined();
    });

    it('PG2: normal telemetry lifecycle fires when policy allows', async () => {
        const { kernel } = makeKernel();
        const events = captureEvents();

        await kernel.execute({ userMessage: 'lifecycle check', origin: 'chat_ui', executionMode: 'assistant' });

        const types = events.map((e) => e.event);
        expect(types).toContain('execution.created');
        expect(types).toContain('execution.accepted');
        expect(types).toContain('execution.completed');
        expect(types).not.toContain('execution.blocked');
        expect(types).not.toContain('execution.failed');
    });

    it('PG3: execution state is completed (not blocked) when policy allows', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'state check', origin: 'ipc', executionMode: 'rp' });
        const stored = kernel.stateStore.get(result.meta.executionId);
        expect(stored?.status).toBe('completed');
        expect(stored?.blockedReason).toBeUndefined();
    });
});

// ─── PG4–PG10: Denied path ────────────────────────────────────────────────────

describe('PG4–PG10: PolicyGate denied path — execution stopped cleanly', () => {
    const BLOCK_REASON = 'execution blocked by test policy rule';
    const BLOCK_CODE = 'TEST_POLICY_DENY';

    beforeEach(() => {
        TelemetryBus._resetForTesting();
        // Spy on policyGate.evaluate() to return a deny decision.
        vi.spyOn(policyGate, 'evaluate').mockReturnValue({
            allowed: false,
            reason: BLOCK_REASON,
            code: BLOCK_CODE,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('PG4: execute() throws PolicyDeniedError when gate denies', async () => {
        const { kernel } = makeKernel();
        await expect(
            kernel.execute({ userMessage: 'blocked turn', origin: 'ipc', executionMode: 'assistant' })
        ).rejects.toThrow(PolicyDeniedError);
    });

    it('PG5: execution state is marked blocked with the block reason', async () => {
        const { kernel } = makeKernel();

        try {
            await kernel.execute({ userMessage: 'blocked turn', origin: 'ipc', executionMode: 'assistant' });
        } catch {
            // expected — PolicyDeniedError
        }

        // Find the blocked entry in the state store.
        const blocked = kernel.stateStore.getByStatus('blocked');
        expect(blocked).toHaveLength(1);
        expect(blocked[0].status).toBe('blocked');
        expect(blocked[0].blockedReason).toBe(BLOCK_REASON);
        expect(blocked[0].completedAt).toBeDefined();
    });

    it('PG6: execution.blocked event is emitted when gate denies', async () => {
        const { kernel } = makeKernel();
        const events = captureEvents();

        try {
            await kernel.execute({ userMessage: 'blocked turn', origin: 'ipc', executionMode: 'assistant' });
        } catch {
            // expected
        }

        const blockedEvt = events.find((e) => e.event === 'execution.blocked');
        expect(blockedEvt).toBeDefined();
        expect(blockedEvt?.subsystem).toBe('kernel');
        expect(blockedEvt?.phase).toBe('classify');
    });

    it('PG7: execution.failed is NOT emitted when policy blocks', async () => {
        const { kernel } = makeKernel();
        const events = captureEvents();

        try {
            await kernel.execute({ userMessage: 'blocked turn', origin: 'ipc', executionMode: 'assistant' });
        } catch {
            // expected
        }

        const failedEvts = events.filter((e) => e.event === 'execution.failed');
        expect(failedEvts).toHaveLength(0);
    });

    it('PG8: execution.completed is NOT emitted when policy blocks', async () => {
        const { kernel } = makeKernel();
        const events = captureEvents();

        try {
            await kernel.execute({ userMessage: 'blocked turn', origin: 'ipc', executionMode: 'assistant' });
        } catch {
            // expected
        }

        const completedEvts = events.filter((e) => e.event === 'execution.completed');
        expect(completedEvts).toHaveLength(0);
    });

    it('PG9: thrown PolicyDeniedError carries the originating PolicyDecision', async () => {
        const { kernel } = makeKernel();
        let caught: unknown;

        try {
            await kernel.execute({ userMessage: 'blocked turn', origin: 'ipc', executionMode: 'assistant' });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(PolicyDeniedError);
        const denied = caught as PolicyDeniedError;
        expect(denied.decision.allowed).toBe(false);
        expect(denied.decision.reason).toBe(BLOCK_REASON);
        expect(denied.decision.code).toBe(BLOCK_CODE);
    });

    it('PG10: block reason is present on both stored state and telemetry event', async () => {
        const { kernel } = makeKernel();
        const events = captureEvents();

        try {
            await kernel.execute({ userMessage: 'blocked turn', origin: 'chat_ui', executionMode: 'rp' });
        } catch {
            // expected
        }

        // State store
        const blocked = kernel.stateStore.getByStatus('blocked');
        expect(blocked[0].blockedReason).toBe(BLOCK_REASON);

        // Telemetry event payload
        const blockedEvt = events.find((e) => e.event === 'execution.blocked');
        expect(blockedEvt?.payload?.blockedReason).toBe(BLOCK_REASON);
        expect(blockedEvt?.payload?.code).toBe(BLOCK_CODE);
    });
});

// ─── PG11: PolicyContext shape passed to policyGate ──────────────────────────

describe('PG11: PolicyGate receives correct context from AgentKernel', () => {
    beforeEach(() => {
        TelemetryBus._resetForTesting();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('policyGate.evaluate() is called with action=execution.admit', async () => {
        const { kernel } = makeKernel();
        const spy = vi.spyOn(policyGate, 'evaluate').mockReturnValue({
            allowed: true,
            reason: 'spy allow',
            code: 'SPY_ALLOW',
        });

        await kernel.execute({ userMessage: 'context check', origin: 'chat_ui', executionMode: 'hybrid' });

        expect(spy).toHaveBeenCalledOnce();
        const ctx = spy.mock.calls[0][0];
        expect(ctx.action).toBe('execution.admit');
        expect(ctx.mode).toBe('hybrid');
        expect(ctx.origin).toBe('chat_ui');
        expect(ctx.payload?.type).toBe('chat_turn');
    });

    it('policyGate.evaluate() receives the executionId in payload', async () => {
        const { kernel } = makeKernel();
        const spy = vi.spyOn(policyGate, 'evaluate').mockReturnValue({
            allowed: true,
            reason: 'spy allow',
        });

        const result = await kernel.execute({ userMessage: 'id check', origin: 'ipc', executionMode: 'assistant' });

        const ctx = spy.mock.calls[0][0];
        expect(ctx.payload?.executionId).toBe(result.meta.executionId);
    });
});
