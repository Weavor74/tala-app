/**
 * ExecutionContracts.test.ts
 *
 * Phase 3 — Shared Execution Contract Validation
 *
 * Validates:
 *   EC1  ExecutionType, Origin, Mode, Status shape correctness
 *   EC2  createExecutionRequest factory
 *   EC3  createInitialExecutionState factory
 *   EC4  advanceExecutionState immutability and transition
 *   EC5  finalizeExecutionState terminal marking
 *   EC6  AutonomousRun runtime vocabulary stamps
 *   EC7  PlanRun runtime vocabulary stamp
 *   EC8  AgentKernel request forwarding via KernelRequest fields
 *   EC9  Cross-seam ID correlation
 *   EC10 AgentKernel ExecutionStateStore lifecycle tracking
 *   EC11 AgentKernel TelemetryBus lifecycle emission
 *   EC12 AgentKernel TelemetryBus expanded lifecycle (finalizing + failed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    RuntimeExecutionType,
    RuntimeExecutionOrigin,
    RuntimeExecutionMode,
    RuntimeExecutionStatus,
    ExecutionRequest,
    ExecutionState,
} from '../shared/runtime/executionTypes';
import {
    createExecutionRequest,
    createInitialExecutionState,
    advanceExecutionState,
    finalizeExecutionState,
} from '../shared/runtime/executionHelpers';
import type { AutonomousRun } from '../shared/autonomyTypes';
import type { PlanRun } from '../shared/reflectionPlanTypes';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../electron/services/telemetry/TelemetryBus';

// ─── EC1: Type shape correctness ──────────────────────────────────────────────

describe('EC1: ExecutionType values', () => {
    it('contains all expected RuntimeExecutionType variants', () => {
        const types: RuntimeExecutionType[] = [
            'chat_turn',
            'workflow_run',
            'tool_action',
            'autonomy_task',
            'reflection_task',
            'system_maintenance',
        ];
        expect(types).toHaveLength(6);
        expect(types).toContain('chat_turn');
        expect(types).toContain('autonomy_task');
        expect(types).toContain('reflection_task');
    });

    it('contains all expected RuntimeExecutionOrigin variants', () => {
        const origins: RuntimeExecutionOrigin[] = [
            'chat_ui',
            'ipc',
            'workflow_builder',
            'guardrails_builder',
            'autonomy_engine',
            'system',
            'scheduler',
        ];
        expect(origins).toHaveLength(7);
        expect(origins).toContain('ipc');
        expect(origins).toContain('autonomy_engine');
    });

    it('contains all expected RuntimeExecutionMode variants', () => {
        const modes: RuntimeExecutionMode[] = ['assistant', 'hybrid', 'rp', 'system'];
        expect(modes).toHaveLength(4);
        expect(modes).toContain('assistant');
        expect(modes).toContain('rp');
    });

    it('contains all expected RuntimeExecutionStatus variants', () => {
        const statuses: RuntimeExecutionStatus[] = [
            'created', 'accepted', 'blocked', 'planning',
            'executing', 'finalizing', 'completed', 'failed',
            'cancelled', 'degraded',
        ];
        expect(statuses).toHaveLength(10);
        expect(statuses).toContain('completed');
        expect(statuses).toContain('failed');
        expect(statuses).toContain('degraded');
    });
});

// ─── EC2: createExecutionRequest ─────────────────────────────────────────────

describe('EC2: createExecutionRequest', () => {
    it('creates a request with all required fields', () => {
        const req = createExecutionRequest({
            type: 'chat_turn',
            origin: 'ipc',
            mode: 'assistant',
            actor: 'user',
            input: { message: 'hello' },
        });

        expect(req.executionId).toMatch(/^exec-/);
        expect(req.type).toBe('chat_turn');
        expect(req.origin).toBe('ipc');
        expect(req.mode).toBe('assistant');
        expect(req.actor).toBe('user');
        expect(req.input).toEqual({ message: 'hello' });
        expect(req.metadata).toEqual({});
        expect(req.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('accepts a caller-supplied executionId', () => {
        const req = createExecutionRequest({
            type: 'autonomy_task',
            origin: 'autonomy_engine',
            mode: 'system',
            actor: 'autonomy_engine',
            input: null,
            executionId: 'exec-custom-abc',
        });
        expect(req.executionId).toBe('exec-custom-abc');
    });

    it('accepts a parentExecutionId', () => {
        const parent = createExecutionRequest({
            type: 'autonomy_task',
            origin: 'autonomy_engine',
            mode: 'system',
            actor: 'autonomy_engine',
            input: null,
        });
        const child = createExecutionRequest({
            type: 'tool_action',
            origin: 'autonomy_engine',
            mode: 'system',
            actor: 'autonomy_engine',
            input: null,
            parentExecutionId: parent.executionId,
        });
        expect(child.parentExecutionId).toBe(parent.executionId);
    });

    it('accepts custom metadata', () => {
        const req = createExecutionRequest({
            type: 'reflection_task',
            origin: 'system',
            mode: 'system',
            actor: 'reflection_engine',
            input: null,
            metadata: { subsystemId: 'inference', planRunId: 'run-001' },
        });
        expect(req.metadata).toEqual({ subsystemId: 'inference', planRunId: 'run-001' });
    });

    it('produces unique IDs for distinct calls', () => {
        const a = createExecutionRequest({ type: 'chat_turn', origin: 'ipc', mode: 'assistant', actor: 'user', input: null });
        const b = createExecutionRequest({ type: 'chat_turn', origin: 'ipc', mode: 'assistant', actor: 'user', input: null });
        expect(a.executionId).not.toBe(b.executionId);
    });
});

// ─── EC3: createInitialExecutionState ────────────────────────────────────────

describe('EC3: createInitialExecutionState', () => {
    const req: ExecutionRequest = createExecutionRequest({
        type: 'chat_turn',
        origin: 'ipc',
        mode: 'assistant',
        actor: 'user',
        input: { message: 'hello' },
    });

    it('creates initial state with accepted status and intake phase', () => {
        const state = createInitialExecutionState(req);
        expect(state.executionId).toBe(req.executionId);
        expect(state.type).toBe('chat_turn');
        expect(state.origin).toBe('ipc');
        expect(state.mode).toBe('assistant');
        expect(state.status).toBe('accepted');
        expect(state.phase).toBe('intake');
        expect(state.degraded).toBe(false);
        expect(state.retries).toBe(0);
        expect(state.toolCalls).toEqual([]);
        expect(state.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(state.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(state.completedAt).toBeUndefined();
    });

    it('stamps activeSubsystem when provided', () => {
        const state = createInitialExecutionState(req, 'AgentKernel');
        expect(state.activeSubsystem).toBe('AgentKernel');
    });

    it('omits activeSubsystem when not provided', () => {
        const state = createInitialExecutionState(req);
        expect(state.activeSubsystem).toBeUndefined();
    });
});

// ─── EC4: advanceExecutionState ──────────────────────────────────────────────

describe('EC4: advanceExecutionState', () => {
    it('returns a new object (immutable)', () => {
        const req = createExecutionRequest({ type: 'chat_turn', origin: 'ipc', mode: 'assistant', actor: 'user', input: null });
        const initial = createInitialExecutionState(req);
        const advanced = advanceExecutionState(initial, 'executing', 'delegated_flow');
        expect(advanced).not.toBe(initial);
        expect(initial.status).toBe('accepted');  // original unchanged
    });

    it('updates status and phase', () => {
        const req = createExecutionRequest({ type: 'chat_turn', origin: 'ipc', mode: 'assistant', actor: 'user', input: null });
        const initial = createInitialExecutionState(req);
        const advanced = advanceExecutionState(initial, 'executing', 'delegated_flow');
        expect(advanced.status).toBe('executing');
        expect(advanced.phase).toBe('delegated_flow');
    });

    it('updates updatedAt timestamp', () => {
        const req = createExecutionRequest({ type: 'chat_turn', origin: 'ipc', mode: 'assistant', actor: 'user', input: null });
        const initial = createInitialExecutionState(req);
        const advanced = advanceExecutionState(initial, 'finalizing', 'cleanup');
        expect(advanced.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('preserves all other fields', () => {
        const req = createExecutionRequest({ type: 'chat_turn', origin: 'ipc', mode: 'rp', actor: 'user', input: null });
        const initial = createInitialExecutionState(req, 'AgentKernel');
        const advanced = advanceExecutionState(initial, 'executing', 'tool_dispatch');
        expect(advanced.executionId).toBe(req.executionId);
        expect(advanced.origin).toBe('ipc');
        expect(advanced.mode).toBe('rp');
        expect(advanced.activeSubsystem).toBe('AgentKernel');
        expect(advanced.retries).toBe(0);
    });
});

// ─── EC5: finalizeExecutionState ─────────────────────────────────────────────

describe('EC5: finalizeExecutionState', () => {
    const req = createExecutionRequest({ type: 'chat_turn', origin: 'ipc', mode: 'assistant', actor: 'user', input: null });
    const initial = createInitialExecutionState(req, 'AgentKernel');

    it('marks completed terminal state', () => {
        const final = finalizeExecutionState(initial, { status: 'completed' });
        expect(final.status).toBe('completed');
        expect(final.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(final.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('marks failed terminal state with reason', () => {
        const final = finalizeExecutionState(initial, { status: 'failed', failureReason: 'llm_timeout' });
        expect(final.status).toBe('failed');
        expect(final.failureReason).toBe('llm_timeout');
    });

    it('marks blocked terminal state with reason', () => {
        const final = finalizeExecutionState(initial, { status: 'blocked', blockedReason: 'governance_gate' });
        expect(final.status).toBe('blocked');
        expect(final.blockedReason).toBe('governance_gate');
    });

    it('marks degraded when outcome includes degraded=true', () => {
        const final = finalizeExecutionState(initial, { status: 'degraded', degraded: true });
        expect(final.status).toBe('degraded');
        expect(final.degraded).toBe(true);
    });

    it('returns a new object (immutable)', () => {
        const final = finalizeExecutionState(initial, { status: 'completed' });
        expect(final).not.toBe(initial);
        expect(initial.status).toBe('accepted');
    });

    it('does not set failureReason when not provided', () => {
        const final = finalizeExecutionState(initial, { status: 'completed' });
        expect(final.failureReason).toBeUndefined();
    });
});

// ─── EC6: AutonomousRun runtime vocabulary stamps ─────────────────────────────

describe('EC6: AutonomousRun runtime vocabulary', () => {
    it('accepts runtimeExecutionType and runtimeExecutionOrigin fields', () => {
        const run: AutonomousRun = {
            runId: 'run-001',
            goalId: 'goal-001',
            cycleId: 'cycle-001',
            startedAt: new Date().toISOString(),
            status: 'running',
            subsystemId: 'inference',
            milestones: [],
            // Runtime vocabulary stamps
            runtimeExecutionType: 'autonomy_task',
            runtimeExecutionOrigin: 'autonomy_engine',
        };
        expect(run.runtimeExecutionType).toBe('autonomy_task');
        expect(run.runtimeExecutionOrigin).toBe('autonomy_engine');
    });

    it('allows omitting runtime vocabulary fields (backward-compatible)', () => {
        const run: AutonomousRun = {
            runId: 'run-002',
            goalId: 'goal-002',
            cycleId: 'cycle-002',
            startedAt: new Date().toISOString(),
            status: 'pending',
            subsystemId: 'inference',
            milestones: [],
        };
        expect(run.runtimeExecutionType).toBeUndefined();
        expect(run.runtimeExecutionOrigin).toBeUndefined();
    });

    it('runtime type is always autonomy_task for autonomous runs', () => {
        const type: RuntimeExecutionType = 'autonomy_task';
        const origin: RuntimeExecutionOrigin = 'autonomy_engine';
        expect(type).toBe('autonomy_task');
        expect(origin).toBe('autonomy_engine');
    });
});

// ─── EC7: PlanRun runtime vocabulary stamp ────────────────────────────────────

describe('EC7: PlanRun runtime vocabulary', () => {
    it('accepts runtimeExecutionType field', () => {
        const planRun: Partial<PlanRun> = {
            runId: 'planrun-001',
            runtimeExecutionType: 'reflection_task',
        };
        expect(planRun.runtimeExecutionType).toBe('reflection_task');
    });

    it('allows omitting runtimeExecutionType (backward-compatible)', () => {
        const planRun: Partial<PlanRun> = {
            runId: 'planrun-002',
        };
        expect(planRun.runtimeExecutionType).toBeUndefined();
    });
});

// ─── EC8: KernelRequest mode forwarding ──────────────────────────────────────

describe('EC8: KernelRequest runtime vocabulary fields', () => {
    it('origin and executionMode types are the shared runtime vocabulary', () => {
        // Validate that the shared types work for KernelRequest shapes
        const origin: RuntimeExecutionOrigin = 'ipc';
        const modeAssistant: RuntimeExecutionMode = 'assistant';
        const modeRp: RuntimeExecutionMode = 'rp';
        const modeHybrid: RuntimeExecutionMode = 'hybrid';
        expect(origin).toBe('ipc');
        expect(modeAssistant).toBe('assistant');
        expect(modeRp).toBe('rp');
        expect(modeHybrid).toBe('hybrid');
    });

    it('all Tala agent modes map to valid RuntimeExecutionMode values', () => {
        // The settings activeMode values ('assistant'|'hybrid'|'rp') must be
        // valid RuntimeExecutionMode values — this test guards that invariant.
        const settingsModes = ['assistant', 'hybrid', 'rp'] as const;
        const runtimeModes: RuntimeExecutionMode[] = ['assistant', 'hybrid', 'rp', 'system'];
        for (const m of settingsModes) {
            expect(runtimeModes).toContain(m);
        }
    });
});

// ─── EC9: Cross-seam ID correlation ─────────────────────────────────────────

describe('EC9: Cross-seam ID correlation', () => {
    it('ExecutionRequest and ExecutionState share the same executionId', () => {
        const req = createExecutionRequest({
            type: 'chat_turn',
            origin: 'ipc',
            mode: 'assistant',
            actor: 'user',
            input: null,
        });
        const state = createInitialExecutionState(req, 'AgentKernel');
        expect(state.executionId).toBe(req.executionId);
    });

    it('ExecutionState preserves type/origin/mode from the request', () => {
        const req = createExecutionRequest({
            type: 'autonomy_task',
            origin: 'autonomy_engine',
            mode: 'system',
            actor: 'autonomy_engine',
            input: null,
        });
        const state = createInitialExecutionState(req);
        expect(state.type).toBe(req.type);
        expect(state.origin).toBe(req.origin);
        expect(state.mode).toBe(req.mode);
    });

    it('finalizeExecutionState preserves executionId through the full lifecycle', () => {
        const req = createExecutionRequest({
            type: 'reflection_task',
            origin: 'system',
            mode: 'system',
            actor: 'reflection_engine',
            input: null,
        });
        const initial = createInitialExecutionState(req);
        const running = advanceExecutionState(initial, 'executing', 'planning');
        const final = finalizeExecutionState(running, { status: 'completed' });
        expect(final.executionId).toBe(req.executionId);
    });
});

// ─── EC10: AgentKernel ExecutionStateStore lifecycle tracking ─────────────────

describe('EC10: AgentKernel ExecutionStateStore lifecycle tracking', () => {
    /** Shared stub turn output returned by all default chat() mocks. */
    const stubTurnOutput = {
        message: 'hello',
        artifact: null,
        suppressChatContent: false,
        outputChannel: 'chat',
    } as const;

    function makeKernel() {
        // Minimal AgentService stub — only chat() is called by AgentKernel
        const agentStub = {
            chat: vi.fn().mockResolvedValue(stubTurnOutput),
        };
        const kernel = new AgentKernel(agentStub as any);
        return { kernel, agentStub };
    }

    it('stateStore is exposed and starts empty', () => {
        const { kernel } = makeKernel();
        expect(kernel.stateStore).toBeDefined();
        expect(kernel.stateStore.size).toBe(0);
    });

    it('advances state to executing before delegate, then completed after', async () => {
        const { kernel, agentStub } = makeKernel();
        let stateAtDelegate: any;
        agentStub.chat.mockImplementation(async () => {
            stateAtDelegate = kernel.stateStore.getByStatus('executing')[0];
            return stubTurnOutput;
        });
        await kernel.execute({ userMessage: 'hello', origin: 'ipc', executionMode: 'assistant' });
        expect(stateAtDelegate).toBeDefined();
        expect(stateAtDelegate.status).toBe('executing');
        expect(stateAtDelegate.phase).toBe('delegated_flow');
    });

    it('transitions through planning/classifying before executing', async () => {
        const { kernel, agentStub } = makeKernel();
        // At the point chat() is called, classifyExecution() has already run and
        // advancePhase(planning/classifying) was issued. runDelegatedFlow() then
        // advanced to executing/delegated_flow before calling chat().
        let stateAtDelegate: any;
        agentStub.chat.mockImplementation(async () => {
            stateAtDelegate = kernel.stateStore.getByStatus('executing')[0];
            return stubTurnOutput;
        });
        await kernel.execute({ userMessage: 'classify test', origin: 'ipc', executionMode: 'assistant' });
        // At the delegate point state must already be executing (classifying was completed first)
        expect(stateAtDelegate?.status).toBe('executing');
        expect(stateAtDelegate?.phase).toBe('delegated_flow');
        // Terminal state must be completed
        const stored = kernel.stateStore.get(stateAtDelegate.executionId);
        expect(stored?.status).toBe('completed');
    });

    it('stores a completed ExecutionState after successful execute()', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'test', origin: 'chat_ui', executionMode: 'assistant' });
        const stored = kernel.stateStore.get(result.meta.executionId);
        expect(stored).toBeDefined();
        expect(stored?.status).toBe('completed');
        expect(stored?.completedAt).toBeDefined();
        expect(stored?.executionId).toBe(result.meta.executionId);
    });

    it('passes through finalizing phase before completing', async () => {
        const { kernel, agentStub } = makeKernel();
        let executionId: string | undefined;
        agentStub.chat.mockImplementation(async () => {
            executionId = kernel.stateStore.getByStatus('executing')[0]?.executionId;
            return stubTurnOutput;
        });
        await kernel.execute({ userMessage: 'finalize test' });
        // After execute() the terminal status must be 'completed' (finalizing is a transient phase)
        expect(executionId).toBeDefined();
        const stored = kernel.stateStore.get(executionId!);
        expect(stored?.status).toBe('completed');
        expect(stored?.completedAt).toBeDefined();
    });

    it('KernelResult.executionState matches the stored state', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'test' });
        const stored = kernel.stateStore.get(result.meta.executionId);
        expect(result.executionState.executionId).toBe(stored?.executionId);
        expect(result.executionState.status).toBe(stored?.status);
    });

    it('stores origin and mode from the KernelRequest', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'hi', origin: 'chat_ui', executionMode: 'rp' });
        const stored = kernel.stateStore.get(result.meta.executionId);
        expect(stored?.origin).toBe('chat_ui');
        expect(stored?.mode).toBe('rp');
    });

    it('marks state as failed on pipeline error', async () => {
        const { kernel, agentStub } = makeKernel();
        let executionId: string | undefined;
        agentStub.chat.mockImplementation(async () => {
            executionId = kernel.stateStore.getByStatus('executing')[0]?.executionId;
            throw new Error('llm_timeout');
        });
        try {
            await kernel.execute({ userMessage: 'fail me', origin: 'ipc', executionMode: 'assistant' });
        } catch {
            // expected
        }
        expect(executionId).toBeDefined();
        const stored = kernel.stateStore.get(executionId!);
        expect(stored?.status).toBe('failed');
        expect(stored?.failureReason).toBe('llm_timeout');
        expect(stored?.completedAt).toBeDefined();
    });

    it('accumulates multiple executions in the store', async () => {
        const { kernel } = makeKernel();
        await kernel.execute({ userMessage: 'turn 1' });
        await kernel.execute({ userMessage: 'turn 2' });
        await kernel.execute({ userMessage: 'turn 3' });
        expect(kernel.stateStore.size).toBe(3);
        expect(kernel.stateStore.getByStatus('completed')).toHaveLength(3);
    });
});

