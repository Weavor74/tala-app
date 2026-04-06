/**
 * TelemetryBus.test.ts
 *
 * Unit tests for the runtime-local TelemetryBus.
 *
 * Covers:
 *   TB1  singleton    — getInstance always returns the same instance
 *   TB2  emit         — stamps id and timestamp; returns full event
 *   TB3  subscribe    — handler receives emitted events
 *   TB4  unsubscribe  — handler no longer receives events after removal
 *   TB5  unsub fn     — unsubscribe via returned closure
 *   TB6  multi-sub    — multiple subscribers all receive the same event
 *   TB7  error guard  — failing subscriber does not block other subscribers
 *   TB8  recent       — getRecentEvents returns up to 200 events in order
 *   TB9  ring buffer  — oldest events are evicted beyond 200
 *   TB10 isolation    — getRecentEvents returns a copy (mutation does not affect bus)
 *   TB11 lifecycle    — execution.created / accepted / completed event types accepted
 *   TB12 optional     — correlationId / phase / payload are optional
 *   TB13 override     — caller-supplied id and timestamp are preserved
 *   TB14 sub count    — subscriberCount tracks adds and removes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryBus } from '../electron/services/telemetry/TelemetryBus';
import type { RuntimeEvent, RuntimeEventHandler } from '../electron/services/telemetry/TelemetryBus';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePartial(overrides: Partial<Omit<RuntimeEvent, 'id' | 'timestamp'>> = {}): Omit<RuntimeEvent, 'id' | 'timestamp'> {
    return {
        executionId: 'exec-test-001',
        subsystem: 'kernel',
        event: 'execution.created',
        ...overrides,
    };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    TelemetryBus._resetForTesting();
});

// ─── TB1: singleton ───────────────────────────────────────────────────────────

describe('TB1: singleton', () => {
    it('returns the same instance on repeated calls', () => {
        const a = TelemetryBus.getInstance();
        const b = TelemetryBus.getInstance();
        expect(a).toBe(b);
    });

    it('returns a fresh instance after _resetForTesting', () => {
        const a = TelemetryBus.getInstance();
        TelemetryBus._resetForTesting();
        const b = TelemetryBus.getInstance();
        expect(a).not.toBe(b);
    });
});

// ─── TB2: emit ────────────────────────────────────────────────────────────────

describe('TB2: emit', () => {
    it('stamps id with tevt- prefix when not supplied', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit(makePartial());
        expect(evt.id).toMatch(/^tevt-/);
    });

    it('stamps ISO timestamp when not supplied', () => {
        const bus = TelemetryBus.getInstance();
        const before = new Date().toISOString();
        const evt = bus.emit(makePartial());
        const after = new Date().toISOString();
        expect(evt.timestamp >= before).toBe(true);
        expect(evt.timestamp <= after).toBe(true);
    });

    it('preserves executionId and event fields', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit(makePartial({ executionId: 'exec-abc', event: 'execution.accepted' }));
        expect(evt.executionId).toBe('exec-abc');
        expect(evt.event).toBe('execution.accepted');
    });

    it('returns the fully stamped event', () => {
        const bus = TelemetryBus.getInstance();
        const result = bus.emit(makePartial());
        expect(result).toMatchObject({ subsystem: 'kernel', event: 'execution.created' });
        expect(typeof result.id).toBe('string');
        expect(typeof result.timestamp).toBe('string');
    });
});

// ─── TB3: subscribe ───────────────────────────────────────────────────────────

describe('TB3: subscribe', () => {
    it('handler receives emitted event', () => {
        const bus = TelemetryBus.getInstance();
        const received: RuntimeEvent[] = [];
        bus.subscribe((evt) => received.push(evt));
        bus.emit(makePartial());
        expect(received).toHaveLength(1);
        expect(received[0].event).toBe('execution.created');
    });

    it('handler receives subsequent events', () => {
        const bus = TelemetryBus.getInstance();
        const received: RuntimeEvent[] = [];
        bus.subscribe((evt) => received.push(evt));
        bus.emit(makePartial({ event: 'execution.created' }));
        bus.emit(makePartial({ event: 'execution.accepted' }));
        bus.emit(makePartial({ event: 'execution.completed' }));
        expect(received).toHaveLength(3);
    });
});

// ─── TB4: unsubscribe ─────────────────────────────────────────────────────────

describe('TB4: unsubscribe', () => {
    it('handler does not receive events after unsubscribe', () => {
        const bus = TelemetryBus.getInstance();
        const received: RuntimeEvent[] = [];
        const handler: RuntimeEventHandler = (evt) => received.push(evt);
        bus.subscribe(handler);
        bus.emit(makePartial());
        bus.unsubscribe(handler);
        bus.emit(makePartial());
        expect(received).toHaveLength(1);
    });

    it('unsubscribe is a no-op for unknown handlers', () => {
        const bus = TelemetryBus.getInstance();
        expect(() => bus.unsubscribe(() => {})).not.toThrow();
    });
});

// ─── TB5: unsub fn ────────────────────────────────────────────────────────────

describe('TB5: unsub fn', () => {
    it('unsubscribe closure stops delivery', () => {
        const bus = TelemetryBus.getInstance();
        const received: RuntimeEvent[] = [];
        const unsub = bus.subscribe((evt) => received.push(evt));
        bus.emit(makePartial());
        unsub();
        bus.emit(makePartial());
        expect(received).toHaveLength(1);
    });
});

// ─── TB6: multi-sub ───────────────────────────────────────────────────────────

describe('TB6: multi-sub', () => {
    it('all subscribers receive the same event', () => {
        const bus = TelemetryBus.getInstance();
        const a: RuntimeEvent[] = [];
        const b: RuntimeEvent[] = [];
        bus.subscribe((evt) => a.push(evt));
        bus.subscribe((evt) => b.push(evt));
        const emitted = bus.emit(makePartial());
        expect(a[0]).toBe(emitted);
        expect(b[0]).toBe(emitted);
    });
});

// ─── TB7: error guard ─────────────────────────────────────────────────────────

describe('TB7: error guard', () => {
    it('failing subscriber does not prevent delivery to later subscribers', () => {
        const bus = TelemetryBus.getInstance();
        const received: RuntimeEvent[] = [];
        bus.subscribe(() => { throw new Error('boom'); });
        bus.subscribe((evt) => received.push(evt));
        expect(() => bus.emit(makePartial())).not.toThrow();
        expect(received).toHaveLength(1);
    });
});

// ─── TB8: recent ──────────────────────────────────────────────────────────────

describe('TB8: recent', () => {
    it('getRecentEvents returns emitted events in order', () => {
        const bus = TelemetryBus.getInstance();
        bus.emit(makePartial({ event: 'execution.created' }));
        bus.emit(makePartial({ event: 'execution.accepted' }));
        bus.emit(makePartial({ event: 'execution.completed' }));
        const recent = bus.getRecentEvents();
        expect(recent).toHaveLength(3);
        expect(recent[0].event).toBe('execution.created');
        expect(recent[1].event).toBe('execution.accepted');
        expect(recent[2].event).toBe('execution.completed');
    });

    it('returns empty array on fresh bus', () => {
        const bus = TelemetryBus.getInstance();
        expect(bus.getRecentEvents()).toHaveLength(0);
    });
});

// ─── TB9: ring buffer ─────────────────────────────────────────────────────────

describe('TB9: ring buffer', () => {
    it('evicts oldest events beyond 200', () => {
        const bus = TelemetryBus.getInstance();
        for (let i = 0; i < 205; i++) {
            bus.emit(makePartial({ executionId: `exec-${i}` }));
        }
        const recent = bus.getRecentEvents();
        expect(recent.length).toBe(200);
        // Oldest evicted events had executionId exec-0 through exec-4
        expect(recent[0].executionId).toBe('exec-5');
        expect(recent[199].executionId).toBe('exec-204');
    });
});

// ─── TB10: isolation ──────────────────────────────────────────────────────────

describe('TB10: isolation', () => {
    it('mutating getRecentEvents result does not affect bus state', () => {
        const bus = TelemetryBus.getInstance();
        bus.emit(makePartial());
        const copy = bus.getRecentEvents() as RuntimeEvent[];
        copy.splice(0, copy.length);
        expect(bus.getRecentEvents()).toHaveLength(1);
    });
});

// ─── TB11: lifecycle ──────────────────────────────────────────────────────────

describe('TB11: lifecycle', () => {
    it('accepts execution.created', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit(makePartial({ event: 'execution.created' }));
        expect(evt.event).toBe('execution.created');
    });

    it('accepts execution.accepted', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit(makePartial({ event: 'execution.accepted' }));
        expect(evt.event).toBe('execution.accepted');
    });

    it('accepts execution.completed', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit(makePartial({ event: 'execution.completed' }));
        expect(evt.event).toBe('execution.completed');
    });
});

// ─── TB12: optional ───────────────────────────────────────────────────────────

describe('TB12: optional', () => {
    it('event without optional fields is valid', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit({ executionId: 'exec-opt', subsystem: 'kernel', event: 'execution.created' });
        expect(evt.correlationId).toBeUndefined();
        expect(evt.phase).toBeUndefined();
        expect(evt.payload).toBeUndefined();
    });

    it('correlationId is preserved when supplied', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit(makePartial({ correlationId: 'corr-xyz' }));
        expect(evt.correlationId).toBe('corr-xyz');
    });

    it('phase is preserved when supplied', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit(makePartial({ phase: 'intake' }));
        expect(evt.phase).toBe('intake');
    });

    it('payload is preserved when supplied', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit(makePartial({ payload: { durationMs: 42 } }));
        expect(evt.payload).toEqual({ durationMs: 42 });
    });
});

// ─── TB13: override ───────────────────────────────────────────────────────────

describe('TB13: override', () => {
    it('preserves caller-supplied id', () => {
        const bus = TelemetryBus.getInstance();
        const evt = bus.emit({ ...makePartial(), id: 'tevt-custom-id' });
        expect(evt.id).toBe('tevt-custom-id');
    });

    it('preserves caller-supplied timestamp', () => {
        const bus = TelemetryBus.getInstance();
        const ts = '2024-01-01T00:00:00.000Z';
        const evt = bus.emit({ ...makePartial(), timestamp: ts });
        expect(evt.timestamp).toBe(ts);
    });
});

// ─── TB14: sub count ──────────────────────────────────────────────────────────

describe('TB14: sub count', () => {
    it('subscriberCount reflects added handlers', () => {
        const bus = TelemetryBus.getInstance();
        expect(bus.subscriberCount).toBe(0);
        bus.subscribe(() => {});
        bus.subscribe(() => {});
        expect(bus.subscriberCount).toBe(2);
    });

    it('subscriberCount decrements on unsubscribe', () => {
        const bus = TelemetryBus.getInstance();
        const handler: RuntimeEventHandler = () => {};
        bus.subscribe(handler);
        expect(bus.subscriberCount).toBe(1);
        bus.unsubscribe(handler);
        expect(bus.subscriberCount).toBe(0);
    });
});
