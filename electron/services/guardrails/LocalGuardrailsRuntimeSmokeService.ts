import type { GuardrailValidationResult } from './types';
import type { LocalGuardrailsRuntimeReadiness } from '../../../shared/guardrails/localGuardrailsRuntimeTypes';
import { localGuardrailsRuntimeHealth } from './LocalGuardrailsRuntimeHealth';
import {
    LocalGuardrailsBindingProbeService,
    localGuardrailsBindingProbeService,
} from './LocalGuardrailsBindingProbeService';

export interface LocalGuardrailsRuntimeSmokeResult {
    checkedAt: string;
    ready: boolean;
    skipped: boolean;
    skipReason?: string;
    runtime: LocalGuardrailsRuntimeReadiness;
    probeResult?: GuardrailValidationResult;
    expectedFailMatched?: boolean;
}

export class LocalGuardrailsRuntimeSmokeService {
    constructor(
        private readonly _runtimeHealth = localGuardrailsRuntimeHealth,
        private readonly _probeService: LocalGuardrailsBindingProbeService = localGuardrailsBindingProbeService,
    ) {}

    async runSmokeValidation(sampleContent?: string): Promise<LocalGuardrailsRuntimeSmokeResult> {
        const checkedAt = new Date().toISOString();
        const runtime = await this._runtimeHealth.checkReadiness();

        if (!runtime.ready) {
            return {
                checkedAt,
                ready: false,
                skipped: true,
                skipReason: runtime.guardrails.error ?? runtime.python.error ?? 'Runtime not ready',
                runtime,
            };
        }

        const probeResult = await this._probeService.testBinding({
            binding: {
                id: 'local-guardrails-smoke-binding',
                name: 'Local Guardrails Smoke Validator',
                providerKind: 'local_guardrails_ai',
                validatorName: 'runtime.guardrails.smoke_validators.SmokeContainsWord',
                validatorArgs: {
                    blocked_word: 'forbidden',
                },
                failOpen: false,
                priority: 0,
                timeoutMs: 5000,
            },
            sampleContent: sampleContent ?? 'this content includes forbidden marker',
        });

        const expectedFailMatched = probeResult.success === true && probeResult.passed === false;

        return {
            checkedAt,
            ready: expectedFailMatched,
            skipped: false,
            runtime,
            probeResult,
            expectedFailMatched,
        };
    }
}

export const localGuardrailsRuntimeSmokeService = new LocalGuardrailsRuntimeSmokeService();