// ─── EC11: AgentKernel TelemetryBus lifecycle emission ────────────────────────

describe('EC11: AgentKernel TelemetryBus lifecycle emission', () => {
    const stubTurnOutput = {
        message: 'hello',
        artifact: null,
        suppressChatContent: false,
        outputChannel: 'chat',
    } as const;

    function makeKernel() {
        const agentStub = { chat: vi.fn().mockResolvedValue(stubTurnOutput) };
        return { kernel: new AgentKernel(agentStub as any), agentStub };
    }

    beforeEach(() => {
        TelemetryBus._resetForTesting();
    });

    it('emits execution.created, execution.accepted, execution.completed in order', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'lifecycle test', origin: 'ipc', executionMode: 'assistant' });

        const eventTypes = received.map((e) => e.event);
        expect(eventTypes).toContain('execution.created');
        expect(eventTypes).toContain('execution.accepted');
        expect(eventTypes).toContain('execution.completed');

        const createdIdx = eventTypes.indexOf('execution.created');
        const acceptedIdx = eventTypes.indexOf('execution.accepted');
        const completedIdx = eventTypes.indexOf('execution.completed');
        expect(createdIdx).toBeLessThan(acceptedIdx);
        expect(acceptedIdx).toBeLessThan(completedIdx);
    });

    it('all lifecycle events share the same executionId matching KernelResult.meta', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        const result = await kernel.execute({ userMessage: 'id correlation', origin: 'chat_ui', executionMode: 'assistant' });

        const lifecycleEvents = received.filter((e) =>
            e.event === 'execution.created' ||
            e.event === 'execution.accepted' ||
            e.event === 'execution.completed'
        );
        expect(lifecycleEvents).toHaveLength(3);
        for (const evt of lifecycleEvents) {
            expect(evt.executionId).toBe(result.meta.executionId);
        }
    });

    it('all lifecycle events have subsystem=kernel', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'subsystem check' });

        for (const evt of received) {
            expect(evt.subsystem).toBe('kernel');
        }
    });

    it('execution.created payload carries type, origin, and mode', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'payload test', origin: 'chat_ui', executionMode: 'rp' });

        const created = received.find((e) => e.event === 'execution.created');
        expect(created?.payload).toMatchObject({ type: 'chat_turn', origin: 'chat_ui', mode: 'rp' });
    });

    it('execution.completed payload includes durationMs', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'duration test' });

        const completed = received.find((e) => e.event === 'execution.completed');
        expect(completed?.payload).toHaveProperty('durationMs');
        expect(typeof completed?.payload?.durationMs).toBe('number');
    });

    it('execution.created and execution.accepted both use phase=intake', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'phase check' });

        const created = received.find((e) => e.event === 'execution.created');
        const accepted = received.find((e) => e.event === 'execution.accepted');
        expect(created?.phase).toBe('intake');
        expect(accepted?.phase).toBe('intake');
    });

    it('execution.completed uses phase=finalizing', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'finalize phase check' });

        const completed = received.find((e) => e.event === 'execution.completed');
        expect(completed?.phase).toBe('finalizing');
    });

    it('three separate turns emit three independent sets of lifecycle events', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'turn 1' });
        await kernel.execute({ userMessage: 'turn 2' });
        await kernel.execute({ userMessage: 'turn 3' });

        const created = received.filter((e) => e.event === 'execution.created');
        const accepted = received.filter((e) => e.event === 'execution.accepted');
        const completed = received.filter((e) => e.event === 'execution.completed');
        expect(created).toHaveLength(3);
        expect(accepted).toHaveLength(3);
        expect(completed).toHaveLength(3);

        // All executionIds should be distinct
        const ids = new Set(created.map((e) => e.executionId));
        expect(ids.size).toBe(3);
    });
});

