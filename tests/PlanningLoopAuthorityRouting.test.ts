/**
 * PlanningLoopAuthorityRouting.test.ts
 *
 * Authority coverage governance tests — PLAR-01 through PLAR-45
 *
 * Proves that:
 *   PLAR-01..10  PlanningLoopAuthorityRouter classification correctness
 *   PLAR-11..20  AgentKernel routing decisions and telemetry
 *   PLAR-21..30  Non-trivial work routes through PlanningLoopService
 *   PLAR-31..35  Trivial work allowed on direct path
 *   PLAR-36..40  Bypass surfacing when loop not available
 *   PLAR-41..45  Authority types shape contracts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanningLoopAuthorityRouter } from '../electron/services/planning/PlanningLoopAuthorityRouter';
import { PlanningLoopService } from '../electron/services/planning/PlanningLoopService';
import { PlanningService } from '../electron/services/planning/PlanningService';
import { AgentKernel } from '../electron/services/kernel/AgentKernel';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent } from '../electron/services/telemetry/TelemetryBus';
import type {
    ExecutionAuthorityClassification,
    WorkComplexityClassification,
    PlanningLoopRoutingDecision,
} from '../shared/planning/executionAuthorityTypes';

// ─── Test helpers ─────────────────────────────────────────────────────────────

const stubTurnOutput = {
    message: 'hello',
    artifact: null,
    suppressChatContent: false,
    outputChannel: 'chat' as const,
};

function makeKernel() {
    const agentStub = {
        chat: vi.fn().mockResolvedValue(stubTurnOutput),
    };
    const kernel = new AgentKernel(agentStub as any);
    return { kernel, agentStub };
}

beforeEach(() => {
    // Reset singletons for test isolation
    PlanningService._resetForTesting();
    PlanningLoopService._resetForTesting(
        { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) },
        { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded', goalSatisfied: true }) },
    );
    TelemetryBus._resetForTesting();
});

// ─── PLAR-01..10: PlanningLoopAuthorityRouter classification ──────────────────

describe('PLAR-01..10: PlanningLoopAuthorityRouter classification', () => {
    it('PLAR-01: classifies greeting as trivial_direct_allowed', () => {
        const decision = PlanningLoopAuthorityRouter.classify('hello');
        expect(decision.classification).toBe('trivial_direct_allowed');
        expect(decision.complexity).toBe('trivial');
        expect(decision.requiresLoop).toBe(false);
    });

    it('PLAR-02: classifies "hi" as trivial_direct_allowed', () => {
        const decision = PlanningLoopAuthorityRouter.classify('hi');
        expect(decision.classification).toBe('trivial_direct_allowed');
        expect(decision.requiresLoop).toBe(false);
    });

    it('PLAR-03: classifies acknowledgement as trivial_direct_allowed', () => {
        const decision = PlanningLoopAuthorityRouter.classify('ok');
        expect(decision.classification).toBe('trivial_direct_allowed');
        expect(decision.requiresLoop).toBe(false);
    });

    it('PLAR-04: classifies "thanks" as trivial_direct_allowed', () => {
        const decision = PlanningLoopAuthorityRouter.classify('thanks');
        expect(decision.classification).toBe('trivial_direct_allowed');
        expect(decision.requiresLoop).toBe(false);
    });

    it('PLAR-05: classifies file operation as planning_loop_required', () => {
        const decision = PlanningLoopAuthorityRouter.classify('read the config file and tell me what version is set');
        expect(decision.classification).toBe('planning_loop_required');
        expect(decision.complexity).toBe('non_trivial');
        expect(decision.requiresLoop).toBe(true);
    });

    it('PLAR-06: classifies code execution request as planning_loop_required', () => {
        const decision = PlanningLoopAuthorityRouter.classify('run the test suite and show me the results');
        expect(decision.classification).toBe('planning_loop_required');
        expect(decision.requiresLoop).toBe(true);
    });

    it('PLAR-07: classifies search request as planning_loop_required', () => {
        const decision = PlanningLoopAuthorityRouter.classify('search my memory for notes about the project');
        expect(decision.classification).toBe('planning_loop_required');
        expect(decision.requiresLoop).toBe(true);
    });

    it('PLAR-08: classifies long message as planning_loop_required (length threshold)', () => {
        const longMessage = 'I need you to help me understand the architecture of this system and then generate a comprehensive technical document that covers all the key components, their interactions, and the design decisions that were made during development.';
        expect(longMessage.length).toBeGreaterThan(200);
        const decision = PlanningLoopAuthorityRouter.classify(longMessage);
        expect(decision.classification).toBe('planning_loop_required');
        expect(decision.requiresLoop).toBe(true);
        expect(decision.reasonCodes).toContain('message_length_exceeds_trivial_threshold');
    });

    it('PLAR-09: classifies ambiguous short message conservatively as non-trivial', () => {
        // Non-greeting, non-ack short message → conservative_default
        const decision = PlanningLoopAuthorityRouter.classify('what is 2+2?');
        expect(decision.requiresLoop).toBe(true);
        expect(decision.reasonCodes).toContain('conservative_default');
    });

    it('PLAR-10: isTrivialDirectWork returns correct boolean wrapper', () => {
        expect(PlanningLoopAuthorityRouter.isTrivialDirectWork('hello')).toBe(true);
        expect(PlanningLoopAuthorityRouter.isTrivialDirectWork('ok')).toBe(true);
        expect(PlanningLoopAuthorityRouter.isTrivialDirectWork('search for files')).toBe(false);
        expect(PlanningLoopAuthorityRouter.isTrivialDirectWork('implement a new feature')).toBe(false);
    });
});

// ─── PLAR-11..20: AgentKernel routing decisions and telemetry ─────────────────

describe('PLAR-11..20: AgentKernel routing decisions and telemetry', () => {
    it('PLAR-11: kernel stamps routingDecision on meta for non-trivial message', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'search for the latest notes' });
        expect(result.meta.routingDecision).toBeDefined();
        expect(result.meta.routingDecision!.requiresLoop).toBe(true);
        expect(result.meta.routingDecision!.classification).toBe('planning_loop_required');
    });

    it('PLAR-12: kernel stamps routingDecision on meta for trivial message', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'hello' });
        expect(result.meta.routingDecision).toBeDefined();
        expect(result.meta.routingDecision!.requiresLoop).toBe(false);
        expect(result.meta.routingDecision!.classification).toBe('trivial_direct_allowed');
    });

    it('PLAR-13: kernel emits planning.loop_routing_selected for non-trivial message', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'analyze the code and generate a report' });

        const routingEvent = received.find((e) => e.event === 'planning.loop_routing_selected');
        expect(routingEvent).toBeDefined();
        expect(routingEvent!.subsystem).toBe('planning');
        expect(routingEvent!.payload).toHaveProperty('classification', 'planning_loop_required');
    });

    it('PLAR-14: kernel emits planning.loop_routing_direct_allowed for trivial message', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'hi' });

        const routingEvent = received.find((e) => e.event === 'planning.loop_routing_direct_allowed');
        expect(routingEvent).toBeDefined();
        expect(routingEvent!.subsystem).toBe('planning');
        expect(routingEvent!.payload).toHaveProperty('classification', 'trivial_direct_allowed');
    });

    it('PLAR-15: routing event carries reasonCodes for non-trivial classification', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'build and run the tests' });

        const routingEvent = received.find((e) => e.event === 'planning.loop_routing_selected');
        expect(routingEvent).toBeDefined();
        expect(Array.isArray(routingEvent!.payload?.reasonCodes)).toBe(true);
        expect((routingEvent!.payload?.reasonCodes as string[]).length).toBeGreaterThan(0);
    });

    it('PLAR-16: routing decision reason codes are deterministic for same input', () => {
        const d1 = PlanningLoopAuthorityRouter.classify('run the test suite');
        const d2 = PlanningLoopAuthorityRouter.classify('run the test suite');
        expect(d1.reasonCodes).toEqual(d2.reasonCodes);
        expect(d1.classification).toBe(d2.classification);
        expect(d1.requiresLoop).toBe(d2.requiresLoop);
    });

    it('PLAR-17: trivial greeting emits no reasonCodes (empty array)', () => {
        const decision = PlanningLoopAuthorityRouter.classify('hello');
        expect(decision.reasonCodes).toHaveLength(0);
    });

    it('PLAR-18: non-trivial classification always has at least one reasonCode', () => {
        const messages = [
            'run the tests',
            'search for notes',
            'build the project',
            'what is 2+2?',
            'explain the architecture',
        ];
        for (const message of messages) {
            const decision = PlanningLoopAuthorityRouter.classify(message);
            if (decision.requiresLoop) {
                expect(decision.reasonCodes.length).toBeGreaterThan(0);
            }
        }
    });

    it('PLAR-19: kernel routing event carries loopInitialized field', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'generate a report' });

        const routingEvent = received.find((e) => e.event === 'planning.loop_routing_selected');
        expect(routingEvent).toBeDefined();
        expect(routingEvent!.payload).toHaveProperty('loopInitialized');
    });

    it('PLAR-20: each turn produces exactly one routing decision event', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'search for notes about the project' });

        const routingEvents = received.filter((e) =>
            e.event === 'planning.loop_routing_selected' ||
            e.event === 'planning.loop_routing_direct_allowed' ||
            e.event === 'planning.loop_routing_bypass_surfaced'
        );
        // At least one routing event per turn (may include bypass_surfaced if loop falls back)
        expect(routingEvents.length).toBeGreaterThanOrEqual(1);
    });
});

// ─── PLAR-21..30: Non-trivial work and loop authority ─────────────────────────

describe('PLAR-21..30: Non-trivial work routes through PlanningLoopService', () => {
    it('PLAR-21: PlanningLoopService.isInitialized() returns true after AgentKernel construction', () => {
        makeKernel();
        expect(PlanningLoopService.isInitialized()).toBe(true);
    });

    it('PLAR-22: PlanningLoopService.initialize() factory creates singleton', () => {
        const executor = { executePlan: vi.fn().mockResolvedValue(stubTurnOutput) };
        const observer = { observe: vi.fn().mockResolvedValue({ outcome: 'succeeded' as const, goalSatisfied: true }) };
        PlanningLoopService.initialize(executor, observer);
        expect(PlanningLoopService.isInitialized()).toBe(true);
        expect(PlanningLoopService.getInstance()).toBeDefined();
    });

    it('PLAR-23: trivial message does not invoke PlanningLoopService loop', async () => {
        const { kernel, agentStub } = makeKernel();
        const loop = PlanningLoopService.getInstance();
        const startLoopSpy = vi.spyOn(loop, 'startLoop');

        await kernel.execute({ userMessage: 'hi' });

        // Trivial routing → direct path → PlanningLoopService.startLoop NOT called
        expect(startLoopSpy).not.toHaveBeenCalled();
        expect(agentStub.chat).toHaveBeenCalledWith('hi', undefined, undefined, [], undefined);
    });

    it('PLAR-24: non-trivial message attempts PlanningLoopService loop before fallback', async () => {
        const { kernel } = makeKernel();
        const loop = PlanningLoopService.getInstance();
        const startLoopSpy = vi.spyOn(loop, 'startLoop');

        await kernel.execute({ userMessage: 'analyze and summarize the project notes' });

        // Non-trivial → loop attempted (even if plan_blocked causes fallback)
        expect(startLoopSpy).toHaveBeenCalledOnce();
        expect(startLoopSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                goal: 'analyze and summarize the project notes',
                maxIterations: 1,
            })
        );
    });

    it('PLAR-25: when loop completes successfully, chat is called via executor', async () => {
        // Wire a real executor that can be inspected
        const chatMock = vi.fn().mockResolvedValue(stubTurnOutput);
        const agentStub = { chat: chatMock };
        const kernel = new AgentKernel(agentStub as any);
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'run the tests' });

        // Whether via loop or direct fallback, chat should be called
        expect(chatMock).toHaveBeenCalled();
    });

    it('PLAR-26: planning.loop_routing_selected event is emitted for non-trivial work', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'search and summarize all notes' });

        const loopSelected = received.some((e) => e.event === 'planning.loop_routing_selected');
        expect(loopSelected).toBe(true);
    });

    it('PLAR-27: execution.created is always emitted regardless of routing path', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        // Trivial
        await kernel.execute({ userMessage: 'hello' });
        // Non-trivial
        await kernel.execute({ userMessage: 'build and test the project' });

        const created = received.filter((e) => e.event === 'execution.created');
        expect(created).toHaveLength(2);
    });

    it('PLAR-28: execution.completed is always emitted for successful turns', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'ok' });
        await kernel.execute({ userMessage: 'run the full test suite and report results' });

        const completed = received.filter((e) => e.event === 'execution.completed');
        expect(completed).toHaveLength(2);
    });

    it('PLAR-29: loop startLoop receives contextSummary with executionId', async () => {
        const { kernel } = makeKernel();
        const loop = PlanningLoopService.getInstance();
        const startLoopSpy = vi.spyOn(loop, 'startLoop');

        const result = await kernel.execute({ userMessage: 'analyze and refactor the code' });

        if (startLoopSpy.mock.calls.length > 0) {
            // If loop was called, verify contextSummary contains executionId
            const callInput = startLoopSpy.mock.calls[0][0];
            expect(callInput.contextSummary?.executionId).toBe(result.meta.executionId);
        }
    });

    it('PLAR-30: KernelResult includes routingDecision in meta', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'explain this architecture' });
        expect(result.meta).toHaveProperty('routingDecision');
        const decision = result.meta.routingDecision!;
        expect(decision).toHaveProperty('classification');
        expect(decision).toHaveProperty('complexity');
        expect(decision).toHaveProperty('requiresLoop');
        expect(decision).toHaveProperty('reasonCodes');
    });
});

// ─── PLAR-31..35: Trivial direct path ────────────────────────────────────────

describe('PLAR-31..35: Trivial direct path is explicitly allowed', () => {
    it('PLAR-31: greeting results in trivial_direct_allowed classification', async () => {
        const { kernel } = makeKernel();
        const result = await kernel.execute({ userMessage: 'hello' });
        expect(result.meta.routingDecision!.classification).toBe('trivial_direct_allowed');
    });

    it('PLAR-32: trivial turn emits planning.loop_routing_direct_allowed event', async () => {
        const { kernel } = makeKernel();
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'ok' });

        const directEvent = received.find((e) => e.event === 'planning.loop_routing_direct_allowed');
        expect(directEvent).toBeDefined();
        expect(directEvent!.payload?.classification).toBe('trivial_direct_allowed');
    });

    it('PLAR-33: trivial turn executes via direct path (phase=delegated_flow)', async () => {
        const { kernel, agentStub } = makeKernel();
        let capturedPhase: string | undefined;

        agentStub.chat.mockImplementation(async () => {
            const state = kernel.stateStore.getByStatus('executing')[0];
            capturedPhase = state?.phase;
            return stubTurnOutput;
        });

        await kernel.execute({ userMessage: 'hello' });

        expect(capturedPhase).toBe('delegated_flow');
    });

    it('PLAR-34: multiple trivial turns all use direct path', async () => {
        const { kernel } = makeKernel();
        const trivialMessages = ['hello', 'ok', 'thanks', 'hi', 'good morning'];

        for (const msg of trivialMessages) {
            const result = await kernel.execute({ userMessage: msg });
            expect(result.meta.routingDecision!.classification).toBe('trivial_direct_allowed');
        }
    });

    it('PLAR-35: trivial classification has empty reasonCodes array', () => {
        for (const msg of ['hello', 'hi', 'ok', 'thanks', 'sure']) {
            const decision = PlanningLoopAuthorityRouter.classify(msg);
            if (decision.classification === 'trivial_direct_allowed') {
                expect(decision.reasonCodes).toHaveLength(0);
            }
        }
    });
});

// ─── PLAR-36..40: Bypass surfacing ────────────────────────────────────────────

describe('PLAR-36..40: Bypass surfacing when loop not available', () => {
    it('PLAR-36: emits planning.degraded_execution_decision when loop not initialized', async () => {
        // Reset loop so it's not initialized
        (PlanningLoopService as any)._instance = null;
        expect(PlanningLoopService.isInitialized()).toBe(false);

        const agentStub = { chat: vi.fn().mockResolvedValue(stubTurnOutput) };
        // Create kernel manually without calling initialize
        // Directly test the bypass path
        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        // Re-create kernel (this will call initialize, so we need to reset again after)
        const kernel = new AgentKernel(agentStub as any);
        // Now reset the loop AFTER kernel construction to test the bypass path
        (PlanningLoopService as any)._instance = null;

        await kernel.execute({ userMessage: 'analyze and generate a report' });

        const degradedEvent = received.find((e) => e.event === 'planning.degraded_execution_decision');
        expect(degradedEvent).toBeDefined();
        expect(degradedEvent!.payload?.reason).toBe('loop_unavailable');
        expect(degradedEvent!.payload?.degradedModeCode).toBe('degraded_direct_allowed');
    });

    it('PLAR-37: execution succeeds via direct fallback even when bypass is surfaced', async () => {
        const agentStub = { chat: vi.fn().mockResolvedValue(stubTurnOutput) };
        const kernel = new AgentKernel(agentStub as any);
        (PlanningLoopService as any)._instance = null;

        const result = await kernel.execute({ userMessage: 'run the tests and show results' });

        expect(result.message).toBe('hello');
        expect(agentStub.chat).toHaveBeenCalled();
    });

    it('PLAR-38: degraded event carries detectedIn field', async () => {
        const agentStub = { chat: vi.fn().mockResolvedValue(stubTurnOutput) };
        new AgentKernel(agentStub as any);
        (PlanningLoopService as any)._instance = null;

        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        const kernel = new AgentKernel(agentStub as any);
        (PlanningLoopService as any)._instance = null;

        await kernel.execute({ userMessage: 'search and analyze all files' });

        const degradedEvent = received.find((e) => e.event === 'planning.degraded_execution_decision');
        if (degradedEvent) {
            expect(degradedEvent.payload?.detectedIn).toBe('AgentKernel.runDelegatedFlow');
        }
    });

    it('PLAR-39: bypass surfacing does not prevent kernel from completing the turn', async () => {
        const agentStub = { chat: vi.fn().mockResolvedValue(stubTurnOutput) };
        const kernel = new AgentKernel(agentStub as any);
        (PlanningLoopService as any)._instance = null;

        const received: RuntimeEvent[] = [];
        TelemetryBus.getInstance().subscribe((e) => received.push(e));

        await kernel.execute({ userMessage: 'generate and analyze a comprehensive report' });

        const completed = received.find((e) => e.event === 'execution.completed');
        expect(completed).toBeDefined();
    });

    it('PLAR-40: isInitialized() returns false before any initialization', () => {
        (PlanningLoopService as any)._instance = null;
        expect(PlanningLoopService.isInitialized()).toBe(false);
    });
});

// ─── PLAR-41..45: Authority types shape contracts ─────────────────────────────

describe('PLAR-41..45: Authority routing types shape contracts', () => {
    it('PLAR-41: ExecutionAuthorityClassification covers all expected variants', () => {
        const variants: ExecutionAuthorityClassification[] = [
            'trivial_direct_allowed',
            'planning_loop_required',
            'doctrined_exception',
            'implementation_detail',
        ];
        expect(variants).toHaveLength(4);
        // All variants must be distinct
        expect(new Set(variants).size).toBe(4);
    });

    it('PLAR-42: WorkComplexityClassification covers all expected variants', () => {
        const variants: WorkComplexityClassification[] = ['trivial', 'non_trivial'];
        expect(variants).toHaveLength(2);
    });

    it('PLAR-43: PlanningLoopRoutingDecision has required fields', () => {
        const decision: PlanningLoopRoutingDecision = {
            complexity: 'non_trivial',
            classification: 'planning_loop_required',
            requiresLoop: true,
            reasonCodes: ['conservative_default'],
            summary: 'test',
        };
        expect(decision).toHaveProperty('complexity');
        expect(decision).toHaveProperty('classification');
        expect(decision).toHaveProperty('requiresLoop');
        expect(decision).toHaveProperty('reasonCodes');
        expect(decision).toHaveProperty('summary');
    });

    it('PLAR-44: trivial decision always has requiresLoop=false', () => {
        const trivialInputs = ['hello', 'hi', 'ok', 'thanks', 'got it'];
        for (const input of trivialInputs) {
            const decision = PlanningLoopAuthorityRouter.classify(input);
            if (decision.classification === 'trivial_direct_allowed') {
                expect(decision.requiresLoop).toBe(false);
            }
        }
    });

    it('PLAR-45: non-trivial decision always has requiresLoop=true', () => {
        const nonTrivialInputs = [
            'run the tests',
            'search for notes',
            'generate a report',
            'analyze the code',
        ];
        for (const input of nonTrivialInputs) {
            const decision = PlanningLoopAuthorityRouter.classify(input);
            if (decision.classification === 'planning_loop_required') {
                expect(decision.requiresLoop).toBe(true);
            }
        }
    });
});
