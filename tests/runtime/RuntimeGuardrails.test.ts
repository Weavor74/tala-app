import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailCircuitBreakerCoordinator } from '../../electron/services/runtime/guardrails/GuardrailCircuitBreaker';
import { executeWithRuntimeGuardrails } from '../../electron/services/runtime/guardrails/GuardrailExecutor';

const telemetryEvents: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];

vi.mock('../../electron/services/TelemetryService', () => ({
    telemetry: {
        operational: (
            _subsystem: string,
            eventType: string,
            _severity: string,
            _actor: string,
            _summary: string,
            _status: string,
            options?: { payload?: Record<string, unknown> },
        ) => {
            telemetryEvents.push({ eventType, payload: options?.payload });
        },
    },
}));

describe('Runtime guardrail primitives', () => {
    beforeEach(() => {
        telemetryEvents.length = 0;
    });

    it('retries and succeeds on a transient failure', async () => {
        const breaker = new GuardrailCircuitBreakerCoordinator({ failureThreshold: 3, resetAfterMs: 60_000 });
        let calls = 0;
        const result = await executeWithRuntimeGuardrails({
            domain: 'test',
            operationName: 'retryable_op',
            targetKey: 'retry-key',
            maxAttempts: 2,
            circuitBreaker: breaker,
            classifyFailure: () => 'runtime_error',
            shouldRetry: () => true,
            execute: async () => {
                calls++;
                if (calls === 1) throw new Error('transient');
                return 'ok';
            },
        });

        expect(result.ok).toBe(true);
        expect(result.value).toBe('ok');
        expect(calls).toBe(2);
        expect(telemetryEvents.some(e => e.eventType === 'guardrail.retry_scheduled')).toBe(true);
    });

    it('opens circuit breaker after threshold and short-circuits later calls', async () => {
        const breaker = new GuardrailCircuitBreakerCoordinator({ failureThreshold: 2, resetAfterMs: 60_000 });
        for (let i = 0; i < 2; i++) {
            const failure = await executeWithRuntimeGuardrails({
                domain: 'test',
                operationName: 'always_fail',
                targetKey: 'breaker-key',
                maxAttempts: 1,
                circuitBreaker: breaker,
                classifyFailure: () => 'runtime_error',
                shouldRetry: () => false,
                execute: async () => {
                    throw new Error('boom');
                },
            });
            expect(failure.ok).toBe(false);
        }

        const blocked = await executeWithRuntimeGuardrails({
            domain: 'test',
            operationName: 'always_fail',
            targetKey: 'breaker-key',
            maxAttempts: 1,
            circuitBreaker: breaker,
            execute: async () => 'should-not-run',
        });

        expect(blocked.ok).toBe(false);
        expect(blocked.shortCircuited).toBe(true);
        expect(telemetryEvents.some(e => e.eventType === 'guardrail.circuit_opened')).toBe(true);
        expect(telemetryEvents.some(e => e.eventType === 'guardrail.short_circuited')).toBe(true);
    });

    it('does not count policy denial as breaker failure when excluded', async () => {
        const breaker = new GuardrailCircuitBreakerCoordinator({ failureThreshold: 1, resetAfterMs: 60_000 });
        const denied = await executeWithRuntimeGuardrails({
            domain: 'test',
            operationName: 'policy_blocked',
            targetKey: 'policy-key',
            maxAttempts: 1,
            circuitBreaker: breaker,
            classifyFailure: () => 'policy_denied',
            shouldRetry: () => false,
            shouldCountFailureForCircuit: () => false,
            execute: async () => {
                const err = new Error('denied');
                err.name = 'PolicyDeniedError';
                throw err;
            },
        });

        expect(denied.ok).toBe(false);
        expect(breaker.currentState()).toBe('closed');
    });

    it('emits required telemetry payload contract fields', async () => {
        await executeWithRuntimeGuardrails({
            domain: 'inference',
            operationName: 'provider_stream_attempt',
            targetKey: 'provider-A',
            executionId: 'turn-1',
            maxAttempts: 1,
            execute: async () => 'done',
        });

        const started = telemetryEvents.find(e => e.eventType === 'guardrail.started');
        const succeeded = telemetryEvents.find(e => e.eventType === 'guardrail.succeeded');
        expect(started).toBeDefined();
        expect(succeeded).toBeDefined();
        for (const evt of [started, succeeded]) {
            expect(evt?.payload?.domain).toBeDefined();
            expect(evt?.payload?.operationName).toBeDefined();
            expect(evt?.payload?.targetKey).toBeDefined();
            expect('attempt' in (evt?.payload ?? {})).toBe(true);
            expect('durationMs' in (evt?.payload ?? {})).toBe(true);
            expect('failureKind' in (evt?.payload ?? {})).toBe(true);
            expect(evt?.payload?.circuitState).toBeDefined();
        }
    });
});
