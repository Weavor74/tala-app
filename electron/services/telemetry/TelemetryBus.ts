/**
 * TelemetryBus.ts — Unified Runtime Event Spine
 *
 * Provides a lightweight, runtime-local publish/subscribe bus for structured
 * lifecycle events emitted across Tala subsystems.
 *
 * Design principles:
 * - Minimal footprint: no persistence, no external transports, no UI coupling
 * - Stable schema: event envelope is forward-compatible with Phase 2+ additions
 * - Deterministic: synchronous delivery to all subscribers; no async fan-out
 * - Safe: subscriber errors are caught and do not interrupt delivery
 *
 * Event vocabulary (initial lifecycle set):
 *   execution.created   — execution request received and registered
 *   execution.accepted  — request passed pre-flight; ready to begin
 *   execution.completed — execution finalized cleanly
 *
 * Future phases may add:
 *   execution.failed / execution.cancelled / execution.degraded / execution.blocked
 *   planning.* / context.* / inference.* / tool.* / memory.*
 *
 * Relationship to existing types:
 *   shared/runtime/executionTypes.ts  — RuntimeExecutionStatus, ExecutionRequest vocabulary
 *   shared/telemetry.ts               — CanonicalTelemetryEvent (broader per-turn schema)
 *   electron/services/kernel/AgentKernel.ts — primary first caller
 */

import { v4 as uuidv4 } from 'uuid';

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME EVENT SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subsystem that emitted the event.
 * Aligns with TelemetrySubsystem in shared/telemetry.ts.
 * Typed narrowly here so the bus does not depend on the full telemetry schema.
 */
export type RuntimeEventSubsystem =
    | 'kernel'
    | 'agent'
    | 'router'
    | 'autonomy'
    | 'planning'
    | 'inference'
    | 'memory'
    | 'mcp'
    | 'system'
    | 'unknown';

/**
 * Initial lifecycle event vocabulary for basic execution observability.
 *
 * Naming convention: `<domain>.<lifecycle_verb>`
 * The template literal tail `execution.${string}` is intentionally open so
 * Phase 2 can add execution.failed / execution.cancelled / execution.degraded
 * without breaking existing subscribers.
 */
export type RuntimeEventType =
    | 'execution.created'
    | 'execution.accepted'
    | 'execution.completed'
    | `execution.${string}`;

/**
 * Canonical runtime event envelope.
 *
 * Every significant lifecycle transition emitted through TelemetryBus must
 * conform to this shape. Fields are ordered from most stable (id, timestamp)
 * to most contextual (phase, payload).
 *
 * Redaction policy: raw user content and model prompts must never appear in
 * payload. Use summary strings or opaque identifiers only.
 */
export interface RuntimeEvent {
    /** Unique event ID — `tevt-<uuid v4>`. */
    id: string;
    /** ISO 8601 UTC timestamp of emission. */
    timestamp: string;
    /** ID of the execution this event belongs to. Matches ExecutionRequest.executionId. */
    executionId: string;
    /**
     * Optional correlation chain ID. Use to link related events across subsystems
     * (e.g. an autonomy task spawning a chat_turn).
     */
    correlationId?: string;
    /** Subsystem that emitted this event. */
    subsystem: RuntimeEventSubsystem;
    /** Lifecycle event type. */
    event: RuntimeEventType;
    /**
     * Optional sub-phase label within the event's lifecycle stage.
     * Examples: 'intake', 'classify', 'context_assembly', 'tool_dispatch'.
     * Subsystems define their own phase labels.
     */
    phase?: string;
    /**
     * Optional structured payload. Must not contain raw user content or model prompts.
     * Typed as `Record<string, unknown>` to remain open for future extension.
     */
    payload?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER TYPE
// ═══════════════════════════════════════════════════════════════════════════

/** Handler invoked synchronously for each emitted event. */
export type RuntimeEventHandler = (event: RuntimeEvent) => void;

// ═══════════════════════════════════════════════════════════════════════════
// TELEMETRY BUS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Maximum number of events retained in the recent-events ring buffer.
 * Bounded to avoid unbounded memory growth in long-running sessions.
 */
const MAX_RECENT_EVENTS = 200;

/**
 * TelemetryBus — runtime-local publish/subscribe event spine.
 *
 * Usage:
 *   const bus = TelemetryBus.getInstance();
 *   const unsub = bus.subscribe((evt) => console.log(evt));
 *   bus.emit({ executionId: 'exec-123', subsystem: 'kernel', event: 'execution.created' });
 *   unsub(); // or bus.unsubscribe(handler)
 */
export class TelemetryBus {
    private static _instance: TelemetryBus | undefined;

