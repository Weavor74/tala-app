/**
 * TelemetryService — Canonical Event Emission Utility
 *
 * Phase 2 Trustworthiness Hardening — Objective 6
 *
 * Provides a single, normalized API for emitting structured telemetry events
 * across all TALA subsystems. All services should use this service rather than
 * directly calling AuditLogger with ad hoc payloads.
 *
 * Design principles:
 * - Every event carries a full canonical envelope (see shared/telemetry.ts).
 * - Sensitive content is never written to the payload (redaction is enforced).
 * - Events are emitted synchronously via the existing AuditLogger JSONL pipeline.
 * - Turn reconstruction is supported via TurnReconstructionBuilder.
 * - Developer debug events are silenced in production (NODE_ENV=production).
 */

import { v4 as uuidv4 } from 'uuid';
import { auditLogger } from './AuditLogger';
import { redact } from './log_redact';
import type {
    CanonicalTelemetryEvent,
    TelemetrySubsystem,
    TelemetryEventType,
    TelemetrySeverity,
    TelemetryStatus,
    TelemetryChannel,
    TurnReconstruction,
} from '../../shared/telemetry';

// ─── Emission options ─────────────────────────────────────────────────────────

export interface EmitOptions {
    turnId?: string;
    correlationId?: string;
    sessionId?: string;
    mode?: string;
    payload?: Record<string, unknown>;
}

// ─── TelemetryService ─────────────────────────────────────────────────────────

/**
 * Singleton telemetry service used by all electron-side subsystems.
 *
 * Usage:
 *   import { telemetry } from './TelemetryService';
 *   telemetry.emit('inference', 'inference_started', 'info', 'InferenceService', 'Inference started', { turnId, ... });
 */
export class TelemetryService {
    private static instance: TelemetryService | null = null;

    private isProductionMode: boolean;

    private constructor() {
        this.isProductionMode = process.env.NODE_ENV === 'production';
    }

    public static getInstance(): TelemetryService {
        if (!TelemetryService.instance) {
            TelemetryService.instance = new TelemetryService();
        }
        return TelemetryService.instance;
    }

    /**
     * Reset singleton — only used in tests.
     */
    public static reset(): void {
        TelemetryService.instance = null;
    }

    // ------------------------------------------------------------------
    // Core emission API
    // ------------------------------------------------------------------

    /**
     * Emits a canonical telemetry event.
     *
     * @param subsystem - The subsystem emitting the event.
     * @param eventType - The specific event type.
     * @param severity - Severity level.
     * @param actor - The service or component name.
     * @param summary - Human-readable summary (no sensitive content).
     * @param status - Success/failure/partial/suppressed status.
     * @param options - Optional context: turnId, correlationId, sessionId, mode, payload.
     * @returns The emitted event (useful for testing).
     */
    public emit(
        subsystem: TelemetrySubsystem,
        eventType: TelemetryEventType,
        severity: TelemetrySeverity,
        actor: string,
        summary: string,
        status: TelemetryStatus,
        options: EmitOptions = {}
    ): CanonicalTelemetryEvent {
        const channel = this.resolveChannel(eventType, severity);

        // Suppress debug events in production
        if (channel === 'debug' && this.isProductionMode) {
            return this.buildEvent(subsystem, eventType, severity, actor, summary, status, channel, options);
        }

        const event = this.buildEvent(subsystem, eventType, severity, actor, summary, status, channel, options);

        // Emit via existing AuditLogger pipeline (preserves JSONL format)
        auditLogger.info(
            eventType,
            actor,
            {
                telemetry: true,
                eventId: event.eventId,
                turnId: event.turnId,
                correlationId: event.correlationId,
                sessionId: event.sessionId,
                subsystem: event.subsystem,
                severity: event.severity,
                mode: event.mode,
                summary: event.summary,
                status: event.status,
                channel: event.channel,
                payload: redact(event.payload),
            },
            event.correlationId
        );

        return event;
    }

    // ------------------------------------------------------------------
    // Convenience helpers
    // ------------------------------------------------------------------

    public audit(
        subsystem: TelemetrySubsystem,
        eventType: TelemetryEventType,
        actor: string,
        summary: string,
        status: TelemetryStatus,
        options: EmitOptions = {}
    ): CanonicalTelemetryEvent {
        return this.emit(subsystem, eventType, 'info', actor, summary, status, options);
    }

    public operational(
        subsystem: TelemetrySubsystem,
        eventType: TelemetryEventType,
        severity: TelemetrySeverity,
        actor: string,
        summary: string,
        status: TelemetryStatus,
        options: EmitOptions = {}
    ): CanonicalTelemetryEvent {
        return this.emit(subsystem, eventType, severity, actor, summary, status, options);
    }

    public debug(
        subsystem: TelemetrySubsystem,
        eventType: TelemetryEventType,
        actor: string,
        summary: string,
        options: EmitOptions = {}
    ): CanonicalTelemetryEvent {
        return this.emit(subsystem, eventType, 'debug', actor, summary, 'success', options);
    }

    // ------------------------------------------------------------------
    // Turn reconstruction builder
    // ------------------------------------------------------------------

