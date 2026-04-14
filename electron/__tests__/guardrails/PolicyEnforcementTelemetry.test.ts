import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enforceSideEffectWithGuardrails } from '../../services/policy/PolicyEnforcement';

const {
    checkSideEffectAsync,
    telemetryBusEmit,
    guardrailsEmit,
} = vi.hoisted(() => ({
    checkSideEffectAsync: vi.fn(),
    telemetryBusEmit: vi.fn(),
    guardrailsEmit: vi.fn(),
}));

vi.mock('../../services/policy/PolicyGate', () => {
    class MockPolicyDeniedError extends Error {
        public readonly decision: unknown;
        constructor(decision: unknown) {
            super('denied');
            this.decision = decision;
        }
    }
    return {
        policyGate: {
            checkSideEffectAsync,
            getActiveProfileId: () => 'profile-1',
        },
        PolicyDeniedError: MockPolicyDeniedError,
    };
});

vi.mock('../../services/telemetry/TelemetryBus', () => ({
    TelemetryBus: {
        getInstance: () => ({
            emit: telemetryBusEmit,
        }),
    },
}));

vi.mock('../../services/guardrails/GuardrailsTelemetry', () => ({
    guardrailsTelemetry: {
        emit: guardrailsEmit,
    },
}));

describe('PolicyEnforcement guardrails diagnostics', () => {
    beforeEach(() => {
        checkSideEffectAsync.mockReset();
        telemetryBusEmit.mockReset();
        guardrailsEmit.mockReset();
    });

    it('emits guardrails.enforcement for allow/warn/deny outcomes', async () => {
        checkSideEffectAsync
            .mockResolvedValueOnce({ allowed: true, reason: 'ok', code: 'POLICY_ALLOW' })
            .mockResolvedValueOnce({ allowed: true, reason: 'warning', code: 'POLICY_ALLOW_WITH_WARNINGS' })
            .mockResolvedValueOnce({ allowed: false, reason: 'blocked', code: 'POLICY_DENY' });

        const ctx = {
            executionId: 'exec-1',
            executionType: 'tool_invocation',
            executionOrigin: 'ipc',
            executionMode: 'assistant',
            actionKind: 'tool.execute',
            targetSubsystem: 'tool',
        } as any;

        await enforceSideEffectWithGuardrails('tool', ctx, 'content');
        await enforceSideEffectWithGuardrails('tool', ctx, 'content');
        await expect(enforceSideEffectWithGuardrails('tool', ctx, 'content')).rejects.toBeInstanceOf(Error);

        const decisions = guardrailsEmit.mock.calls.map((call: any[]) => call[0]?.decision);
        expect(decisions).toEqual(['allow', 'warn', 'deny']);
        expect(guardrailsEmit).toHaveBeenCalledWith(expect.objectContaining({
            eventName: 'guardrails.enforcement',
            payload: expect.objectContaining({
                profileId: 'profile-1',
                subsystemTarget: 'tool',
            }),
        }));
    });
});
