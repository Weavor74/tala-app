import { LocalGuardrailsBindingProbeService } from '../../services/guardrails/LocalGuardrailsBindingProbeService';
import { localGuardrailsRuntimeHealth } from '../../services/guardrails/LocalGuardrailsRuntimeHealth';

const RUN_REAL_LOCAL_GUARDRAILS = process.env.TALA_RUN_LOCAL_GUARDRAILS_INTEGRATION === '1';

describe('Local guardrails real validator integration (opt-in)', () => {
    it('runs real local validator path when environment is available', async () => {
        if (!RUN_REAL_LOCAL_GUARDRAILS) {
            return;
        }

        const readiness = await localGuardrailsRuntimeHealth.checkReadiness();
        if (!readiness.ready) {
            // Graceful skip behavior in environments without local Python/guardrails.
            return;
        }

        const probeService = new LocalGuardrailsBindingProbeService();
        const result = await probeService.testBinding({
            binding: {
                id: 'integration-local-smoke',
                name: 'Integration Local Smoke',
                providerKind: 'local_guardrails_ai',
                validatorName: 'runtime.guardrails.smoke_validators.SmokeContainsWord',
                validatorArgs: { blocked_word: 'forbidden' },
                failOpen: false,
                timeoutMs: 5000,
            },
            sampleContent: 'this content includes forbidden marker',
        });

        expect(result.success).toBe(true);
        expect(result.passed).toBe(false);
        expect(result.shouldDeny).toBe(true);
    });
});

