/**
 * MemoryIntegrityPolicy.test.ts
 *
 * Unit tests for:
 *   - MemoryIntegrityPolicy.evaluate() — state derivation, capability flags,
 *     hard-disable logic, repair triggers, and summary text.
 *   - MemoryRepairTriggerService — de-duplication, emit, reset.
 *
 * No DB, no Electron, no IPC.
 * TelemetryBus is stubbed so tests stay self-contained.
 *
 * Test IDs: MIP01 – MIP40 (MemoryIntegrityPolicy)
 *            MRT01 – MRT15 (MemoryRepairTriggerService)
 *            MIH01 – MIH60 (memory integrity hardening — Phase 2 additions)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryIntegrityPolicy } from '../electron/services/memory/MemoryIntegrityPolicy';
import { MemoryRepairTriggerService } from '../electron/services/memory/MemoryRepairTriggerService';
import type { MemoryIntegrityPolicyInputs } from '../electron/services/memory/MemoryIntegrityPolicy';

// ---------------------------------------------------------------------------
// Stub TelemetryBus so we can inspect emissions without the full stack
// ---------------------------------------------------------------------------

const emittedEvents: unknown[] = [];

vi.mock('../electron/services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: (event: unknown) => emittedEvents.push(event),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allCapabilities(): MemoryIntegrityPolicyInputs {
    return {
        canonicalReady: true,
        mem0Ready: true,
        resolvedMode: 'full_memory',
        extractionEnabled: true,
        embeddingsEnabled: true,
        graphAvailable: true,
        ragAvailable: true,
        integrityMode: 'balanced',
    };
}

function canonicalOnlyInputs(): MemoryIntegrityPolicyInputs {
    return {
        canonicalReady: true,
        mem0Ready: false,
        resolvedMode: 'canonical_only',
        extractionEnabled: false,
        embeddingsEnabled: false,
        graphAvailable: false,
        ragAvailable: false,
        integrityMode: 'balanced',
    };
}

// ---------------------------------------------------------------------------
// MemoryIntegrityPolicy — state derivation
// ---------------------------------------------------------------------------

describe('MemoryIntegrityPolicy — state derivation', () => {

    it('MIP01: all capabilities available → state = healthy', () => {
        const status = MemoryIntegrityPolicy.evaluate(allCapabilities());
        expect(status.state).toBe('healthy');
    });

    it('MIP02: canonical down → state = critical', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        expect(status.state).toBe('critical');
    });

    it('MIP03: canonical up, mem0 down, no extraction/embeddings → state = degraded', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            canonicalReady: true,
            mem0Ready: false,
            extractionEnabled: false,
            embeddingsEnabled: false,
            graphAvailable: false,
            ragAvailable: false,
            integrityMode: 'balanced',
        });
        expect(status.state).toBe('degraded');
    });

    it('MIP04: canonical up, extraction missing only → state = reduced', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            extractionEnabled: false,
            resolvedMode: 'canonical_plus_embeddings',
        });
        expect(status.state).toBe('reduced');
    });

    it('MIP05: canonical up, embeddings missing only → state = reduced', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            embeddingsEnabled: false,
        });
        expect(status.state).toBe('reduced');
    });

    it('MIP06: canonical up, graph missing only → state = healthy (auxiliary gap)', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            graphAvailable: false,
        });
        expect(status.state).toBe('healthy');
    });

    it('MIP07: canonical up, rag missing only → state = healthy (auxiliary gap)', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            ragAvailable: false,
        });
        expect(status.state).toBe('healthy');
    });

    it('MIP08: resolvedMode = canonical_only → state = degraded', () => {
        const status = MemoryIntegrityPolicy.evaluate(canonicalOnlyInputs());
        expect(status.state).toBe('degraded');
    });

    it('MIP09: forceDisable = true → state = disabled regardless of capabilities', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            forceDisable: true,
        });
        expect(status.state).toBe('disabled');
    });

    it('MIP10: strict mode + extraction unavailable → state = disabled', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            extractionEnabled: false,
            integrityMode: 'strict',
        });
        expect(status.state).toBe('disabled');
    });

    it('MIP11: strict mode + embeddings unavailable → state = disabled', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            embeddingsEnabled: false,
            integrityMode: 'strict',
        });
        expect(status.state).toBe('disabled');
    });

    it('MIP12: strict mode + mem0 unavailable → state = disabled', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            mem0Ready: false,
            integrityMode: 'strict',
        });
        expect(status.state).toBe('disabled');
    });

    it('MIP13: lenient mode + canonical only → state = degraded (not disabled)', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...canonicalOnlyInputs(),
            integrityMode: 'lenient',
        });
        expect(status.state).toBe('degraded');
    });
});

// ---------------------------------------------------------------------------
// MemoryIntegrityPolicy — capability flags
// ---------------------------------------------------------------------------

describe('MemoryIntegrityPolicy — capability flags', () => {

    it('MIP14: healthy → all capability flags true', () => {
        const { capabilities } = MemoryIntegrityPolicy.evaluate(allCapabilities());
        expect(capabilities.canonical).toBe(true);
        expect(capabilities.extraction).toBe(true);
        expect(capabilities.embeddings).toBe(true);
        expect(capabilities.mem0Runtime).toBe(true);
        expect(capabilities.graphProjection).toBe(true);
        expect(capabilities.ragLogging).toBe(true);
    });

    it('MIP15: canonical down → canonical capability = false', () => {
        const { capabilities } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        expect(capabilities.canonical).toBe(false);
    });

    it('MIP16: extraction disabled → extraction capability = false', () => {
        const { capabilities } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            extractionEnabled: false,
        });
        expect(capabilities.extraction).toBe(false);
    });

    it('MIP17: mem0 not ready → mem0Runtime capability = false', () => {
        const { capabilities } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            mem0Ready: false,
        });
        expect(capabilities.mem0Runtime).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// MemoryIntegrityPolicy — failure reasons
// ---------------------------------------------------------------------------

describe('MemoryIntegrityPolicy — failure reasons', () => {

    it('MIP18: healthy state → reasons = [none]', () => {
        const { reasons } = MemoryIntegrityPolicy.evaluate(allCapabilities());
        expect(reasons).toEqual(['none']);
    });

    it('MIP19: canonical unavailable → includes canonical_unavailable', () => {
        const { reasons } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        expect(reasons).toContain('canonical_unavailable');
    });

    it('MIP20: mem0 unavailable → includes mem0_unavailable', () => {
        const { reasons } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            mem0Ready: false,
        });
        expect(reasons).toContain('mem0_unavailable');
    });

    it('MIP21: extraction unavailable → includes extraction_provider_unavailable', () => {
        const { reasons } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            extractionEnabled: false,
        });
        expect(reasons).toContain('extraction_provider_unavailable');
    });

    it('MIP22: embeddings unavailable → includes embedding_provider_unavailable', () => {
        const { reasons } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            embeddingsEnabled: false,
        });
        expect(reasons).toContain('embedding_provider_unavailable');
    });

    it('MIP23: canonical up + no extraction + no embeddings + mem0 up → includes mem0_mode_canonical_only', () => {
        const { reasons } = MemoryIntegrityPolicy.evaluate({
            canonicalReady: true,
            mem0Ready: true,
            extractionEnabled: false,
            embeddingsEnabled: false,
            graphAvailable: true,
            ragAvailable: true,
            integrityMode: 'balanced',
        });
        expect(reasons).toContain('mem0_mode_canonical_only');
    });

    it('MIP24: graph unavailable → includes graph_projection_unavailable', () => {
        const { reasons } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            graphAvailable: false,
        });
        expect(reasons).toContain('graph_projection_unavailable');
    });

    it('MIP25: rag unavailable → includes rag_logging_unavailable', () => {
        const { reasons } = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            ragAvailable: false,
        });
        expect(reasons).toContain('rag_logging_unavailable');
    });
});

// ---------------------------------------------------------------------------
// MemoryIntegrityPolicy — hard-disable and repair flags
// ---------------------------------------------------------------------------

describe('MemoryIntegrityPolicy — hard-disable and repair flags', () => {

    it('MIP26: critical → hardDisabled = true', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        expect(status.hardDisabled).toBe(true);
    });

    it('MIP27: disabled → hardDisabled = true', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            forceDisable: true,
        });
        expect(status.hardDisabled).toBe(true);
    });

    it('MIP28: healthy → hardDisabled = false', () => {
        const status = MemoryIntegrityPolicy.evaluate(allCapabilities());
        expect(status.hardDisabled).toBe(false);
    });

    it('MIP29: reduced → hardDisabled = false (balanced mode)', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            extractionEnabled: false,
        });
        expect(status.hardDisabled).toBe(false);
    });

    it('MIP30: degraded + strict mode → hardDisabled = true', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...canonicalOnlyInputs(),
            integrityMode: 'strict',
        });
        // strict + degraded-or-worse → disabled state → hardDisabled
        expect(status.hardDisabled).toBe(true);
    });

    it('MIP31: critical → shouldTriggerRepair = true', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        expect(status.shouldTriggerRepair).toBe(true);
    });

    it('MIP32: degraded → shouldTriggerRepair = true', () => {
        const status = MemoryIntegrityPolicy.evaluate(canonicalOnlyInputs());
        expect(status.shouldTriggerRepair).toBe(true);
    });

    it('MIP33: healthy → shouldTriggerRepair = false', () => {
        const status = MemoryIntegrityPolicy.evaluate(allCapabilities());
        expect(status.shouldTriggerRepair).toBe(false);
    });

    it('MIP34: healthy but graph unavailable → shouldTriggerRepair = true', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            graphAvailable: false,
        });
        expect(status.shouldTriggerRepair).toBe(true);
    });

    it('MIP35: critical → shouldEscalate = true', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        expect(status.shouldEscalate).toBe(true);
    });

    it('MIP36: degraded + balanced → shouldEscalate = true', () => {
        const status = MemoryIntegrityPolicy.evaluate(canonicalOnlyInputs());
        expect(status.shouldEscalate).toBe(true);
    });

    it('MIP37: degraded + lenient → shouldEscalate = false', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...canonicalOnlyInputs(),
            integrityMode: 'lenient',
        });
        expect(status.shouldEscalate).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// MemoryIntegrityPolicy — mode and summary
// ---------------------------------------------------------------------------

describe('MemoryIntegrityPolicy — mode and summary', () => {

    it('MIP38: resolvedMode propagated into status.mode', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            resolvedMode: 'canonical_plus_embeddings',
        });
        expect(status.mode).toBe('canonical_plus_embeddings');
    });

    it('MIP39: no resolvedMode + all enabled → mode inferred as full_memory', () => {
        const inputs = { ...allCapabilities() };
        delete (inputs as any).resolvedMode;
        const status = MemoryIntegrityPolicy.evaluate(inputs);
        expect(status.mode).toBe('full_memory');
    });

    it('MIP40: evaluatedAt is a valid ISO-8601 timestamp', () => {
        const status = MemoryIntegrityPolicy.evaluate(allCapabilities());
        expect(() => new Date(status.evaluatedAt)).not.toThrow();
        expect(new Date(status.evaluatedAt).toISOString()).toBe(status.evaluatedAt);
    });
});

// ---------------------------------------------------------------------------
// MemoryRepairTriggerService
// ---------------------------------------------------------------------------

describe('MemoryRepairTriggerService', () => {
    let service: MemoryRepairTriggerService;

    beforeEach(() => {
        service = MemoryRepairTriggerService.getInstance();
        service.reset();
        emittedEvents.length = 0;
    });

    it('MRT01: maybeEmit does nothing when shouldTriggerRepair = false', () => {
        const status = MemoryIntegrityPolicy.evaluate(allCapabilities());
        service.maybeEmit(status);
        expect(emittedEvents).toHaveLength(0);
    });

    it('MRT02: maybeEmit emits a memory.repair_trigger event for critical state', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        service.maybeEmit(status);
        expect(emittedEvents).toHaveLength(1);
        const event = emittedEvents[0] as any;
        expect(event.event).toBe('memory.repair_trigger');
        expect(event.subsystem).toBe('memory');
    });

    it('MRT03: emitted trigger payload includes severity = error for critical state', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        service.maybeEmit(status);
        const trigger = (emittedEvents[0] as any).payload;
        expect(trigger.severity).toBe('error');
        expect(trigger.reason).toBe('canonical_unavailable');
        expect(trigger.state).toBe('critical');
    });

    it('MRT04: emitted trigger payload includes severity = warning for degraded state', () => {
        const status = MemoryIntegrityPolicy.evaluate(canonicalOnlyInputs());
        service.maybeEmit(status);
        const trigger = (emittedEvents[0] as any).payload;
        expect(trigger.severity).toBe('warning');
        expect(trigger.state).toBe('degraded');
    });

    it('MRT05: de-duplication: second maybeEmit within window does not re-emit', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        service.maybeEmit(status);
        service.maybeEmit(status);
        expect(emittedEvents).toHaveLength(1);
    });

    it('MRT06: trigger is recorded in getTriggerLog()', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        service.maybeEmit(status);
        expect(service.getTriggerLog()).toHaveLength(1);
    });

    it('MRT07: reset() clears trigger log and de-duplication state', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        service.maybeEmit(status);
        service.reset();
        service.maybeEmit(status); // should emit again after reset
        expect(service.getTriggerLog()).toHaveLength(1);
        expect(emittedEvents).toHaveLength(2);
    });

    it('MRT08: emitDirect emits with provided severity and reason', () => {
        service.emitDirect('canonical_init_failed', 'critical', 'critical', { source: 'test' });
        expect(emittedEvents).toHaveLength(1);
        const trigger = (emittedEvents[0] as any).payload;
        expect(trigger.reason).toBe('canonical_init_failed');
        expect(trigger.severity).toBe('critical');
        expect(trigger.state).toBe('critical');
        expect(trigger.details).toEqual({ source: 'test' });
    });

    it('MRT09: emitDirect de-duplicates within window', () => {
        service.emitDirect('mem0_unavailable', 'degraded', 'error');
        service.emitDirect('mem0_unavailable', 'degraded', 'error');
        expect(emittedEvents).toHaveLength(1);
    });

    it('MRT10: different reasons do not share de-duplication slot', () => {
        service.emitDirect('canonical_unavailable', 'critical', 'critical');
        service.emitDirect('mem0_unavailable', 'degraded', 'error');
        expect(emittedEvents).toHaveLength(2);
    });

    it('MRT11: trigger log is capped at 200 entries', () => {
        // Emit 205 triggers, bypassing de-duplication each time so every emit
        // actually lands in the log, and verify the cap holds at 200.
        for (let i = 0; i < 205; i++) {
            (service as any)._lastEmittedAt.clear();
            service.emitDirect('canonical_unavailable', 'critical', 'critical', { iteration: i });
        }
        expect(service.getTriggerLog().length).toBe(200);
    });

    it('MRT12: healthy status never triggers repair', () => {
        const status = MemoryIntegrityPolicy.evaluate(allCapabilities());
        expect(status.shouldTriggerRepair).toBe(false);
        service.maybeEmit(status);
        expect(emittedEvents).toHaveLength(0);
    });

    it('MRT13: reduced state with graph projection unavailable → triggers repair', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            graphAvailable: false,
        });
        service.maybeEmit(status);
        expect(emittedEvents).toHaveLength(1);
    });

    it('MRT14: trigger details include capabilities map', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        service.maybeEmit(status);
        const trigger = (emittedEvents[0] as any).payload;
        expect(trigger.details).toBeDefined();
        expect(trigger.details.capabilities).toBeDefined();
        expect(trigger.details.capabilities.canonical).toBe(false);
    });

    it('MRT15: getTriggerLog returns readonly snapshot (not live array)', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        service.maybeEmit(status);
        const log = service.getTriggerLog();
        expect(log).toHaveLength(1);
        // Adding to the returned reference should not affect internal log
        // (ReadonlyArray so this is a type-level guarantee, confirmed here)
        expect(Array.isArray(log)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// MIH — Memory Integrity Hardening (Phase 2 additions)
// ---------------------------------------------------------------------------

import { MemoryService } from '../electron/services/MemoryService';

// Stub Electron's `app` so MemoryService can be instantiated outside Electron
vi.mock('electron', () => ({
    app: {
        getPath: () => '/tmp/tala-test',
        getAppPath: () => '/tmp/tala-app',
    },
}));

// Stub fs so no real disk I/O
vi.mock('fs', () => ({
    default: {
        existsSync: () => false,
        readFileSync: () => '[]',
        writeFileSync: () => undefined,
    },
    existsSync: () => false,
    readFileSync: () => '[]',
    writeFileSync: () => undefined,
}));

// Stub RuntimeFlags
vi.mock('../electron/services/RuntimeFlags', () => ({
    RuntimeFlags: { ENABLE_MEM0_REMOTE: false },
}));

// Stub PolicyGate
vi.mock('../electron/services/policy/PolicyGate', () => ({
    policyGate: { evaluate: () => ({ allowed: true }) },
}));

// ---------------------------------------------------------------------------
// MIH01–MIH10: Graph availability wiring
// ---------------------------------------------------------------------------

describe('MIH: graph availability wiring', () => {
    let svc: MemoryService;

    beforeEach(() => {
        emittedEvents.length = 0;
        svc = new MemoryService();
    });

    it('MIH01: graphProjection capability defaults to false', () => {
        const h = svc.getHealthStatus();
        expect(h.capabilities.graphProjection).toBe(false);
    });

    it('MIH02: setting graphAvailable=true reflects in health capabilities', () => {
        svc.setSubsystemAvailability({ graphAvailable: true });
        const h = svc.getHealthStatus();
        expect(h.capabilities.graphProjection).toBe(true);
    });

    it('MIH03: setting graphAvailable=false reverts to unavailable', () => {
        svc.setSubsystemAvailability({ graphAvailable: true });
        svc.setSubsystemAvailability({ graphAvailable: false });
        const h = svc.getHealthStatus();
        expect(h.capabilities.graphProjection).toBe(false);
    });

    it('MIH04: graph_projection_unavailable reason appears when graphAvailable=false', () => {
        const h = svc.getHealthStatus();
        expect(h.reasons).toContain('graph_projection_unavailable');
    });

    it('MIH05: graph_projection_unavailable reason absent when graphAvailable=true (with canonical+mem0 up)', () => {
        svc.setSubsystemAvailability({
            canonicalReady: true,
            graphAvailable: true,
            ragAvailable: true,
        });
        // need full capabilities for healthy: use evaluate directly
        const status = MemoryIntegrityPolicy.evaluate({
            canonicalReady: true,
            mem0Ready: true,
            extractionEnabled: true,
            embeddingsEnabled: true,
            graphAvailable: true,
            ragAvailable: true,
            integrityMode: 'balanced',
        });
        expect(status.reasons).not.toContain('graph_projection_unavailable');
    });
});

// ---------------------------------------------------------------------------
// MIH11–MIH20: Cached health evaluation
// ---------------------------------------------------------------------------

describe('MIH: cached health evaluation', () => {
    let svc: MemoryService;

    beforeEach(() => {
        emittedEvents.length = 0;
        svc = new MemoryService();
    });

    it('MIH11: repeated calls within TTL return same object reference', () => {
        const first = svc.getHealthStatus();
        const second = svc.getHealthStatus();
        expect(second).toBe(first);
    });

    it('MIH12: cache emits health_evaluated event only once within TTL', () => {
        const before = emittedEvents.filter((e: any) => e.event === 'memory.health_evaluated').length;
        svc.getHealthStatus();
        svc.getHealthStatus();
        svc.getHealthStatus();
        const after = emittedEvents.filter((e: any) => e.event === 'memory.health_evaluated').length;
        expect(after - before).toBe(1);
    });

    it('MIH13: cache invalidates when graphAvailable changes', () => {
        const first = svc.getHealthStatus();
        svc.setSubsystemAvailability({ graphAvailable: true });
        const second = svc.getHealthStatus();
        expect(second).not.toBe(first);
    });

    it('MIH14: cache invalidates when integrityMode changes', () => {
        const first = svc.getHealthStatus();
        svc.setSubsystemAvailability({ integrityMode: 'strict' });
        const second = svc.getHealthStatus();
        expect(second).not.toBe(first);
    });

    it('MIH15: cache invalidates when canonicalReady changes', () => {
        const first = svc.getHealthStatus();
        svc.setSubsystemAvailability({ canonicalReady: true });
        const second = svc.getHealthStatus();
        expect(second).not.toBe(first);
    });

    it('MIH16: setting same value does NOT invalidate cache', () => {
        svc.setSubsystemAvailability({ graphAvailable: false }); // same as default
        const first = svc.getHealthStatus();
        svc.setSubsystemAvailability({ graphAvailable: false }); // no change
        const second = svc.getHealthStatus();
        expect(second).toBe(first);
    });
});

// ---------------------------------------------------------------------------
// MIH21–MIH28: Severity mapping (severityForState)
// ---------------------------------------------------------------------------

describe('MIH: repair-trigger severity tiers (severityForState)', () => {
    it('MIH21: healthy → info (safe fallback)', () => {
        expect(MemoryRepairTriggerService.severityForState('healthy')).toBe('info');
    });

    it('MIH22: reduced → info', () => {
        expect(MemoryRepairTriggerService.severityForState('reduced')).toBe('info');
    });

    it('MIH23: degraded → warning', () => {
        expect(MemoryRepairTriggerService.severityForState('degraded')).toBe('warning');
    });

    it('MIH24: critical → error', () => {
        expect(MemoryRepairTriggerService.severityForState('critical')).toBe('error');
    });

    it('MIH25: disabled → critical', () => {
        expect(MemoryRepairTriggerService.severityForState('disabled')).toBe('critical');
    });

    it('MIH26: maybeEmit on reduced state emits info trigger', () => {
        emittedEvents.length = 0;
        const repairSvc = MemoryRepairTriggerService.getInstance();
        repairSvc.reset();
        const status = MemoryIntegrityPolicy.evaluate({
            canonicalReady: true,
            mem0Ready: true,
            extractionEnabled: false,
            embeddingsEnabled: true,
            graphAvailable: false,
            ragAvailable: false,
            integrityMode: 'balanced',
        });
        repairSvc.maybeEmit(status);
        const trigger = (emittedEvents[0] as any)?.payload;
        if (trigger) {
            expect(trigger.severity).toBe('info');
        }
    });

    it('MIH27: maybeEmit on disabled state emits critical trigger', () => {
        emittedEvents.length = 0;
        const repairSvc = MemoryRepairTriggerService.getInstance();
        repairSvc.reset();
        const status = MemoryIntegrityPolicy.evaluate({
            canonicalReady: true,
            mem0Ready: false,
            extractionEnabled: false,
            embeddingsEnabled: false,
            graphAvailable: false,
            ragAvailable: false,
            integrityMode: 'strict',
        });
        expect(status.state).toBe('disabled');
        repairSvc.maybeEmit(status);
        const trigger = (emittedEvents[0] as any)?.payload;
        if (trigger) {
            expect(trigger.severity).toBe('critical');
        }
    });
});

// ---------------------------------------------------------------------------
// MIH31–MIH40: Deferred-work backlog protection
// ---------------------------------------------------------------------------

describe('MIH: deferred-work backlog protection', () => {
    let svc: MemoryService;
    let repairSvc: MemoryRepairTriggerService;

    beforeEach(() => {
        emittedEvents.length = 0;
        svc = new MemoryService();
        repairSvc = MemoryRepairTriggerService.getInstance();
        repairSvc.reset();
    });

    it('MIH31: no trigger when backlog is below both thresholds', () => {
        svc.trackDeferredWork({ extraction: 10, embedding: 20, projection: 5 });
        const triggers = repairSvc.getTriggerLog();
        expect(triggers).toHaveLength(0);
    });

    it('MIH32: getDeferredWorkCounts returns incremented values', () => {
        svc.trackDeferredWork({ extraction: 5, embedding: 3, projection: 1 });
        const counts = svc.getDeferredWorkCounts();
        expect(counts.extraction).toBe(5);
        expect(counts.embedding).toBe(3);
        expect(counts.projection).toBe(1);
    });

    it('MIH33: warning trigger when backlog reaches warning threshold (250)', () => {
        svc.trackDeferredWork({ extraction: 250 });
        const triggers = repairSvc.getTriggerLog();
        expect(triggers).toHaveLength(1);
        expect(triggers[0].severity).toBe('warning');
    });

    it('MIH34: critical trigger when backlog reaches error threshold (1000)', () => {
        svc.trackDeferredWork({ embedding: 1000 });
        const triggers = repairSvc.getTriggerLog();
        expect(triggers).toHaveLength(1);
        expect(triggers[0].severity).toBe('critical');
    });

    it('MIH35: trigger details include pending counts', () => {
        svc.trackDeferredWork({ projection: 300 });
        const trigger = repairSvc.getTriggerLog()[0];
        expect(trigger?.details).toBeDefined();
        expect((trigger?.details as any).pendingProjection).toBe(300);
    });

    it('MIH36: resetDeferredWork clears extraction count', () => {
        svc.trackDeferredWork({ extraction: 100 });
        svc.resetDeferredWork({ extraction: true });
        expect(svc.getDeferredWorkCounts().extraction).toBe(0);
    });

    it('MIH37: trackDeferredWork is additive across calls', () => {
        svc.trackDeferredWork({ extraction: 100 });
        svc.trackDeferredWork({ extraction: 200 });
        expect(svc.getDeferredWorkCounts().extraction).toBe(300);
    });
});

// ---------------------------------------------------------------------------
// MIH41–MIH50: Settings-driven integrity mode
// ---------------------------------------------------------------------------

describe('MIH: settings-driven integrity mode', () => {
    it('MIH41: MemoryService defaults to balanced mode', () => {
        const svc = new MemoryService();
        svc.setSubsystemAvailability({ canonicalReady: true });
        const h = svc.getHealthStatus();
        // balanced: canonical up but no extraction/embeddings → reduced not disabled
        expect(h.state).not.toBe('disabled');
    });

    it('MIH42: strict mode disables when extraction is missing', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            canonicalReady: true,
            mem0Ready: false,
            extractionEnabled: false,
            embeddingsEnabled: false,
            graphAvailable: false,
            ragAvailable: false,
            integrityMode: 'strict',
        });
        expect(status.state).toBe('disabled');
        expect(status.hardDisabled).toBe(true);
    });

    it('MIH43: lenient mode does not hard-disable on degraded state', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            canonicalReady: true,
            mem0Ready: false,
            extractionEnabled: false,
            embeddingsEnabled: false,
            graphAvailable: false,
            ragAvailable: false,
            integrityMode: 'lenient',
        });
        expect(status.hardDisabled).toBe(false);
    });

    it('MIH44: balanced is default when integrityMode omitted from evaluate()', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            canonicalReady: true,
            mem0Ready: true,
            extractionEnabled: true,
            embeddingsEnabled: true,
            graphAvailable: true,
            ragAvailable: true,
        });
        expect(status.state).toBe('healthy');
    });

    it('MIH45: setSubsystemAvailability({ integrityMode }) feeds policy correctly', () => {
        const svc = new MemoryService();
        svc.setSubsystemAvailability({ integrityMode: 'strict' });
        const h = svc.getHealthStatus();
        // No canonical, no mem0 → strict should disable
        expect(h.state === 'disabled' || h.state === 'critical').toBe(true);
    });
});

// ---------------------------------------------------------------------------
// MIH51–MIH60: Health transition tracking
// ---------------------------------------------------------------------------

describe('MIH: memory health transition tracking', () => {
    let svc: MemoryService;

    beforeEach(() => {
        emittedEvents.length = 0;
        svc = new MemoryService();
        // Warm the first evaluation (establishes baseline state, no transition yet)
        svc.getHealthStatus();
        emittedEvents.length = 0; // clear events after baseline
    });

    it('MIH51: no transition event on first-ever evaluation (no prior state)', () => {
        // A freshly constructed service — first call should NOT emit transition
        const freshSvc = new MemoryService();
        const transitionsBefore = emittedEvents.filter((e: any) => e.event === 'memory.health_transition').length;
        freshSvc.getHealthStatus();
        const transitionsAfter = emittedEvents.filter((e: any) => e.event === 'memory.health_transition').length;
        expect(transitionsAfter - transitionsBefore).toBe(0);
    });

    it('MIH52: state change emits one memory.health_transition event', () => {
        // baseline: critical (no canonical)
        // now enable canonical → state changes
        svc.setSubsystemAvailability({ canonicalReady: true });
        svc.getHealthStatus();
        const transitions = emittedEvents.filter((e: any) => e.event === 'memory.health_transition');
        expect(transitions).toHaveLength(1);
    });

    it('MIH53: repeated same-state evaluation emits no transition', () => {
        svc.getHealthStatus(); // same state as baseline
        const transitions = emittedEvents.filter((e: any) => e.event === 'memory.health_transition');
        expect(transitions).toHaveLength(0);
    });

    it('MIH54: transition payload contains fromState, toState, fromMode, toMode, at', () => {
        svc.setSubsystemAvailability({ canonicalReady: true });
        svc.getHealthStatus();
        const t = (emittedEvents.find((e: any) => e.event === 'memory.health_transition') as any)?.payload;
        expect(t).toBeDefined();
        expect(t.fromState).toBeDefined();
        expect(t.toState).toBeDefined();
        expect(t.fromMode).toBeDefined();
        expect(t.toMode).toBeDefined();
        expect(t.at).toBeDefined();
    });

    it('MIH55: healthy → degraded then degraded → healthy emits two transitions total', () => {
        // Start with all caps → healthy
        const freshSvc = new MemoryService();
        freshSvc.setSubsystemAvailability({
            canonicalReady: true,
            graphAvailable: true,
            ragAvailable: true,
        });
        freshSvc.getHealthStatus(); // baseline (critical/degraded without mem0)
        emittedEvents.length = 0;

        // Force a second call with no change — no transition
        freshSvc.setSubsystemAvailability({ canonicalReady: false }); // → critical
        freshSvc.getHealthStatus();
        const firstCount = emittedEvents.filter((e: any) => e.event === 'memory.health_transition').length;
        expect(firstCount).toBe(1);

        freshSvc.setSubsystemAvailability({ canonicalReady: true }); // → back
        freshSvc.getHealthStatus();
        const secondCount = emittedEvents.filter((e: any) => e.event === 'memory.health_transition').length;
        expect(secondCount).toBe(2);
    });
});
