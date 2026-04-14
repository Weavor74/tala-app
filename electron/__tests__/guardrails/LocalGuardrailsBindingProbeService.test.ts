import type { ValidatorBinding } from '../../../shared/guardrails/guardrailPolicyTypes';
import type { GuardrailValidationRequest, GuardrailValidationResult, IGuardrailAdapter } from '../../services/guardrails/types';
import { LocalGuardrailsBindingProbeService } from '../../services/guardrails/LocalGuardrailsBindingProbeService';

function makePassResult(): GuardrailValidationResult {
    return {
        validatorId: 'binding-1',
        validatorName: 'Probe',
        engineKind: 'local_guardrails_ai',
        success: true,
        passed: true,
        shouldDeny: false,
        violations: [],
        evidence: [],
        warnings: [],
        durationMs: 5,
    };
}

function makeFailResult(): GuardrailValidationResult {
    return {
        validatorId: 'binding-1',
        validatorName: 'Probe',
        engineKind: 'local_guardrails_ai',
        success: true,
        passed: false,
        shouldDeny: true,
        violations: [{ ruleId: 'x', message: 'failed' }],
        evidence: [],
        warnings: [],
        durationMs: 7,
    };
}

describe('LocalGuardrailsBindingProbeService', () => {
    it('returns curated local validator catalog entries', () => {
        const svc = new LocalGuardrailsBindingProbeService({
            providerKind: 'local_guardrails_ai',
            execute: vi.fn(),
        });

        const catalog = svc.getCatalog();
        expect(catalog.length).toBeGreaterThan(0);
        expect(catalog.every(entry => entry.providerKind === 'local_guardrails_ai')).toBe(true);
    });

    it('returns binding test success', async () => {
        const adapter: IGuardrailAdapter = {
            providerKind: 'local_guardrails_ai',
            execute: vi.fn(async (_binding: ValidatorBinding, _request: GuardrailValidationRequest) => makePassResult()),
        };

        const svc = new LocalGuardrailsBindingProbeService(adapter);
        const result = await svc.testBinding({
            binding: {
                id: 'binding-1',
                name: 'Probe',
                providerKind: 'local_guardrails_ai',
                validatorName: 'ToxicLanguage',
            },
            sampleContent: 'clean text',
        });

        expect(result.success).toBe(true);
        expect(result.passed).toBe(true);
        expect((adapter.execute as any)).toHaveBeenCalledTimes(1);
    });

    it('returns binding test fail', async () => {
        const adapter: IGuardrailAdapter = {
            providerKind: 'local_guardrails_ai',
            execute: vi.fn(async (_binding: ValidatorBinding, _request: GuardrailValidationRequest) => makeFailResult()),
        };

        const svc = new LocalGuardrailsBindingProbeService(adapter);
        const result = await svc.testBinding({
            binding: {
                id: 'binding-1',
                providerKind: 'local_guardrails_ai',
                validatorName: 'ToxicLanguage',
            },
            sampleContent: 'bad text',
        });

        expect(result.success).toBe(true);
        expect(result.passed).toBe(false);
        expect(result.shouldDeny).toBe(true);
    });

    it('returns normalized error on invalid or missing validator configuration', async () => {
        const adapter: IGuardrailAdapter = {
            providerKind: 'local_guardrails_ai',
            execute: vi.fn(async () => makePassResult()),
        };

        const svc = new LocalGuardrailsBindingProbeService(adapter);
        const result = await svc.testBinding({
            binding: {
                providerKind: 'local_guardrails_ai',
                validatorName: '',
            },
            sampleContent: 'text',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid local_guardrails_ai binding configuration');
        expect((adapter.execute as any)).not.toHaveBeenCalled();
    });

    it('returns normalized probe execution error', async () => {
        const adapter: IGuardrailAdapter = {
            providerKind: 'local_guardrails_ai',
            execute: vi.fn(async () => {
                throw new Error('runner exploded');
            }),
        };

        const svc = new LocalGuardrailsBindingProbeService(adapter);
        const result = await svc.testBinding({
            binding: {
                providerKind: 'local_guardrails_ai',
                validatorName: 'ToxicLanguage',
            },
            sampleContent: 'text',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('runner exploded');
    });

    it('enforces local-only execution behavior', async () => {
        const adapter: IGuardrailAdapter = {
            providerKind: 'local_guardrails_ai',
            execute: vi.fn(async () => makePassResult()),
        };

        const svc = new LocalGuardrailsBindingProbeService(adapter);
        const result = await svc.testBinding({
            binding: {
                providerKind: 'remote_guardrails_service',
                validatorName: 'ToxicLanguage',
            },
            sampleContent: 'text',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('local-only probe requires');
        expect((adapter.execute as any)).not.toHaveBeenCalled();
    });
});
