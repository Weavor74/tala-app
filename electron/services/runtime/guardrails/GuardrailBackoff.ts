import type { GuardrailBackoffPolicy } from './RuntimeGuardrailTypes';

const DEFAULT_BACKOFF: GuardrailBackoffPolicy = {
    baseDelayMs: 150,
    maxDelayMs: 2_000,
    jitterRatio: 0.2,
};

export function resolveGuardrailBackoff(
    attempt: number,
    policy?: GuardrailBackoffPolicy,
): number {
    const cfg = policy ?? DEFAULT_BACKOFF;
    const safeAttempt = Math.max(1, attempt);
    const expDelay = Math.min(
        cfg.maxDelayMs,
        cfg.baseDelayMs * Math.pow(2, safeAttempt - 1),
    );
    const jitterRatio = Math.max(0, Math.min(1, cfg.jitterRatio ?? 0));
    if (jitterRatio <= 0) return expDelay;
    const jitterRange = expDelay * jitterRatio;
    const jitterOffset = (Math.random() * jitterRange * 2) - jitterRange;
    return Math.max(0, Math.round(expDelay + jitterOffset));
}

export async function runBackoffDelay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