    /**
     * Assembles a TurnReconstruction from a set of telemetry events.
     * Supports human diagnosis of a complete agent turn.
     */
    public reconstructTurn(events: CanonicalTelemetryEvent[]): TurnReconstruction | null {
        if (events.length === 0) return null;

        const turnId = events[0].turnId;
        const sessionId = events[0].sessionId;
        const startEvent = events.find(e => e.eventType === 'turn_start');
        const completedEvent = events.find(e => e.eventType === 'turn_completed');

        const inferenceEvents = events.filter(e =>
            e.eventType === 'inference_started' ||
            e.eventType === 'inference_completed' ||
            e.eventType === 'inference_failed' ||
            e.eventType === 'inference_timeout'
        );

        const docEvent = events.find(e => e.eventType === 'doc_retrieval_completed');
        const docSuppressed = events.find(e => e.eventType === 'doc_retrieval_suppressed');
        const memoryEvent = events.find(e => e.eventType === 'memory_retrieved');
        const memoryWriteEvent = events.find(e => e.eventType === 'memory_write_decision');
        const artifactEvent = events.find(e => e.eventType === 'artifact_routed');
        const reflectionEvent = events.find(e => e.eventType === 'reflection_triggered');
        const fallbackEvent = events.find(e => e.eventType === 'degraded_fallback');

        const hadErrors = events.some(e => e.severity === 'error' || e.status === 'failure');
        const toolCallEvents = events.filter(e => e.eventType === 'mcp_tool_invoked');

        const startedAt = startEvent?.timestamp ?? events[0].timestamp;
        const completedAt = completedEvent?.timestamp;
        const durationMs = startedAt && completedAt
            ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
            : undefined;

        const inferenceCompleted = inferenceEvents.find(e => e.eventType === 'inference_completed');
        const inferenceFailed = inferenceEvents.find(
            e => e.eventType === 'inference_failed' || e.eventType === 'inference_timeout'
        );

        let inferenceProvider: string | undefined;
        let inferenceModel: string | undefined;
        let inferenceDurationMs: number | undefined;
        let inferenceStatus: TelemetryStatus = 'unknown';

        if (inferenceCompleted) {
            inferenceProvider = inferenceCompleted.payload.provider as string | undefined;
            inferenceModel = inferenceCompleted.payload.modelName as string | undefined;
            inferenceDurationMs = inferenceCompleted.payload.requestDurationMs as number | undefined;
            inferenceStatus = 'success';
        } else if (inferenceFailed) {
            inferenceStatus = 'failure';
        }

        const modeEvent = events.find(e => e.eventType === 'mode_applied');
        const mode = modeEvent?.mode ?? startEvent?.mode ?? 'unknown';

        const intentEvent = events.find(e => e.eventType === 'context_assembled');
        const intent = intentEvent?.payload?.intent as string | undefined;

        return {
            turnId,
            sessionId,
            mode,
            startedAt,
            completedAt,
            durationMs,
            intent,
            memoryRetrieved: !!memoryEvent && memoryEvent.status !== 'suppressed',
            memoryWriteCategory: memoryWriteEvent?.payload?.writeCategory as string | undefined,
            inferenceProvider,
            inferenceModel,
            inferenceDurationMs,
            inferenceStatus,
            artifactChannel: artifactEvent?.payload?.channel as string | undefined,
            docRetrievalOccurred: !!docEvent && !docSuppressed,
            docSources: (docEvent?.payload?.sources as string[] | undefined),
            reflectionTriggered: !!reflectionEvent,
            hadErrors,
            hadDegradedFallback: !!fallbackEvent,
            toolCallCount: toolCallEvents.length,
            eventSequence: events.map(e => ({
                eventType: e.eventType,
                timestamp: e.timestamp,
                status: e.status,
            })),
        };
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private buildEvent(
        subsystem: TelemetrySubsystem,
        eventType: TelemetryEventType,
        severity: TelemetrySeverity,
        actor: string,
        summary: string,
        status: TelemetryStatus,
        channel: TelemetryChannel,
        options: EmitOptions
    ): CanonicalTelemetryEvent {
        return {
            timestamp: new Date().toISOString(),
            eventId: uuidv4(),
            turnId: options.turnId ?? auditLogger.getCorrelationId() ?? 'global',
            correlationId: options.correlationId,
            sessionId: options.sessionId ?? auditLogger.getSessionId() ?? 'none',
            subsystem,
            eventType,
            severity,
            mode: options.mode ?? 'unknown',
            actor,
            summary,
            payload: options.payload ?? {},
            status,
            channel,
        };
    }

    private resolveChannel(eventType: TelemetryEventType, severity: TelemetrySeverity): TelemetryChannel {
        if (severity === 'debug' || eventType === 'developer_debug') return 'debug';

        const auditTypes: TelemetryEventType[] = [
            'turn_start',
            'turn_completed',
            'memory_write_decision',
            'capability_gated',
            'inference_failed',
            'inference_timeout',
            'reflection_triggered',
            'reflection_completed',
            'degraded_fallback',
            'artifact_routed',
            'doc_retrieval_completed',
        ];

        if (auditTypes.includes(eventType)) return 'audit';
        return 'operational';
    }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const telemetry = TelemetryService.getInstance();
