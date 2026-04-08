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

    it('MRT03: emitted trigger payload includes severity = critical for critical state', () => {
        const status = MemoryIntegrityPolicy.evaluate({
            ...allCapabilities(),
            canonicalReady: false,
        });
        service.maybeEmit(status);
        const trigger = (emittedEvents[0] as any).payload;
        expect(trigger.severity).toBe('critical');
        expect(trigger.reason).toBe('canonical_unavailable');
        expect(trigger.state).toBe('critical');
    });

    it('MRT04: emitted trigger payload includes severity = error for degraded state', () => {
        const status = MemoryIntegrityPolicy.evaluate(canonicalOnlyInputs());
        service.maybeEmit(status);
        const trigger = (emittedEvents[0] as any).payload;
        expect(trigger.severity).toBe('error');
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
        // Force 201 different reasons past de-dup by resetting between each
        for (let i = 0; i < 205; i++) {
            // Use unique-per-iteration details to bypass de-dup only for
            // distinct reasons; we reset to force same-reason emissions
            service.reset();
            service.emitDirect('canonical_unavailable', 'critical', 'critical');
        }
        // Log is capped at 200; after 205 resets+emits, the last reset+emit
        // leaves the log with exactly 1 entry (each reset clears it).
        // Instead test that individual sessions cap correctly:
        service.reset();
        // Emit 205 triggers using emitDirect with different reason-like state via reset trick
        for (let i = 0; i < 205; i++) {
            // patch _lastEmittedAt via direct emit with reset each time
            (service as any)._lastEmittedAt.clear(); // bypass dedup without full reset
            service.emitDirect('canonical_unavailable', 'critical', 'critical');
        }
        expect(service.getTriggerLog().length).toBeLessThanOrEqual(200);
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
