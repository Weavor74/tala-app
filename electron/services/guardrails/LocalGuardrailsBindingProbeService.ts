import type { ValidatorBinding } from '../../../shared/guardrails/guardrailPolicyTypes';
import {
    LOCAL_GUARDRAILS_VALIDATOR_CATALOG,
    applyLocalGuardrailsCatalogDefaults,
    type LocalGuardrailsValidatorCatalogEntry,
} from '../../../shared/guardrails/localGuardrailsValidatorCatalog';
import type {
    GuardrailValidationResult,
    IGuardrailAdapter,
    GuardrailValidationRequest,
} from './types';
import { makeErrorResult } from './types';
import { localGuardrailsAIAdapter } from './adapters/LocalGuardrailsAIAdapter';
import { guardrailsTelemetry, type IGuardrailsTelemetry } from './GuardrailsTelemetry';

export interface LocalGuardrailsBindingProbeInput {
    binding: Partial<ValidatorBinding>;
    sampleContent: string;
}

export class LocalGuardrailsBindingProbeService {
    constructor(
        private readonly _adapter: IGuardrailAdapter = localGuardrailsAIAdapter,
        private readonly _telemetry: IGuardrailsTelemetry = guardrailsTelemetry,
    ) {}

    getCatalog(): LocalGuardrailsValidatorCatalogEntry[] {
        return LOCAL_GUARDRAILS_VALIDATOR_CATALOG;
    }

    async testBinding(input: LocalGuardrailsBindingProbeInput): Promise<GuardrailValidationResult> {
        const startedAt = Date.now();
        const normalizedBinding = this._normalizeBinding(input.binding);
        if (!normalizedBinding) {
            const result = this._invalidBindingResult(
                input.binding,
                'Invalid local_guardrails_ai binding configuration',
            );
            this._emitProbeEvent('failed', result, startedAt, 'INVALID_BINDING');
            return result;
        }

        const sampleContent = typeof input.sampleContent === 'string'
            ? input.sampleContent
            : String(input.sampleContent ?? '');

        const request: GuardrailValidationRequest = {
            executionId: 'guardrail-binding-probe',
            executionType: 'tool_invocation',
            executionOrigin: 'ipc',
            executionMode: 'assistant',
            actionKind: 'guardrail_probe',
            content: sampleContent,
            contentRole: 'both',
            targetSubsystem: 'settings.guardrails',
            metadata: {
                probe: true,
                localOnly: true,
            },
        };

        try {
            const result = await this._adapter.execute(normalizedBinding, request);
            this._emitProbeEvent(result.success && result.passed ? 'passed' : 'failed', result, startedAt);
            return result;
        } catch (err) {
            const result = makeErrorResult(normalizedBinding, err, 0);
            this._emitProbeEvent('failed', result, startedAt, 'PROBE_EXECUTION_ERROR');
            return result;
        }
    }

    private _emitProbeEvent(
        status: 'ready' | 'degraded' | 'blocked' | 'failed' | 'passed',
        result: GuardrailValidationResult,
        startedAt: number,
        code?: string,
    ): void {
        this._telemetry.emit({
            eventName: 'guardrails.runtime.probe',
            actor: 'LocalGuardrailsBindingProbeService',
            summary: status === 'passed'
                ? 'Local guardrails binding probe passed.'
                : 'Local guardrails binding probe failed.',
            status,
            payload: {
                providerKind: result.engineKind,
                bindingId: result.validatorId,
                decision: result.shouldDeny ? 'deny' : 'allow',
                importError: result.error,
                reason: result.error,
                code: code ?? (status === 'passed' ? 'BINDING_PROBE_PASSED' : 'BINDING_PROBE_FAILED'),
                durationMs: Date.now() - startedAt,
                probeType: 'binding_test',
                probeSuccess: result.success,
                probePassed: result.passed,
                localOnly: true,
            },
        });
    }

    private _normalizeBinding(binding: Partial<ValidatorBinding>): ValidatorBinding | null {
        const providerKind = binding.providerKind ?? 'local_guardrails_ai';
        if (providerKind !== 'local_guardrails_ai') {
            return null;
        }

        const validatorName = typeof binding.validatorName === 'string'
            ? binding.validatorName.trim()
            : '';
        if (!validatorName) {
            return null;
        }

        return {
            id: binding.id ?? `probe-${Date.now()}`,
            name: binding.name ?? 'Local Guardrails Probe',
            providerKind: 'local_guardrails_ai',
            enabled: true,
            executionScopes: binding.executionScopes ?? [],
            supportedActions: binding.supportedActions ?? ['require_validation'],
            validatorName,
            validatorArgs: applyLocalGuardrailsCatalogDefaults(
                validatorName,
                binding.validatorArgs,
            ),
            failOpen: binding.failOpen ?? false,
            priority: binding.priority ?? 0,
            timeoutMs: binding.timeoutMs ?? 5000,
        };
    }

    private _invalidBindingResult(
        binding: Partial<ValidatorBinding>,
        message: string,
    ): GuardrailValidationResult {
        const fallbackBinding: ValidatorBinding = {
            id: binding.id ?? 'probe-invalid-binding',
            name: binding.name ?? 'Local Guardrails Probe',
            providerKind: 'local_guardrails_ai',
            enabled: true,
            executionScopes: [],
            supportedActions: ['require_validation'],
            validatorName: binding.validatorName ?? 'UnknownValidator',
            validatorArgs: binding.validatorArgs ?? {},
            failOpen: binding.failOpen ?? false,
            priority: 0,
            timeoutMs: binding.timeoutMs ?? 5000,
        };

        const localOnlySuffix = binding.providerKind && binding.providerKind !== 'local_guardrails_ai'
            ? ` (received '${binding.providerKind}'; local-only probe requires 'local_guardrails_ai')`
            : '';

        return makeErrorResult(
            fallbackBinding,
            new Error(`${message}${localOnlySuffix}`),
            0,
        );
    }
}

export const localGuardrailsBindingProbeService = new LocalGuardrailsBindingProbeService();
