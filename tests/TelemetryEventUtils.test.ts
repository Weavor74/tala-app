/**
 * TelemetryEventUtils.test.ts
 *
 * Unit tests for the pure grouping, filtering, and derivation helpers in
 * src/renderer/utils/telemetryEventUtils.ts.
 *
 * Test groups:
 *   TEU1  getEventOrigin         — chat / autonomy / unknown classification
 *   TEU2  getGroupOrigin         — dominant origin for a group of events
 *   TEU3  getTerminalState       — completed / failed / in_progress
 *   TEU4  extractDurationMs      — durationMs from terminal-event payload
 *   TEU5  extractFailureReason   — failureReason from failed-event payload
 *   TEU6  groupEventsByExecution — grouping, ordering, sorting
 *   TEU7  filterGroups           — origin and state filtering
 *   TEU8  mixed schema           — chat and autonomy events co-exist in one list
 */

import { describe, it, expect } from 'vitest';
import {
    getEventOrigin,
    getGroupOrigin,
    getTerminalState,
    extractDurationMs,
    extractFailureReason,
    groupEventsByExecution,
    filterGroups,
    DEFAULT_FILTER,
} from '../src/renderer/utils/telemetryEventUtils';
import type { RuntimeEvent } from '../shared/runtimeEventTypes';

// ─── Factories ────────────────────────────────────────────────────────────────

let _seq = 0;
function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
    _seq++;
    return {
        id: `tevt-test-${_seq}`,
        timestamp: new Date(1_700_000_000_000 + _seq * 1000).toISOString(),
        executionId: 'exec-default',
        subsystem: 'kernel',
        event: 'execution.created',
        ...overrides,
    };
}

function makeChatLifecycle(executionId: string, base = 0): RuntimeEvent[] {
    const ts = (offset: number) => new Date(1_700_000_000_000 + base + offset).toISOString();
    return [
        makeEvent({ executionId, event: 'execution.created',   timestamp: ts(0), payload: { origin: 'kernel' } }),
        makeEvent({ executionId, event: 'execution.accepted',  timestamp: ts(100), phase: 'intake' }),
        makeEvent({ executionId, event: 'execution.finalizing',timestamp: ts(200), phase: 'finalizing', payload: { durationMs: 210, origin: 'kernel' } }),
        makeEvent({ executionId, event: 'execution.completed', timestamp: ts(300), payload: { durationMs: 310, origin: 'kernel' } }),
    ];
}

function makeAutonomyLifecycle(executionId: string, base = 0): RuntimeEvent[] {
    const ts = (offset: number) => new Date(1_700_000_000_000 + base + offset).toISOString();
    return [
        makeEvent({ executionId, event: 'execution.created',   timestamp: ts(0), payload: { origin: 'autonomy_engine', type: 'autonomy_task' } }),
        makeEvent({ executionId, event: 'execution.accepted',  timestamp: ts(100) }),
        makeEvent({ executionId, event: 'execution.completed', timestamp: ts(500), payload: { durationMs: 500, origin: 'autonomy_engine', type: 'autonomy_task' } }),
    ];
}

function makeFailedLifecycle(executionId: string, base = 0): RuntimeEvent[] {
    const ts = (offset: number) => new Date(1_700_000_000_000 + base + offset).toISOString();
    return [
        makeEvent({ executionId, event: 'execution.created',  timestamp: ts(0) }),
        makeEvent({ executionId, event: 'execution.accepted', timestamp: ts(50) }),
        makeEvent({ executionId, event: 'execution.failed',   timestamp: ts(75), phase: 'failed', payload: { failureReason: 'inference timeout', origin: 'kernel' } }),
    ];
}

// ─── TEU1: getEventOrigin ─────────────────────────────────────────────────────

describe('TEU1: getEventOrigin', () => {
    it('returns "autonomy" when payload.origin is autonomy_engine', () => {
        const ev = makeEvent({ payload: { origin: 'autonomy_engine' } });
        expect(getEventOrigin(ev)).toBe('autonomy');
    });

    it('returns "autonomy" when payload.type is autonomy_task', () => {
        const ev = makeEvent({ payload: { type: 'autonomy_task' } });
        expect(getEventOrigin(ev)).toBe('autonomy');
    });

    it('returns "chat" when payload.origin is kernel', () => {
        const ev = makeEvent({ payload: { origin: 'kernel' } });
        expect(getEventOrigin(ev)).toBe('chat');
    });

    it('returns "chat" when subsystem is kernel and no payload', () => {
        const ev = makeEvent({ subsystem: 'kernel' });
        expect(getEventOrigin(ev)).toBe('chat');
    });

    it('returns "unknown" when no origin indicator is present', () => {
        const ev = makeEvent({ subsystem: 'system', payload: {} });
        expect(getEventOrigin(ev)).toBe('unknown');
    });
});

// ─── TEU2: getGroupOrigin ─────────────────────────────────────────────────────

