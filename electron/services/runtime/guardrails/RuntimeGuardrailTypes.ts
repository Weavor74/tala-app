export type GuardrailCircuitState = 'closed' | 'open' | 'half_open';

export type GuardrailFailureKind =
    | 'timeout'
    | 'policy_denied'
    | 'governance_blocked'
    | 'pre_stream_open'
    | 'mid_stream'
    | 'aborted'
    | 'runtime_error';

export interface GuardrailBackoffPolicy {
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio?: number;
}

export interface GuardrailCircuitBreakerPolicy {
    failureThreshold: number;
    resetAfterMs: number;
}

export interface GuardrailExecutionContext {
    domain: string;
    operationName: string;
    targetKey: string;
    executionId?: string;
}

export interface GuardrailAttemptResult<T> {
    ok: boolean;
    attempt: number;
    durationMs: number;
    value?: T;
    error?: unknown;
    failureKind?: GuardrailFailureKind;
    circuitState: GuardrailCircuitState;
}

export interface GuardrailRunResult<T> {
    ok: boolean;
    attempts: number;
    durationMs: number;
    value?: T;
    error?: unknown;
    failureKind?: GuardrailFailureKind;
    shortCircuited: boolean;
    circuitState: GuardrailCircuitState;
}

export interface GuardrailExecuteOptions<T> extends GuardrailExecutionContext {
    maxAttempts: number;
    timeoutMs?: number;
    backoff?: GuardrailBackoffPolicy;
    classifyFailure?: (
        error: unknown,
        attempt: number,
    ) => GuardrailFailureKind;
    shouldRetry?: (
        error: unknown,
        attempt: number,
        failureKind: GuardrailFailureKind,
    ) => boolean;
    shouldCountFailureForCircuit?: (
        error: unknown,
        failureKind: GuardrailFailureKind,
    ) => boolean;
    circuitBreaker?: {
        currentState(): GuardrailCircuitState;
        beforeExecution(nowMs: number): { allowed: boolean; state: GuardrailCircuitState };
        onSuccess(nowMs: number): GuardrailCircuitState;
        onFailure(nowMs: number): GuardrailCircuitState;
    };
    execute: (attempt: number, signal?: AbortSignal) => Promise<T>;
}

