import { telemetry } from '../TelemetryService';
import type { TelemetrySeverity, TelemetryStatus } from '../../../shared/telemetry';
import type {
    GuardrailsDiagnosticDecision,
    GuardrailsDiagnosticEventName,
    GuardrailsDiagnosticEventPayload,
    GuardrailsDiagnosticStatus,
} from '../../../shared/guardrails/guardrailsTelemetryTypes';

export interface GuardrailsTelemetryEventInput {
    eventName: GuardrailsDiagnosticEventName;
    actor: string;
    summary: string;
    status?: GuardrailsDiagnosticStatus;
    decision?: GuardrailsDiagnosticDecision;
    severity?: TelemetrySeverity;
    payload?: Omit<GuardrailsDiagnosticEventPayload, 'subsystem' | 'eventName' | 'status' | 'decision'>;
}

export interface IGuardrailsTelemetry {
    emit(input: GuardrailsTelemetryEventInput): void;
}

function toTelemetryStatus(status: GuardrailsDiagnosticStatus | undefined): TelemetryStatus {
    if (status === 'ready' || status === 'passed') return 'success';
    if (status === 'degraded') return 'partial';
    if (status === 'blocked' || status === 'failed') return 'failure';
    return 'unknown';
}

function inferSeverity(
    status: GuardrailsDiagnosticStatus | undefined,
    decision: GuardrailsDiagnosticDecision | undefined,
): TelemetrySeverity {
    if (decision === 'deny' || status === 'blocked' || status === 'failed') return 'error';
    if (decision === 'warn' || status === 'degraded') return 'warn';
    return 'info';
}

class GuardrailsTelemetry implements IGuardrailsTelemetry {
    emit(input: GuardrailsTelemetryEventInput): void {
        const emittedAt = new Date().toISOString();
        const status = input.status;
        const decision = input.decision;
        const severity = input.severity ?? inferSeverity(status, decision);
        const payload: GuardrailsDiagnosticEventPayload = {
            subsystem: 'guardrails',
            eventName: input.eventName,
            status,
            decision,
            timestamp: emittedAt,
            ...input.payload,
        };

        telemetry.operational(
            'guardrails',
            input.eventName,
            severity,
            input.actor,
            input.summary,
            toTelemetryStatus(status),
            {
                payload,
            },
        );
    }
}

export const guardrailsTelemetry: IGuardrailsTelemetry = new GuardrailsTelemetry();
