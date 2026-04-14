import { describe, it, expect, vi, beforeEach } from 'vitest';
import { guardrailsTelemetry } from '../../services/guardrails/GuardrailsTelemetry';
import { telemetry } from '../../services/TelemetryService';

vi.mock('../../services/TelemetryService', () => ({
    telemetry: {
        operational: vi.fn(),
    },
}));

describe('GuardrailsTelemetry', () => {
    beforeEach(() => {
        (telemetry.operational as any).mockReset();
    });

    it('emits canonical structured payload shape for guardrails events', () => {
        guardrailsTelemetry.emit({
            eventName: 'guardrails.runtime.health',
            actor: 'TestActor',
            summary: 'health ok',
            status: 'ready',
            payload: {
                providerKind: 'local_guardrails_ai',
                runnerPath: '/runtime/guardrails/local_guardrails_runner.py',
            },
        });

        expect(telemetry.operational).toHaveBeenCalledWith(
            'guardrails',
            'guardrails.runtime.health',
            'info',
            'TestActor',
            'health ok',
            'success',
            expect.objectContaining({
                payload: expect.objectContaining({
                    subsystem: 'guardrails',
                    eventName: 'guardrails.runtime.health',
                    status: 'ready',
                    timestamp: expect.any(String),
                    providerKind: 'local_guardrails_ai',
                }),
            }),
        );
    });
});
