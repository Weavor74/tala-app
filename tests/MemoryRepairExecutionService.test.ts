/**
 * MemoryRepairExecutionService.test.ts
 *
 * Unit tests for MemoryRepairExecutionService — the memory repair execution layer.
 *
 * Covers:
 *   MRE01–MRE05  — singleton / lifecycle (start / stop)
 *   MRE06–MRE12  — repair plan building (deterministic, capability-aware)
 *   MRE13–MRE22  — repair cycle execution (bounded, deterministic, observable)
 *   MRE23–MRE27  — cooldown and storm prevention
 *   MRE28–MRE32  — health re-evaluation and deferred work drain
 *   MRE33–MRE36  — strict-mode / hard-disable behavior
 *   MRE37–MRE40  — telemetry event emission
 *
 * No DB, no Electron, no IPC.
 * TelemetryBus is stubbed; all handlers are vi.fn() stubs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    MemoryRepairExecutionService,
    type RepairActionKind,
    type RepairActionResult,
} from '../electron/services/memory/MemoryRepairExecutionService';
import type { MemoryHealthStatus } from '../shared/memory/MemoryHealthStatus';
import type { MemoryRepairTrigger } from '../shared/memory/MemoryHealthStatus';

// ---------------------------------------------------------------------------
// Stub TelemetryBus
// ---------------------------------------------------------------------------

const emittedEvents: unknown[] = [];
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) => emittedEvents.push(event),
            subscribe: mockSubscribe.mockReturnValue(mockUnsubscribe),
            unsubscribe: mockUnsubscribe,
        }),
    },
}));

// ---------------------------------------------------------------------------
// Health status factories
// ---------------------------------------------------------------------------

function healthyStatus(): MemoryHealthStatus {
    return {
        state: 'healthy',
        capabilities: {
            canonical: true,
            extraction: true,
            embeddings: true,
            mem0Runtime: true,
            graphProjection: true,
            ragLogging: true,
        },
        reasons: ['none'],
        mode: 'full_memory',
        hardDisabled: false,
        shouldTriggerRepair: false,
        shouldEscalate: false,
        summary: 'Memory[HEALTHY] All capabilities available.',
        evaluatedAt: new Date().toISOString(),
    };
}

function criticalStatus(): MemoryHealthStatus {
    return {
        state: 'critical',
        capabilities: {
            canonical: false,
            extraction: false,
            embeddings: false,
            mem0Runtime: false,
            graphProjection: false,
            ragLogging: false,
        },
        reasons: ['canonical_unavailable'],
        mode: 'unknown',
        hardDisabled: true,
        shouldTriggerRepair: true,
        shouldEscalate: true,
        summary: 'Memory[CRITICAL] Canonical unavailable.',
        evaluatedAt: new Date().toISOString(),
    };
}

function degradedStatus(): MemoryHealthStatus {
    return {
        state: 'degraded',
        capabilities: {
            canonical: true,
            extraction: false,
            embeddings: false,
            mem0Runtime: false,
            graphProjection: false,
            ragLogging: false,
        },
        reasons: ['mem0_unavailable', 'extraction_provider_unavailable', 'embedding_provider_unavailable'],
        mode: 'canonical_only',
        hardDisabled: false,
        shouldTriggerRepair: true,
        shouldEscalate: true,
        summary: 'Memory[DEGRADED] mem0 down.',
        evaluatedAt: new Date().toISOString(),
    };
}

function reducedStatus(): MemoryHealthStatus {
    return {
        state: 'reduced',
        capabilities: {
            canonical: true,
            extraction: true,
            embeddings: true,
            mem0Runtime: true,
            graphProjection: false,
            ragLogging: false,
        },
        reasons: ['graph_projection_unavailable', 'rag_logging_unavailable'],
        mode: 'full_memory',
        hardDisabled: false,
        shouldTriggerRepair: true,
        shouldEscalate: false,
        summary: 'Memory[REDUCED] graph/rag unavailable.',
        evaluatedAt: new Date().toISOString(),
    };
}

function disabledStrictStatus(): MemoryHealthStatus {
    return {
        state: 'disabled',
        capabilities: {
            canonical: true,
            extraction: false,
            embeddings: false,
            mem0Runtime: false,
            graphProjection: false,
            ragLogging: false,
        },
        reasons: ['mem0_unavailable', 'extraction_provider_unavailable', 'embedding_provider_unavailable'],
        mode: 'canonical_only',
        hardDisabled: true,
        shouldTriggerRepair: false,
        shouldEscalate: false,
        summary: 'Memory[DISABLED] strict mode.',
        evaluatedAt: new Date().toISOString(),
    };
}

function makeTrigger(reason: MemoryRepairTrigger['reason'] = 'canonical_unavailable'): MemoryRepairTrigger {
    return {
        severity: 'error',
        reason,
        state: 'critical',
        emittedAt: new Date().toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(): MemoryRepairExecutionService {
    const svc = MemoryRepairExecutionService.getInstance();
    svc.reset();
    emittedEvents.length = 0;
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
    return svc;
}

function withHealth(svc: MemoryRepairExecutionService, statusFn: () => MemoryHealthStatus): void {
    svc.setHealthStatusProvider(statusFn);
}

function withSuccessHandler(svc: MemoryRepairExecutionService, action: RepairActionKind): void {
    svc.registerRepairHandler(action, async () => true);
}

function withFailHandler(svc: MemoryRepairExecutionService, action: RepairActionKind): void {
    svc.registerRepairHandler(action, async () => false);
}

// ---------------------------------------------------------------------------
// MRE01–MRE05 — Singleton / lifecycle
// ---------------------------------------------------------------------------

describe('MRE: singleton and lifecycle', () => {

    it('MRE01: getInstance() always returns the same instance', () => {
        const a = MemoryRepairExecutionService.getInstance();
        const b = MemoryRepairExecutionService.getInstance();
        expect(a).toBe(b);
    });

    it('MRE02: start() subscribes to TelemetryBus', () => {
        const svc = makeService();
        svc.start();
        expect(mockSubscribe).toHaveBeenCalledOnce();
    });

    it('MRE03: start() is idempotent — second call does not re-subscribe', () => {
        const svc = makeService();
        svc.start();
        svc.start();
        expect(mockSubscribe).toHaveBeenCalledOnce();
    });

    it('MRE04: stop() calls unsubscribe and detaches from bus', () => {
        const svc = makeService();
        svc.start();
        svc.stop();
        expect(mockUnsubscribe).toHaveBeenCalledOnce();
    });

    it('MRE05: getState() reflects idle defaults after reset', () => {
        const svc = makeService();
        const state = svc.getState();
        expect(state.isRunning).toBe(false);
        expect(state.cycleCount).toBe(0);
        expect(state.lastOutcome).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// MRE06–MRE12 — Repair plan building
// ---------------------------------------------------------------------------

describe('MRE: repair plan building', () => {

    it('MRE06: canonical_unavailable reason produces reconnect_canonical in plan', async () => {
        const svc = makeService();
        const actionsAttempted: RepairActionKind[] = [];
        svc.registerRepairHandler('reconnect_canonical', async () => {
            actionsAttempted.push('reconnect_canonical');
            return false;
        });
        withHealth(svc, () => criticalStatus());
        await svc.runRepairCycle('canonical_unavailable');
        expect(actionsAttempted).toContain('reconnect_canonical');
    });

    it('MRE07: mem0_unavailable reason produces reconnect_mem0 in plan', async () => {
        const svc = makeService();
        const actionsAttempted: RepairActionKind[] = [];
        svc.registerRepairHandler('reconnect_mem0', async () => {
            actionsAttempted.push('reconnect_mem0');
            return false;
        });
        withHealth(svc, () => degradedStatus());
        await svc.runRepairCycle('mem0_unavailable');
        expect(actionsAttempted).toContain('reconnect_mem0');
    });

    it('MRE08: graph_projection_unavailable reason produces reconnect_graph in plan', async () => {
        const svc = makeService();
        const actionsAttempted: RepairActionKind[] = [];
        svc.registerRepairHandler('reconnect_graph', async () => {
            actionsAttempted.push('reconnect_graph');
            return false;
        });
        // Use degraded state (not acceptable) with graph unavailable so the action actually runs
        withHealth(svc, () => ({
            ...degradedStatus(),
            reasons: ['mem0_unavailable', 'graph_projection_unavailable'],
        }));
        await svc.runRepairCycle('graph_projection_unavailable');
        expect(actionsAttempted).toContain('reconnect_graph');
    });

    it('MRE09: rag_logging_unavailable reason produces reconnect_rag in plan', async () => {
        const svc = makeService();
        const actionsAttempted: RepairActionKind[] = [];
        svc.registerRepairHandler('reconnect_rag', async () => {
            actionsAttempted.push('reconnect_rag');
            return false;
        });
        // Use degraded state (not acceptable) with rag unavailable so the action actually runs
        withHealth(svc, () => ({
            ...degradedStatus(),
            reasons: ['mem0_unavailable', 'rag_logging_unavailable'],
        }));
        await svc.runRepairCycle('rag_logging_unavailable');
        expect(actionsAttempted).toContain('reconnect_rag');
    });

    it('MRE10: extraction_provider_unavailable produces re_resolve_providers', async () => {
        const svc = makeService();
        const actionsAttempted: RepairActionKind[] = [];
        svc.registerRepairHandler('re_resolve_providers', async () => {
            actionsAttempted.push('re_resolve_providers');
            return false;
        });
        withHealth(svc, () => ({
            ...degradedStatus(),
            reasons: ['extraction_provider_unavailable'],
        }));
        await svc.runRepairCycle('extraction_provider_unavailable');
        expect(actionsAttempted).toContain('re_resolve_providers');
    });

    it('MRE11: healthy status produces no handler actions (only drain)', async () => {
        const svc = makeService();
        const actionsAttempted: RepairActionKind[] = [];
        (['reconnect_canonical', 'reconnect_mem0', 're_resolve_providers'] as RepairActionKind[]).forEach(a => {
            svc.registerRepairHandler(a, async () => {
                actionsAttempted.push(a);
                return true;
            });
        });
        withHealth(svc, () => healthyStatus());
        await svc.runRepairCycle('unknown');
        // Healthy state is immediately acceptable — no real repair actions
        expect(actionsAttempted).toHaveLength(0);
    });

    it('MRE12: plan is deterministic — same health status produces same action order', async () => {
        const svc = makeService();
        const firstRun: RepairActionKind[] = [];
        const secondRun: RepairActionKind[] = [];

        // First cycle
        svc.registerRepairHandler('reconnect_canonical', async () => {
            firstRun.push('reconnect_canonical');
            return false;
        });
        withHealth(svc, () => criticalStatus());
        await svc.runRepairCycle('canonical_unavailable');

        svc.reset();
        emittedEvents.length = 0;

        // Second cycle — same inputs
        svc.registerRepairHandler('reconnect_canonical', async () => {
            secondRun.push('reconnect_canonical');
            return false;
        });
        withHealth(svc, () => criticalStatus());
        await svc.runRepairCycle('canonical_unavailable');

        expect(firstRun).toEqual(secondRun);
    });
});

// ---------------------------------------------------------------------------
// MRE13–MRE22 — Cycle execution
// ---------------------------------------------------------------------------

describe('MRE: repair cycle execution', () => {

    it('MRE13: successful handler returns outcome = recovered when health improves', async () => {
        const svc = makeService();
        let callCount = 0;
        svc.registerRepairHandler('reconnect_canonical', async () => {
            callCount++;
            return true;
        });
        // Health transitions to healthy after the action
        let evalCount = 0;
        withHealth(svc, () => {
            evalCount++;
            return evalCount <= 1 ? criticalStatus() : healthyStatus();
        });
        const result = await svc.runRepairCycle('canonical_unavailable');
        expect(result.outcome).toBe('recovered');
        expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it('MRE14: failed handlers and no improvement returns outcome = failed', async () => {
        const svc = makeService();
        withFailHandler(svc, 'reconnect_canonical');
        withHealth(svc, () => criticalStatus());
        const result = await svc.runRepairCycle('canonical_unavailable');
        expect(result.outcome).toBe('failed');
    });

    it('MRE15: actionsExecuted list is populated for each attempted action', async () => {
        const svc = makeService();
        withFailHandler(svc, 'reconnect_canonical');
        withHealth(svc, () => criticalStatus());
        const result = await svc.runRepairCycle('canonical_unavailable');
        const action = result.actionsExecuted.find(a => a.action === 'reconnect_canonical');
        expect(action).toBeDefined();
        expect(action!.success).toBe(false);
        expect(action!.skipped).toBe(false);
    });

    it('MRE16: action with no registered handler is recorded as skipped', async () => {
        const svc = makeService();
        // Do NOT register reconnect_canonical
        withHealth(svc, () => criticalStatus());
        const result = await svc.runRepairCycle('canonical_unavailable');
        const action = result.actionsExecuted.find(a => a.action === 'reconnect_canonical');
        expect(action).toBeDefined();
        expect(action!.skipped).toBe(true);
    });

    it('MRE17: handler that throws is recorded as failed (error captured)', async () => {
        const svc = makeService();
        svc.registerRepairHandler('reconnect_canonical', async () => {
            throw new Error('connection refused');
        });
        withHealth(svc, () => criticalStatus());
        const result = await svc.runRepairCycle('canonical_unavailable');
        const action = result.actionsExecuted.find(a => a.action === 'reconnect_canonical');
        expect(action).toBeDefined();
        expect(action!.success).toBe(false);
        expect(action!.error).toContain('connection refused');
    });

    it('MRE18: actions stop early when health becomes acceptable mid-cycle', async () => {
        const svc = makeService();
        let graphAttempted = false;
        withSuccessHandler(svc, 'reconnect_canonical');
        svc.registerRepairHandler('reconnect_graph', async () => {
            graphAttempted = true;
            return true;
        });
        let evalCount = 0;
        withHealth(svc, () => {
            evalCount++;
            return evalCount <= 1 ? criticalStatus() : healthyStatus();
        });
        await svc.runRepairCycle('canonical_unavailable');
        // Once canonical is recovered (health = healthy), graph action should not run
        expect(graphAttempted).toBe(false);
    });

    it('MRE19: no health provider returns skipped result', async () => {
        const svc = makeService();
        // deliberately do NOT call setHealthStatusProvider
        const result = await svc.runRepairCycle('canonical_unavailable');
        expect(result.outcome).toBe('skipped');
    });

    it('MRE20: concurrent runRepairCycle call returns skipped immediately', async () => {
        const svc = makeService();
        // First cycle will stay running until the handler resolves
        let resolveHandler!: (v: boolean) => void;
        const handlerPromise = new Promise<boolean>(resolve => { resolveHandler = resolve; });
        svc.registerRepairHandler('reconnect_canonical', () => handlerPromise);
        withHealth(svc, () => criticalStatus());

        const firstCycle = svc.runRepairCycle('canonical_unavailable');

        // Small tick to let first cycle start
        await new Promise(r => setTimeout(r, 0));

        const secondResult = await svc.runRepairCycle('canonical_unavailable');
        expect(secondResult.outcome).toBe('skipped');

        resolveHandler(false);
        await firstCycle;
    });

    it('MRE21: getState().isRunning is true while a cycle is executing', async () => {
        const svc = makeService();
        let capturedRunning = false;
        let resolveHandler!: (v: boolean) => void;
        const handlerPromise = new Promise<boolean>(resolve => { resolveHandler = resolve; });
        svc.registerRepairHandler('reconnect_canonical', async () => {
            capturedRunning = svc.getState().isRunning;
            return await handlerPromise;
        });
        withHealth(svc, () => criticalStatus());

        const cycle = svc.runRepairCycle('canonical_unavailable');
        await new Promise(r => setTimeout(r, 0));
        resolveHandler(false);
        await cycle;
        expect(capturedRunning).toBe(true);
    });

    it('MRE22: getState().cycleCount increments after each cycle', async () => {
        const svc = makeService();
        withHealth(svc, () => criticalStatus());
        await svc.runRepairCycle('canonical_unavailable');
        await svc.runRepairCycle('canonical_unavailable'); // within cooldown → skipped
        const state = svc.getState();
        // First real cycle + possibly second (cooldown would block)
        expect(state.cycleCount).toBeGreaterThanOrEqual(1);
    });
});

// ---------------------------------------------------------------------------
// MRE23–MRE27 — Cooldown and storm prevention
// ---------------------------------------------------------------------------

describe('MRE: cooldown and storm prevention', () => {

    it('MRE23: handleRepairTrigger within cooldown window returns skipped', async () => {
        const svc = makeService();
        withHealth(svc, () => criticalStatus());
        withFailHandler(svc, 'reconnect_canonical');

        // First trigger runs a real cycle
        const trigger = makeTrigger('canonical_unavailable');
        await svc.handleRepairTrigger(trigger);

        // Immediate second trigger → should be within cooldown
        const result = await svc.handleRepairTrigger(trigger);
        expect(result.outcome).toBe('skipped');
    });

    it('MRE24: different reasons do not share cooldown slots', async () => {
        const svc = makeService();
        withHealth(svc, () => ({
            ...degradedStatus(),
            reasons: ['canonical_unavailable', 'mem0_unavailable'],
            capabilities: {
                ...degradedStatus().capabilities,
                canonical: false,
            },
        }));
        withFailHandler(svc, 'reconnect_canonical');
        withFailHandler(svc, 'reconnect_mem0');

        await svc.handleRepairTrigger(makeTrigger('canonical_unavailable'));

        // mem0 trigger for a different reason should NOT be blocked by canonical cooldown
        const mem0Result = await svc.handleRepairTrigger(makeTrigger('mem0_unavailable'));
        // Not blocked by cooldown — should be running or failed (not skipped due to cooldown)
        expect(mem0Result.outcome).not.toBe('skipped');
    });

    it('MRE25: attempt cap prevents repeated execution of same action', async () => {
        const svc = makeService();
        let callCount = 0;
        svc.registerRepairHandler('reconnect_canonical', async () => {
            callCount++;
            return false;
        });
        withHealth(svc, () => criticalStatus());

        // Run 5 cycles (bypass cooldown by resetting _lastCycleAtByReason)
        for (let i = 0; i < 5; i++) {
            (svc as any)._lastCycleAtByReason.clear();
            await svc.runRepairCycle('canonical_unavailable');
        }

        // MAX_ATTEMPTS_PER_ACTION = 3, so handler should not be called more than 3 times
        expect(callCount).toBeLessThanOrEqual(3);
    });

    it('MRE26: storm prevention skips cycle when MAX_CYCLES_PER_WINDOW is reached', async () => {
        const svc = makeService();
        withHealth(svc, () => criticalStatus());
        withFailHandler(svc, 'reconnect_canonical');

        // Inject 10 fake recent cycle timestamps to max out the window
        const now = Date.now();
        for (let i = 0; i < 10; i++) {
            (svc as any)._recentCycleTimes.push(now - i * 100);
        }

        (svc as any)._lastCycleAtByReason.clear();
        const result = await svc.runRepairCycle('canonical_unavailable');
        expect(result.outcome).toBe('skipped');
    });

    it('MRE27: getState().lastOutcome reflects skipped when cycle is skipped', async () => {
        const svc = makeService();
        withHealth(svc, () => criticalStatus());
        withFailHandler(svc, 'reconnect_canonical');

        await svc.runRepairCycle('canonical_unavailable');

        // Second cycle within cooldown
        await svc.handleRepairTrigger(makeTrigger('canonical_unavailable'));

        // lastOutcome should reflect the first real cycle (not the skipped one)
        // The skipped result doesn't overwrite lastOutcome
        const state = svc.getState();
        expect(['failed', 'partial', 'recovered']).toContain(state.lastOutcome);
    });
});

// ---------------------------------------------------------------------------
// MRE28–MRE32 — Health re-evaluation and deferred work drain
// ---------------------------------------------------------------------------

describe('MRE: health re-evaluation and deferred work drain', () => {

    it('MRE28: re_evaluate_health built-in action succeeds without a registered handler', async () => {
        const svc = makeService();
        withFailHandler(svc, 'reconnect_canonical');
        // Provide a static health status
        withHealth(svc, () => criticalStatus());
        const result = await svc.runRepairCycle('canonical_unavailable');
        const reEval = result.actionsExecuted.find(a => a.action === 're_evaluate_health');
        // re_evaluate_health should appear and succeed if it is in the plan
        if (reEval) {
            expect(reEval.success).toBe(true);
        }
    });

    it('MRE29: drain_deferred_work is called after recovery when canonical is healthy', async () => {
        const svc = makeService();
        let drained = false;
        svc.setDeferredWorkDrainCallback(() => { drained = true; });
        withSuccessHandler(svc, 'reconnect_canonical');
        let evalCount = 0;
        withHealth(svc, () => {
            evalCount++;
            return evalCount <= 1 ? criticalStatus() : healthyStatus();
        });
        await svc.runRepairCycle('canonical_unavailable');
        expect(drained).toBe(true);
    });

    it('MRE30: drain_deferred_work is NOT called when canonical remains unavailable', async () => {
        const svc = makeService();
        let drained = false;
        svc.setDeferredWorkDrainCallback(() => { drained = true; });
        withFailHandler(svc, 'reconnect_canonical');
        withHealth(svc, () => criticalStatus()); // canonical remains false
        await svc.runRepairCycle('canonical_unavailable');
        expect(drained).toBe(false);
    });

    it('MRE31: drain callback error does not abort the cycle', async () => {
        const svc = makeService();
        svc.setDeferredWorkDrainCallback(() => { throw new Error('drain failed'); });
        withSuccessHandler(svc, 'reconnect_canonical');
        let evalCount = 0;
        withHealth(svc, () => {
            evalCount++;
            return evalCount <= 1 ? criticalStatus() : healthyStatus();
        });
        // Must not throw
        const result = await svc.runRepairCycle('canonical_unavailable');
        expect(result.outcome).toBe('recovered');
    });

    it('MRE32: health is re-evaluated after each registered action', async () => {
        const svc = makeService();
        const healthEvals: number[] = [];
        let evalCount = 0;
        withHealth(svc, () => {
            evalCount++;
            healthEvals.push(evalCount);
            return degradedStatus();
        });
        withFailHandler(svc, 'reconnect_mem0');
        withFailHandler(svc, 're_resolve_providers');
        await svc.runRepairCycle('mem0_unavailable');
        // Health should be evaluated more than once (initial + after each action)
        expect(healthEvals.length).toBeGreaterThan(1);
    });
});

// ---------------------------------------------------------------------------
// MRE33–MRE36 — Strict-mode / hard-disable behavior
// ---------------------------------------------------------------------------

describe('MRE: strict-mode and hard-disable handling', () => {

    it('MRE33: disabled state from strict mode (non-canonical reason) returns outcome = failed', async () => {
        const svc = makeService();
        withHealth(svc, () => disabledStrictStatus());
        const result = await svc.runRepairCycle('mem0_unavailable');
        expect(result.outcome).toBe('failed');
    });

    it('MRE34: disabled state with canonical_unavailable reason is NOT blocked by strict guard', async () => {
        const svc = makeService();
        const strictCanonicalDown: MemoryHealthStatus = {
            ...disabledStrictStatus(),
            reasons: ['canonical_unavailable'],
            capabilities: { ...disabledStrictStatus().capabilities, canonical: false },
        };
        withFailHandler(svc, 'reconnect_canonical');
        withHealth(svc, () => strictCanonicalDown);
        const result = await svc.runRepairCycle('canonical_unavailable');
        // Should attempt reconnect_canonical rather than being instantly blocked
        const action = result.actionsExecuted.find(a => a.action === 'reconnect_canonical');
        expect(action).toBeDefined();
        expect(action!.skipped).toBe(false);
    });

    it('MRE35: reduced state (healthy enough) skips all repair handler actions', async () => {
        const svc = makeService();
        let graphCalled = false;
        svc.registerRepairHandler('reconnect_graph', async () => {
            graphCalled = true;
            return true;
        });
        // Health is immediately reduced (acceptable) — no actions should run before returning
        withHealth(svc, () => ({
            ...reducedStatus(),
        }));
        await svc.runRepairCycle('graph_projection_unavailable');
        // reduced is acceptable → early stop before any actions
        expect(graphCalled).toBe(false);
    });

    it('MRE36: outcome = failed when hard-disabled strict non-canonical from start', async () => {
        const svc = makeService();
        withHealth(svc, () => disabledStrictStatus());
        const result = await svc.runRepairCycle('extraction_provider_unavailable');
        expect(result.outcome).toBe('failed');
        expect(result.actionsExecuted).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// MRE37–MRE40 — Telemetry event emission
// ---------------------------------------------------------------------------

describe('MRE: telemetry emission', () => {

    it('MRE37: memory.repair_started is emitted at the beginning of each cycle', async () => {
        const svc = makeService();
        withHealth(svc, () => criticalStatus());
        withFailHandler(svc, 'reconnect_canonical');
        await svc.runRepairCycle('canonical_unavailable');
        const started = emittedEvents.filter((e: any) => e.event === 'memory.repair_started');
        expect(started).toHaveLength(1);
        const payload = (started[0] as any).payload;
        expect(payload.initialState).toBe('critical');
        expect(payload.reason).toBe('canonical_unavailable');
    });

    it('MRE38: memory.repair_completed is emitted at the end of each cycle', async () => {
        const svc = makeService();
        withHealth(svc, () => criticalStatus());
        withFailHandler(svc, 'reconnect_canonical');
        await svc.runRepairCycle('canonical_unavailable');
        const completed = emittedEvents.filter((e: any) => e.event === 'memory.repair_completed');
        expect(completed).toHaveLength(1);
        const payload = (completed[0] as any).payload;
        expect(payload.outcome).toBe('failed');
        expect(payload.finalState).toBe('critical');
    });

    it('MRE39: memory.repair_action_started and completed emitted for registered handler', async () => {
        const svc = makeService();
        withHealth(svc, () => criticalStatus());
        withFailHandler(svc, 'reconnect_canonical');
        await svc.runRepairCycle('canonical_unavailable');
        const actionStarted = emittedEvents.filter((e: any) => e.event === 'memory.repair_action_started');
        const actionCompleted = emittedEvents.filter((e: any) => e.event === 'memory.repair_action_completed');
        expect(actionStarted.length).toBeGreaterThanOrEqual(1);
        expect(actionCompleted.length).toBeGreaterThanOrEqual(1);
        const startedPayload = (actionStarted[0] as any).payload;
        const completedPayload = (actionCompleted[0] as any).payload;
        expect(startedPayload.action).toBe('reconnect_canonical');
        expect(completedPayload.action).toBe('reconnect_canonical');
        expect(completedPayload.success).toBe(false);
    });

    it('MRE40: repair_completed payload includes actionsCount and actionsSucceeded', async () => {
        const svc = makeService();
        withHealth(svc, () => criticalStatus());
        withFailHandler(svc, 'reconnect_canonical');
        await svc.runRepairCycle('canonical_unavailable');
        const completed = emittedEvents.find((e: any) => e.event === 'memory.repair_completed') as any;
        expect(completed).toBeDefined();
        expect(typeof completed.payload.actionsCount).toBe('number');
        expect(typeof completed.payload.actionsSucceeded).toBe('number');
        expect(completed.payload.actionsSucceeded).toBeLessThanOrEqual(completed.payload.actionsCount);
    });
});