    private readonly _handlers: Set<RuntimeEventHandler> = new Set();
    private readonly _recentEvents: RuntimeEvent[] = [];

    private constructor() {}

    // ─── Singleton ────────────────────────────────────────────────────────────

    /**
     * Returns the process-wide singleton TelemetryBus instance.
     * Creates the instance on first call.
     */
    static getInstance(): TelemetryBus {
        if (!TelemetryBus._instance) {
            TelemetryBus._instance = new TelemetryBus();
        }
        return TelemetryBus._instance;
    }

    /**
     * Resets the singleton. Intended for use in tests only.
     * Clears all subscribers and the recent-events buffer.
     */
    static _resetForTesting(): void {
        TelemetryBus._instance = undefined;
    }

    // ─── Emit ─────────────────────────────────────────────────────────────────

    /**
     * Emits a runtime event to all registered subscribers.
     *
     * The bus stamps `id` and `timestamp` onto the event before delivery,
     * so callers do not need to supply them. Callers may supply their own
     * `id` and `timestamp` if pre-stamping is required (e.g. for correlation).
     *
     * Subscriber errors are caught individually; a failing subscriber does not
     * interrupt delivery to subsequent subscribers.
     *
     * @param partial - All required fields except `id` and `timestamp`.
     * @returns The fully-stamped RuntimeEvent that was delivered.
     */
    emit(partial: Omit<RuntimeEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: string }): RuntimeEvent {
        const event: RuntimeEvent = {
            id: partial.id ?? `tevt-${uuidv4()}`,
            timestamp: partial.timestamp ?? new Date().toISOString(),
            executionId: partial.executionId,
            subsystem: partial.subsystem,
            event: partial.event,
            ...(partial.correlationId !== undefined && { correlationId: partial.correlationId }),
            ...(partial.phase !== undefined && { phase: partial.phase }),
            ...(partial.payload !== undefined && { payload: partial.payload }),
        };

        this._appendRecent(event);

        for (const handler of this._handlers) {
            try {
                handler(event);
            } catch {
                // Subscriber errors must not interrupt delivery to other subscribers
            }
        }

        return event;
    }

    // ─── Subscribe ────────────────────────────────────────────────────────────

    /**
     * Registers a handler to receive all future events.
     *
     * @returns An unsubscribe function — call it to remove this handler.
     *          Equivalent to calling `bus.unsubscribe(handler)`.
     */
    subscribe(handler: RuntimeEventHandler): () => void {
        this._handlers.add(handler);
        return () => this.unsubscribe(handler);
    }

    // ─── Unsubscribe ──────────────────────────────────────────────────────────

    /**
     * Removes a previously registered handler.
     * No-op if the handler was not registered.
     */
    unsubscribe(handler: RuntimeEventHandler): void {
        this._handlers.delete(handler);
    }

    // ─── Recent Events ────────────────────────────────────────────────────────

    /**
     * Returns a snapshot of the most recent events (up to MAX_RECENT_EVENTS).
     * Useful for diagnostics and inspection without requiring a persistent store.
     * Returns a shallow copy of the buffer array; the caller must not mutate
     * the returned array. Individual event objects are shared references —
     * callers must not modify their properties.
     */
    getRecentEvents(): readonly RuntimeEvent[] {
        return this._recentEvents.slice();
    }

    // ─── Subscriber Count (diagnostics) ──────────────────────────────────────

    /** Returns the number of currently registered subscribers. */
    get subscriberCount(): number {
        return this._handlers.size;
    }

    // ─── Private ──────────────────────────────────────────────────────────────

    private _appendRecent(event: RuntimeEvent): void {
        this._recentEvents.push(event);
        if (this._recentEvents.length > MAX_RECENT_EVENTS) {
            this._recentEvents.shift();
        }
    }
}
