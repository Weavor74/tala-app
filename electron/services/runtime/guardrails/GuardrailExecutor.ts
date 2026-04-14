import { resolveGuardrailBackoff, runBackoffDelay } from './GuardrailBackoff';
import { emitGuardrailTelemetry } from './GuardrailTelemetry';
import type {
    GuardrailAttemptResult,
    GuardrailExecuteOptions,
    GuardrailFailureKind,
    GuardrailRunResult,
} from './RuntimeGuardrailTypes';

class GuardrailTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GuardrailTimeoutError';
    }
}

function defaultFailureKind(error: unknown): GuardrailFailureKind {
    if (error instanceof GuardrailTimeoutError) return 'timeout';
    const named = (error as { name?: string } | null)?.name ?? '';
    if (named === 'PolicyDeniedError') return 'policy_denied';
    if (named === 'AbortError') return 'aborted';
    return 'runtime_error';
}

async function runWithTimeout<T>(
    timeoutMs: number | undefined,
    execute: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) {
        return execute(undefined);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort(new GuardrailTimeoutError(`Operation timed out after ${timeoutMs}ms`));
            reject(new GuardrailTimeoutError(`Operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([execute(controller.signal), timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function executeWithRuntimeGuardrails<T>(
    opts: GuardrailExecuteOptions<T>,
): Promise<GuardrailRunResult<T>> {
    const startedAt = Date.now();
    const maxAttempts = Math.max(1, opts.maxAttempts);

    emitGuardrailTelemetry({
        eventType: 'guardrail.started',
        domain: opts.domain,
        operationName: opts.operationName,
        targetKey: opts.targetKey,
        executionId: opts.executionId,
        circuitState: opts.circuitBreaker?.currentState() ?? 'closed',
    });

    const initialBreakerState = opts.circuitBreaker?.beforeExecution(Date.now());
    if (initialBreakerState && !initialBreakerState.allowed) {
        emitGuardrailTelemetry({
            eventType: 'guardrail.short_circuited',
            domain: opts.domain,
            operationName: opts.operationName,
            targetKey: opts.targetKey,
            executionId: opts.executionId,
            circuitState: initialBreakerState.state,
        });
        return {
            ok: false,
            attempts: 0,
            durationMs: Date.now() - startedAt,
            shortCircuited: true,
            failureKind: 'runtime_error',
            error: new Error(`Circuit open for ${opts.targetKey}`),
            circuitState: initialBreakerState.state,
        };
    }

    let lastAttempt: GuardrailAttemptResult<T> | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        emitGuardrailTelemetry({
            eventType: 'guardrail.attempt_started',
            domain: opts.domain,
            operationName: opts.operationName,
            targetKey: opts.targetKey,
            executionId: opts.executionId,
            attempt,
            circuitState: opts.circuitBreaker?.currentState() ?? 'closed',
        });

        const attemptStartedAt = Date.now();
        try {
            const value = await runWithTimeout(opts.timeoutMs, (signal) => opts.execute(attempt, signal));
            const newState = opts.circuitBreaker?.onSuccess(Date.now()) ?? 'closed';
            const runResult: GuardrailRunResult<T> = {
                ok: true,
                attempts: attempt,
                durationMs: Date.now() - startedAt,
                shortCircuited: false,
                value,
                circuitState: newState,
            };
            emitGuardrailTelemetry({
                eventType: 'guardrail.succeeded',
                domain: opts.domain,
                operationName: opts.operationName,
                targetKey: opts.targetKey,
                executionId: opts.executionId,
                attempt,
                durationMs: Date.now() - attemptStartedAt,
                circuitState: newState,
                status: 'success',
            });
            return runResult;
        } catch (error) {
            const failureKind = opts.classifyFailure?.(error, attempt) ?? defaultFailureKind(error);
            const countForBreaker = opts.shouldCountFailureForCircuit?.(error, failureKind) ?? true;
            let circuitState = opts.circuitBreaker?.currentState() ?? 'closed';

            if (countForBreaker && opts.circuitBreaker) {
                circuitState = opts.circuitBreaker.onFailure(Date.now());
                if (circuitState === 'open') {
                    emitGuardrailTelemetry({
                        eventType: 'guardrail.circuit_opened',
                        domain: opts.domain,
                        operationName: opts.operationName,
                        targetKey: opts.targetKey,
                        executionId: opts.executionId,
                        attempt,
                        failureKind,
                        circuitState,
                    });
                }
            }

            const attemptResult: GuardrailAttemptResult<T> = {
                ok: false,
                attempt,
                durationMs: Date.now() - attemptStartedAt,
                error,
                failureKind,
                circuitState,
            };
            lastAttempt = attemptResult;

            emitGuardrailTelemetry({
                eventType: 'guardrail.attempt_failed',
                domain: opts.domain,
                operationName: opts.operationName,
                targetKey: opts.targetKey,
                executionId: opts.executionId,
                attempt,
                durationMs: attemptResult.durationMs,
                failureKind,
                circuitState,
                status: 'failure',
            });

            const shouldRetry = (
                attempt < maxAttempts &&
                (opts.shouldRetry?.(error, attempt, failureKind) ?? false)
            );
            if (!shouldRetry) break;

            const backoffMs = resolveGuardrailBackoff(attempt, opts.backoff);
            emitGuardrailTelemetry({
                eventType: 'guardrail.retry_scheduled',
                domain: opts.domain,
                operationName: opts.operationName,
                targetKey: opts.targetKey,
                executionId: opts.executionId,
                attempt,
                durationMs: backoffMs,
                failureKind,
                circuitState,
                status: 'partial',
                extra: { backoffMs },
            });
            await runBackoffDelay(backoffMs);

            const breakerCheck = opts.circuitBreaker?.beforeExecution(Date.now());
            if (breakerCheck && !breakerCheck.allowed) {
                emitGuardrailTelemetry({
                    eventType: 'guardrail.short_circuited',
                    domain: opts.domain,
                    operationName: opts.operationName,
                    targetKey: opts.targetKey,
                    executionId: opts.executionId,
                    attempt,
                    failureKind,
                    circuitState: breakerCheck.state,
                });
                return {
                    ok: false,
                    attempts: attempt,
                    durationMs: Date.now() - startedAt,
                    error,
                    failureKind,
                    shortCircuited: true,
                    circuitState: breakerCheck.state,
                };
            }
        }
    }

    const failureResult: GuardrailRunResult<T> = {
        ok: false,
        attempts: lastAttempt?.attempt ?? 0,
        durationMs: Date.now() - startedAt,
        error: lastAttempt?.error,
        failureKind: lastAttempt?.failureKind,
        shortCircuited: false,
        circuitState: lastAttempt?.circuitState ?? (opts.circuitBreaker?.currentState() ?? 'closed'),
    };
    emitGuardrailTelemetry({
        eventType: 'guardrail.failed',
        domain: opts.domain,
        operationName: opts.operationName,
        targetKey: opts.targetKey,
        executionId: opts.executionId,
        attempt: failureResult.attempts || undefined,
        durationMs: failureResult.durationMs,
        failureKind: failureResult.failureKind,
        circuitState: failureResult.circuitState,
        status: 'failure',
    });
    return failureResult;
}