// ─── EC12: AgentKernel TelemetryBus expanded lifecycle (finalizing + failed) ──

describe('EC12: AgentKernel TelemetryBus expanded lifecycle (finalizing + failed)', () => {
    const stubTurnOutput = {
        message: 'hello',
        artifact: null,
        suppressChatContent: false,
        outputChannel: 'chat',
    } as const;

    function makeKernel() {
        const agentStub = { chat: vi.fn().mockResolvedValue(stubTurnOutput) };
        return { kernel: new AgentKernel(agentStub as any), agentStub };
    }

    beforeEach(() => {
        TelemetryBus._resetForTesting();
    });

    it('emits execution.finalizing before execution.completed on success', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'finalizing test' });

        const types = received.map((e) => e.event);
        expect(types).toContain('execution.finalizing');
        expect(types).toContain('execution.completed');

        const finalizingIdx = types.indexOf('execution.finalizing');
        const completedIdx = types.indexOf('execution.completed');
        expect(finalizingIdx).toBeLessThan(completedIdx);
    });

    it('complete success ordering: created → accepted → finalizing → completed', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'full ordering' });

        const types = received.map((e) => e.event);
        const createdIdx = types.indexOf('execution.created');
        const acceptedIdx = types.indexOf('execution.accepted');
        const finalizingIdx = types.indexOf('execution.finalizing');
        const completedIdx = types.indexOf('execution.completed');
        expect(createdIdx).toBeLessThan(acceptedIdx);
        expect(acceptedIdx).toBeLessThan(finalizingIdx);
        expect(finalizingIdx).toBeLessThan(completedIdx);
    });

    it('execution.finalizing carries durationMs in payload', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'finalizing payload test' });

        const finalizing = received.find((e) => e.event === 'execution.finalizing');
        expect(finalizing?.payload).toHaveProperty('durationMs');
        expect(typeof finalizing?.payload?.durationMs).toBe('number');
    });

    it('execution.finalizing uses phase=finalizing', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'finalizing phase label' });

        const finalizing = received.find((e) => e.event === 'execution.finalizing');
        expect(finalizing?.phase).toBe('finalizing');
    });

    it('emits execution.failed when AgentService.chat() throws', async () => {
        const { kernel, agentStub } = makeKernel();
        agentStub.chat.mockRejectedValue(new Error('llm_error'));
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        try {
            await kernel.execute({ userMessage: 'fail test', origin: 'ipc', executionMode: 'assistant' });
        } catch {
            // expected
        }

        const failed = received.find((e) => e.event === 'execution.failed');
        expect(failed).toBeDefined();
    });

    it('execution.failed carries the correct executionId', async () => {
        const { kernel, agentStub } = makeKernel();
        agentStub.chat.mockRejectedValue(new Error('bad_request'));
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        let caughtId: string | undefined;
        try {
            await kernel.execute({ userMessage: 'fail id check' });
        } catch {
            // expected
        }
        // The created event has the executionId
        const created = received.find((e) => e.event === 'execution.created');
        const failed = received.find((e) => e.event === 'execution.failed');
        expect(failed?.executionId).toBeDefined();
        expect(failed?.executionId).toBe(created?.executionId);
    });

    it('execution.failed payload carries failureReason', async () => {
        const { kernel, agentStub } = makeKernel();
        agentStub.chat.mockRejectedValue(new Error('timeout_exceeded'));
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        try {
            await kernel.execute({ userMessage: 'fail payload test' });
        } catch {
            // expected
        }

        const failed = received.find((e) => e.event === 'execution.failed');
        expect(failed?.payload?.failureReason).toBe('timeout_exceeded');
    });

    it('execution.failed uses phase=failed', async () => {
        const { kernel, agentStub } = makeKernel();
        agentStub.chat.mockRejectedValue(new Error('any_error'));
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        try {
            await kernel.execute({ userMessage: 'fail phase label' });
        } catch {
            // expected
        }

        const failed = received.find((e) => e.event === 'execution.failed');
        expect(failed?.phase).toBe('failed');
    });

    it('no execution.failed event is emitted on a successful execution', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        await kernel.execute({ userMessage: 'success run' });

        const failed = received.find((e) => e.event === 'execution.failed');
        expect(failed).toBeUndefined();
    });

    it('no execution.finalizing or execution.completed emitted when execution fails', async () => {
        const { kernel, agentStub } = makeKernel();
        agentStub.chat.mockRejectedValue(new Error('crash'));
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        try {
            await kernel.execute({ userMessage: 'fail no finalize' });
        } catch {
            // expected
        }

        const types = received.map((e) => e.event);
        expect(types).not.toContain('execution.finalizing');
        expect(types).not.toContain('execution.completed');
    });

    it('execution.failed carries subsystem=kernel', async () => {
        const { kernel, agentStub } = makeKernel();
        agentStub.chat.mockRejectedValue(new Error('subsystem_check'));
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((evt) => received.push(evt));

        try {
            await kernel.execute({ userMessage: 'subsystem check' });
        } catch {
            // expected
        }

        const failed = received.find((e) => e.event === 'execution.failed');
        expect(failed?.subsystem).toBe('kernel');
    });
});
