import type { GuardrailValidationResult } from './types';
import type { LocalGuardrailsRuntimeReadiness } from '../../../shared/guardrails/localGuardrailsRuntimeTypes';
import { localGuardrailsRuntimeHealth } from './LocalGuardrailsRuntimeHealth';
import {
    LocalGuardrailsBindingProbeService,
    localGuardrailsBindingProbeService,
} from './LocalGuardrailsBindingProbeService';
import { guardrailsTelemetry, type IGuardrailsTelemetry } from './GuardrailsTelemetry';

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
        private readonly _telemetry: IGuardrailsTelemetry = guardrailsTelemetry,
    ) {}

    async runSmokeValidation(sampleContent?: string): Promise<LocalGuardrailsRuntimeSmokeResult> {
        const startedAt = Date.now();
        const checkedAt = new Date().toISOString();
        const runtime = await this._runtimeHealth.checkReadiness();

        if (!runtime.ready) {
            const result = {
                checkedAt,
                ready: false,
                skipped: true,
                skipReason: runtime.guardrails.error ?? runtime.python.error ?? 'Runtime not ready',
                runtime,
            };
            this._telemetry.emit({
                eventName: 'guardrails.runtime.probe',
                actor: 'LocalGuardrailsRuntimeSmokeService',
                summary: 'Local guardrails runtime smoke probe skipped because runtime is not ready.',
                status: 'failed',
                payload: {
                    providerKind: runtime.providerKind,
                    runnerPath: runtime.runner.path,
                    pythonExecutable: runtime.guardrails.diagnostics?.sysExecutable ?? runtime.python.path,
                    importError: runtime.guardrails.diagnostics?.guardrailsImportError ?? runtime.guardrails.error,
                    reason: result.skipReason,
                    code: 'RUNTIME_NOT_READY',
                    durationMs: Date.now() - startedAt,
                    probeType: 'runtime_smoke',
                },
            });
            return result;
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

        const result = {
            checkedAt,
            ready: expectedFailMatched,
            skipped: false,
            runtime,
            probeResult,
            expectedFailMatched,
        };
        this._telemetry.emit({
            eventName: 'guardrails.runtime.probe',
            actor: 'LocalGuardrailsRuntimeSmokeService',
            summary: expectedFailMatched
                ? 'Local guardrails runtime smoke probe passed.'
                : 'Local guardrails runtime smoke probe failed.',
            status: expectedFailMatched ? 'passed' : 'failed',
            payload: {
                providerKind: runtime.providerKind,
                bindingId: 'local-guardrails-smoke-binding',
                runnerPath: runtime.runner.path,
                pythonExecutable: runtime.guardrails.diagnostics?.sysExecutable ?? runtime.python.path,
                importError: probeResult.error,
                reason: expectedFailMatched ? undefined : 'Smoke validator did not produce expected deny behavior.',
                code: expectedFailMatched ? 'SMOKE_PASSED' : 'SMOKE_EXPECTATION_MISMATCH',
                durationMs: Date.now() - startedAt,
                probeType: 'runtime_smoke',
                probeSuccess: probeResult.success,
                probePassed: probeResult.passed,
                shouldDeny: probeResult.shouldDeny,
            },
        });
        return result;
    }
}

export const localGuardrailsRuntimeSmokeService = new LocalGuardrailsRuntimeSmokeService();