describe('TEU2: getGroupOrigin', () => {
    it('returns "autonomy" for a full autonomy lifecycle', () => {
        const events = makeAutonomyLifecycle('exec-a');
        expect(getGroupOrigin(events)).toBe('autonomy');
    });

    it('returns "chat" for a full chat lifecycle', () => {
        const events = makeChatLifecycle('exec-c');
        expect(getGroupOrigin(events)).toBe('chat');
    });

    it('returns "unknown" for events with no origin indicators', () => {
        const events = [makeEvent({ subsystem: 'system', payload: undefined })];
        expect(getGroupOrigin(events)).toBe('unknown');
    });
});

// ─── TEU3: getTerminalState ───────────────────────────────────────────────────

describe('TEU3: getTerminalState', () => {
    it('returns "completed" when last event is execution.completed', () => {
        expect(getTerminalState(makeChatLifecycle('x'))).toBe('completed');
    });

    it('returns "failed" when last event is execution.failed', () => {
        expect(getTerminalState(makeFailedLifecycle('x'))).toBe('failed');
    });

    it('returns "in_progress" when only created+accepted present', () => {
        const events = [
            makeEvent({ event: 'execution.created' }),
            makeEvent({ event: 'execution.accepted' }),
        ];
        expect(getTerminalState(events)).toBe('in_progress');
    });

    it('returns "in_progress" for empty event list', () => {
        expect(getTerminalState([])).toBe('in_progress');
    });

    it('returns "completed" even when finalizing appears after completed', () => {
        // Edge case: events arrived out of insertion order
        const events = [
            makeEvent({ event: 'execution.created',    timestamp: '2024-01-01T00:00:00.000Z' }),
            makeEvent({ event: 'execution.finalizing', timestamp: '2024-01-01T00:00:00.200Z' }),
            makeEvent({ event: 'execution.completed',  timestamp: '2024-01-01T00:00:00.300Z' }),
        ];
        expect(getTerminalState(events)).toBe('completed');
    });
});

// ─── TEU4: extractDurationMs ──────────────────────────────────────────────────

describe('TEU4: extractDurationMs', () => {
    it('extracts durationMs from execution.completed payload', () => {
        expect(extractDurationMs(makeChatLifecycle('x'))).toBe(310);
    });

    it('extracts durationMs from execution.failed payload when present', () => {
        const events = [
            makeEvent({ event: 'execution.failed', payload: { durationMs: 75, failureReason: 'oops' } }),
        ];
        expect(extractDurationMs(events)).toBe(75);
    });

    it('returns undefined when no terminal event has durationMs', () => {
        const events = [makeEvent({ event: 'execution.created' })];
        expect(extractDurationMs(events)).toBeUndefined();
    });

    it('prefers terminal event over finalizing event', () => {
        // Both finalizing (210ms) and completed (310ms) carry durationMs;
        // completed is later so it should win (scan from end).
        expect(extractDurationMs(makeChatLifecycle('x'))).toBe(310);
    });
});

// ─── TEU5: extractFailureReason ───────────────────────────────────────────────

describe('TEU5: extractFailureReason', () => {
    it('returns failureReason from failed event', () => {
        expect(extractFailureReason(makeFailedLifecycle('x'))).toBe('inference timeout');
    });

    it('returns undefined when no failed event is present', () => {
        expect(extractFailureReason(makeChatLifecycle('x'))).toBeUndefined();
    });

    it('returns undefined when failed event has no failureReason', () => {
        const events = [makeEvent({ event: 'execution.failed', payload: {} })];
        expect(extractFailureReason(events)).toBeUndefined();
    });
});

// ─── TEU6: groupEventsByExecution ────────────────────────────────────────────

describe('TEU6: groupEventsByExecution', () => {
    it('produces one group per executionId', () => {
        const events = [
            ...makeChatLifecycle('exec-1', 0),
            ...makeAutonomyLifecycle('exec-2', 10_000),
        ];
        const groups = groupEventsByExecution(events);
        expect(groups).toHaveLength(2);
    });

    it('sorts events within each group ascending by timestamp', () => {
        // Supply events in reverse order for exec-1
        const chatEvents = makeChatLifecycle('exec-1');
        const shuffled = [...chatEvents].reverse();
        const groups = groupEventsByExecution(shuffled);
        const g = groups.find((x) => x.executionId === 'exec-1')!;
        expect(g.events[0].event).toBe('execution.created');
        expect(g.events[g.events.length - 1].event).toBe('execution.completed');
    });

    it('orders groups most-recent first (descending startedAt)', () => {
        const events = [
            ...makeChatLifecycle('exec-old', 0),
            ...makeAutonomyLifecycle('exec-new', 100_000),
        ];
        const groups = groupEventsByExecution(events);
        expect(groups[0].executionId).toBe('exec-new');
        expect(groups[1].executionId).toBe('exec-old');
    });

    it('derives correct terminalState for each group', () => {
        const events = [
            ...makeChatLifecycle('exec-ok', 0),
            ...makeFailedLifecycle('exec-fail', 10_000),
        ];
        const groups = groupEventsByExecution(events);
        const ok   = groups.find((g) => g.executionId === 'exec-ok')!;
        const fail = groups.find((g) => g.executionId === 'exec-fail')!;
        expect(ok.terminalState).toBe('completed');
        expect(fail.terminalState).toBe('failed');
    });

    it('sets durationMs on each group from terminal event payload', () => {
        const groups = groupEventsByExecution(makeChatLifecycle('exec-dur'));
        expect(groups[0].durationMs).toBe(310);
    });

    it('sets failureReason on failed groups', () => {
        const groups = groupEventsByExecution(makeFailedLifecycle('exec-f'));
        expect(groups[0].failureReason).toBe('inference timeout');
    });

    it('does not mutate the input array', () => {
        const events = makeChatLifecycle('exec-immut');
        const len = events.length;
        groupEventsByExecution(events);
        expect(events).toHaveLength(len);
    });

    it('returns empty array for empty input', () => {
        expect(groupEventsByExecution([])).toEqual([]);
    });
});

