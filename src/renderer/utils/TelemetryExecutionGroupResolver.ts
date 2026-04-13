/**
 * TelemetryExecutionGroupResolver.ts
 *
 * Pure utility functions for grouping and analyzing RuntimeEvent arrays
 * from the TelemetryBus ring buffer.
 *
 * These helpers are kept framework-free so they can be unit-tested in the
 * Node/Vitest environment without a browser/React context.
 *
 * Consumed by: src/renderer/components/TelemetryEventsPanel.tsx
 */

import type { RuntimeEvent } from '../../../shared/runtimeEventTypes';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Terminal state of an execution derived from its event sequence. */
export type ExecutionTerminalState = 'completed' | 'failed' | 'in_progress';

/** Origin label derived from event payload or subsystem. */
export type ExecutionOrigin = 'chat' | 'autonomy' | 'unknown';

/** All events belonging to one executionId, with derived summary fields. */
export interface ExecutionGroup {
    executionId: string;
    origin: ExecutionOrigin;
    /** ISO timestamp of the earliest event in this group. */
    startedAt: string;
    /** ISO timestamp of the latest event in this group. */
    lastEventAt: string;
    terminalState: ExecutionTerminalState;
    /** durationMs from the payload of the terminal event, if present. */
    durationMs: number | undefined;
    /** failureReason from the payload of the terminal event, if present. */
    failureReason: string | undefined;
    /** Events ordered ascending by timestamp. */
    events: RuntimeEvent[];
}

// ─── Origin derivation ────────────────────────────────────────────────────────

/**
 * Returns the origin of a single RuntimeEvent.
 *
 * Payload contract (emitted by AgentKernel and AutonomousRunOrchestrator):
 *   Chat runs:     payload.origin = 'kernel'   (or absent/subsystem fallback)
 *   Autonomy runs: payload.origin = 'autonomy_engine'
 *                  payload.type   = 'autonomy_task'
 */
export function getEventOrigin(event: RuntimeEvent): ExecutionOrigin {
    const p = event.payload ?? {};
    if (p['origin'] === 'autonomy_engine' || p['type'] === 'autonomy_task') return 'autonomy';
    if (p['origin'] === 'kernel' || event.subsystem === 'kernel') return 'chat';
    return 'unknown';
}

/**
 * Returns the dominant origin for a group of events belonging to one execution.
 * Checks events in order and returns the first non-unknown origin it finds,
 * since all events for a given execution share the same origin.
 */
export function getGroupOrigin(events: RuntimeEvent[]): ExecutionOrigin {
    for (const ev of events) {
        const o = getEventOrigin(ev);
        if (o !== 'unknown') return o;
    }
    // Fallback: use the subsystem of the first event.
    const first = events[0];
    if (first?.subsystem === 'kernel') return 'chat';
    if (first?.subsystem === 'autonomy') return 'autonomy';
    return 'unknown';
}

// ─── Terminal state ───────────────────────────────────────────────────────────

/** Terminal event verbs — the last lifecycle step in a sequence. */
const TERMINAL_VERBS = new Set(['completed', 'failed']);

/**
 * Derives the terminal state of an execution from its ordered event list.
 * Returns the state based on the latest terminal event found, or
 * 'in_progress' when no terminal event is present yet.
 */
export function getTerminalState(events: RuntimeEvent[]): ExecutionTerminalState {
    // Scan from newest to oldest (events are ordered ascending, so reverse scan).
    for (let i = events.length - 1; i >= 0; i--) {
        const verb = events[i].event.split('.').pop() ?? '';
        if (verb === 'completed') return 'completed';
        if (verb === 'failed')    return 'failed';
    }
    return 'in_progress';
}

// ─── Payload extraction ───────────────────────────────────────────────────────

/**
 * Returns the durationMs from the terminal event payload, if present.
 * Looks from the end of the list (terminal events carry durationMs).
 */
export function deriveDurationMsFromEvents(events: RuntimeEvent[]): number | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
        const verb = events[i].event.split('.').pop() ?? '';
        if (TERMINAL_VERBS.has(verb) || verb === 'finalizing') {
            const val = events[i].payload?.['durationMs'];
            if (typeof val === 'number') return val;
        }
    }
    return undefined;
}

/**
 * Returns the failureReason from the failed event payload, if present.
 */
export function deriveFailureReasonFromEvents(events: RuntimeEvent[]): string | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
        const verb = events[i].event.split('.').pop() ?? '';
        if (verb === 'failed') {
            const val = events[i].payload?.['failureReason'];
            if (val != null) return String(val);
        }
    }
    return undefined;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Groups a flat RuntimeEvent array by executionId, sorts each group's events
 * by timestamp ascending, and derives summary fields.
 *
 * The returned groups are ordered by their first-event timestamp descending
 * (most recent execution first), so the debug surface shows the latest activity
 * at the top.
 *
 * This function is pure: it does not mutate the input array.
 */
export function deriveExecutionGroupsByExecutionId(events: RuntimeEvent[]): ExecutionGroup[] {
    // Build a map from executionId → events
    const map = new Map<string, RuntimeEvent[]>();
    for (const ev of events) {
        const bucket = map.get(ev.executionId);
        if (bucket) {
            bucket.push(ev);
        } else {
            map.set(ev.executionId, [ev]);
        }
    }

    const groups: ExecutionGroup[] = [];
    for (const [executionId, rawEvents] of map.entries()) {
        // Sort events ascending by timestamp
        const sorted = [...rawEvents].sort((a, b) =>
            a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
        );

        groups.push({
            executionId,
            origin: getGroupOrigin(sorted),
            startedAt: sorted[0].timestamp,
            lastEventAt: sorted[sorted.length - 1].timestamp,
            terminalState: getTerminalState(sorted),
            durationMs: deriveDurationMsFromEvents(sorted),
            failureReason: deriveFailureReasonFromEvents(sorted),
            events: sorted,
        });
    }

    // Most-recent execution first
    groups.sort((a, b) =>
        a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
    );

    return groups;
}

// ─── Filtering ────────────────────────────────────────────────────────────────

/** Options for filtering the execution group list. */
export interface ExecutionGroupFilter {
    /** 'all' | 'chat' | 'autonomy' */
    origin: 'all' | ExecutionOrigin;
    /** 'all' | 'completed' | 'failed' | 'in_progress' */
    state: 'all' | ExecutionTerminalState;
}

export const DEFAULT_FILTER: ExecutionGroupFilter = { origin: 'all', state: 'all' };

/**
 * Applies the given filter to a list of ExecutionGroups.
 * Returns a new array (does not mutate input).
 */
export function selectExecutionGroups(
    groups: ExecutionGroup[],
    filter: ExecutionGroupFilter,
): ExecutionGroup[] {
    return groups.filter((g) => {
        if (filter.origin !== 'all' && g.origin !== filter.origin) return false;
        if (filter.state  !== 'all' && g.terminalState !== filter.state)  return false;
        return true;
    });
}

