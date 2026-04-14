import { telemetry } from '../../TelemetryService';
import type {
    GuardrailCircuitState,
    GuardrailFailureKind,
} from './RuntimeGuardrailTypes';

type GuardrailEventName =
    | 'guardrail.started'
    | 'guardrail.attempt_started'
    | 'guardrail.attempt_failed'
    | 'guardrail.retry_scheduled'
    | 'guardrail.circuit_opened'
    | 'guardrail.short_circuited'
    | 'guardrail.succeeded'
    | 'guardrail.failed';

interface GuardrailTelemetryInput {
    eventType: GuardrailEventName;
    domain: string;
    operationName: string;
    targetKey: string;
    executionId?: string;
    attempt?: number;
    durationMs?: number;
    failureKind?: GuardrailFailureKind;
    circuitState: GuardrailCircuitState;
    status?: 'success' | 'failure' | 'partial' | 'suppressed' | 'unknown';
    extra?: Record<string, unknown>;
}

function inferSeverity(eventType: GuardrailEventName): 'info' | 'warn' | 'error' {
    if (eventType === 'guardrail.attempt_failed' || eventType === 'guardrail.failed') return 'error';
    if (
        eventType === 'guardrail.retry_scheduled' ||
        eventType === 'guardrail.circuit_opened' ||
        eventType === 'guardrail.short_circuited'
    ) return 'warn';
    return 'info';
}

function inferStatus(input: GuardrailTelemetryInput): 'success' | 'failure' | 'partial' | 'suppressed' | 'unknown' {
    if (input.status) return input.status;
    if (input.eventType === 'guardrail.succeeded') return 'success';
    if (input.eventType === 'guardrail.failed' || input.eventType === 'guardrail.attempt_failed') return 'failure';
    if (input.eventType === 'guardrail.retry_scheduled') return 'partial';
    return 'unknown';
}

export function emitGuardrailTelemetry(input: GuardrailTelemetryInput): void {
    telemetry.operational(
        'guardrails',
        input.eventType,
        inferSeverity(input.eventType),
        'RuntimeGuardrailExecutor',
        `${input.domain}/${input.operationName} -> ${input.eventType}`,
        inferStatus(input),
        {
            turnId: input.executionId,
            payload: {
                domain: input.domain,
                operationName: input.operationName,
                targetKey: input.targetKey,
                attempt: input.attempt,
                durationMs: input.durationMs,
                failureKind: input.failureKind,
                circuitState: input.circuitState,
                ...(input.extra ?? {}),
            },
        },
    );
}
