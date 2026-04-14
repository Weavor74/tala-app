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

export interface LocalGuardrailsBindingProbeInput {
    binding: Partial<ValidatorBinding>;
    sampleContent: string;
}

export class LocalGuardrailsBindingProbeService {
    constructor(
        private readonly _adapter: IGuardrailAdapter = localGuardrailsAIAdapter,
    ) {}

    getCatalog(): LocalGuardrailsValidatorCatalogEntry[] {
        return LOCAL_GUARDRAILS_VALIDATOR_CATALOG;
    }

    async testBinding(input: LocalGuardrailsBindingProbeInput): Promise<GuardrailValidationResult> {
        const normalizedBinding = this._normalizeBinding(input.binding);
        if (!normalizedBinding) {
            return this._invalidBindingResult(input.binding, 'Invalid local_guardrails_ai binding configuration');
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
            return await this._adapter.execute(normalizedBinding, request);
        } catch (err) {
            return makeErrorResult(normalizedBinding, err, 0);
        }
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
