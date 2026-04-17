import { describe, expect, it } from 'vitest';

import {
    FailureSuppressionService,
    getDefaultRecoveryPolicy,
    normalizeStructuredFailure,
    selectEquivalentTarget,
} from '../electron/services/runtime/failures/FailureRecoveryPolicy';
import { PolicyDeniedError } from '../electron/services/policy/PolicyGate';


describe('FailureRecoveryPolicy', () => {
    it('classifies timeout deterministically', () => {
        const failure = normalizeStructuredFailure({
            error: new Error('stream open timeout from provider'),
            scope: 'service',
            reasonCodeFallback: 'execution:unknown',
            messageFallback: 'timeout',
        });

        expect(failure.class).toBe('timeout');
        expect(failure.retryable).toBe(true);
        expect(failure.operatorActionRequired).toBe(false);
    });

    it('classifies policy denials as policy_blocked with authoritative code', () => {
        const failure = normalizeStructuredFailure({
            error: new PolicyDeniedError({
                allowed: false,
                code: 'policy:operator_approval_required',
                reason: 'blocked',
                metadata: {},
            }),
            scope: 'tool',
            reasonCodeFallback: 'execution:tool_failed',
            messageFallback: 'blocked',
        });

        expect(failure.class).toBe('policy_blocked');
        expect(failure.reasonCode).toBe('policy:operator_approval_required');
        expect(failure.operatorActionRequired).toBe(true);
    });

    it('classifies auth failure as auth_required (not unreachable)', () => {
        const failure = normalizeStructuredFailure({
            error: new Error('401 unauthorized api key missing'),
            scope: 'service',
            reasonCodeFallback: 'execution:provider_failed',
            messageFallback: 'unauthorized',
        });

        expect(failure.class).toBe('auth_required');
        expect(failure.operatorActionRequired).toBe(true);
    });

    it('keeps invalid input distinct from unknown', () => {
        const failure = normalizeStructuredFailure({
            error: new Error('validation failed: invalid input schema'),
            scope: 'tool',
            reasonCodeFallback: 'execution:tool_failed',
            messageFallback: 'validation failed',
        });

        expect(failure.class).toBe('invalid_input');
        expect(failure.retryable).toBe(false);
    });

    it('keeps invariant violations terminal and non-retryable', () => {
        const failure = normalizeStructuredFailure({
            error: new Error('canonical authority invariant violated'),
            scope: 'plan',
            reasonCodeFallback: 'execution:invariant_failed',
            messageFallback: 'invariant violated',
        });

        const policy = getDefaultRecoveryPolicy(failure.class);
        expect(failure.class).toBe('invariant_violation');
        expect(policy.allowRetry).toBe(false);
        expect(policy.allowEscalation).toBe(true);
    });

    it('policy matrix does not allow retry for policy_blocked', () => {
        const policy = getDefaultRecoveryPolicy('policy_blocked');
        expect(policy.allowRetry).toBe(false);
        expect(policy.allowReroute).toBe(false);
        expect(policy.allowEscalation).toBe(true);
    });

    it('policy matrix allows bounded retry for timeout', () => {
        const policy = getDefaultRecoveryPolicy('timeout');
        expect(policy.allowRetry).toBe(true);
        expect(policy.maxRetries).toBeGreaterThan(0);
        expect(policy.backoffMsByAttempt.length).toBeGreaterThan(0);
    });

    it('selectEquivalentTarget is deterministic and deduped', () => {
        const selected = selectEquivalentTarget('tool.primary', [
            'tool.primary',
            'tool.secondary',
            'tool.secondary',
            'tool.tertiary',
        ]);

        expect(selected).toEqual(['tool.secondary', 'tool.tertiary']);
    });

    it('suppresses repeated identical failure signatures after threshold', () => {
        let now = 1_000;
        const tracker = new FailureSuppressionService(
            { threshold: 3, windowMs: 10_000, cooldownMs: 15_000 },
            () => now,
        );

        const signature = {
            key: 'toolA|timeout|execution:timeout|-|tool',
            class: 'timeout' as const,
            reasonCode: 'execution:timeout',
        };

        const r1 = tracker.record(signature);
        const r2 = tracker.record(signature);
        const r3 = tracker.record(signature);

        expect(r1.suppressed).toBe(false);
        expect(r2.suppressed).toBe(false);
        expect(r3.suppressed).toBe(true);

        now += 16_000;
        const afterCooldown = tracker.isSuppressed(signature);
        expect(afterCooldown.suppressed).toBe(false);
    });
});