// ─── TEU7: filterGroups ───────────────────────────────────────────────────────

describe('TEU7: filterGroups', () => {
    const events = [
        ...makeChatLifecycle('exec-chat-ok',   0),
        ...makeAutonomyLifecycle('exec-auto-ok', 10_000),
        ...makeFailedLifecycle('exec-chat-fail', 20_000),
    ];

    it('DEFAULT_FILTER returns all groups', () => {
        const groups = groupEventsByExecution(events);
        expect(filterGroups(groups, DEFAULT_FILTER)).toHaveLength(3);
    });

    it('origin=chat returns only chat groups', () => {
        const groups = groupEventsByExecution(events);
        const filtered = filterGroups(groups, { origin: 'chat', state: 'all' });
        expect(filtered).toHaveLength(2);
        expect(filtered.every((g) => g.origin === 'chat')).toBe(true);
    });

    it('origin=autonomy returns only autonomy groups', () => {
        const groups = groupEventsByExecution(events);
        const filtered = filterGroups(groups, { origin: 'autonomy', state: 'all' });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].origin).toBe('autonomy');
    });

    it('state=failed returns only failed groups', () => {
        const groups = groupEventsByExecution(events);
        const filtered = filterGroups(groups, { origin: 'all', state: 'failed' });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].terminalState).toBe('failed');
    });

    it('state=completed returns only completed groups', () => {
        const groups = groupEventsByExecution(events);
        const filtered = filterGroups(groups, { origin: 'all', state: 'completed' });
        expect(filtered).toHaveLength(2);
        expect(filtered.every((g) => g.terminalState === 'completed')).toBe(true);
    });

    it('combined origin+state filter works', () => {
        const groups = groupEventsByExecution(events);
        const filtered = filterGroups(groups, { origin: 'chat', state: 'failed' });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].executionId).toBe('exec-chat-fail');
    });

    it('does not mutate the input groups array', () => {
        const groups = groupEventsByExecution(events);
        const len = groups.length;
        filterGroups(groups, { origin: 'chat', state: 'all' });
        expect(groups).toHaveLength(len);
    });
});

// ─── TEU8: mixed schema ───────────────────────────────────────────────────────

describe('TEU8: mixed chat+autonomy schema parity', () => {
    it('chat and autonomy events produce identically shaped ExecutionGroups', () => {
        const chatGroup   = groupEventsByExecution(makeChatLifecycle('exec-c'))[0];
        const autoGroup   = groupEventsByExecution(makeAutonomyLifecycle('exec-a'))[0];

        // Both have all required fields
        expect(typeof chatGroup.executionId).toBe('string');
        expect(typeof autoGroup.executionId).toBe('string');
        expect(typeof chatGroup.startedAt).toBe('string');
        expect(typeof autoGroup.startedAt).toBe('string');
        expect(chatGroup.terminalState).toBe('completed');
        expect(autoGroup.terminalState).toBe('completed');
        expect(chatGroup.durationMs).toBeTypeOf('number');
        expect(autoGroup.durationMs).toBeTypeOf('number');
    });

    it('a flat list with interleaved chat and autonomy events produces correct groups', () => {
        const chatEvents = makeChatLifecycle('exec-c', 0);
        const autoEvents = makeAutonomyLifecycle('exec-a', 5_000);
        // Interleave by taking every other event from each source
        const interleaved: RuntimeEvent[] = [];
        const len = Math.max(chatEvents.length, autoEvents.length);
        for (let i = 0; i < len; i++) {
            if (chatEvents[i]) interleaved.push(chatEvents[i]);
            if (autoEvents[i]) interleaved.push(autoEvents[i]);
        }
        const groups = groupEventsByExecution(interleaved);
        expect(groups).toHaveLength(2);
        const c = groups.find((g) => g.executionId === 'exec-c')!;
        const a = groups.find((g) => g.executionId === 'exec-a')!;
        expect(c.origin).toBe('chat');
        expect(a.origin).toBe('autonomy');
        // Events for each group are correctly separated
        expect(c.events.every((e) => e.executionId === 'exec-c')).toBe(true);
        expect(a.events.every((e) => e.executionId === 'exec-a')).toBe(true);
    });
});
