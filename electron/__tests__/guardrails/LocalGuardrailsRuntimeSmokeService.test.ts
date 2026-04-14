import type { GuardrailValidationResult } from '../../services/guardrails/types';
import type { LocalGuardrailsRuntimeReadiness } from '../../../shared/guardrails/localGuardrailsRuntimeTypes';
import { LocalGuardrailsRuntimeSmokeService } from '../../services/guardrails/LocalGuardrailsRuntimeSmokeService';

function readiness(overrides: Partial<LocalGuardrailsRuntimeReadiness>): LocalGuardrailsRuntimeReadiness {
    return {
        providerKind: 'local_guardrails_ai',
        checkedAt: '2026-01-01T00:00:00.000Z',
        ready: true,
        python: {
            resolved: true,
            path: 'python-local',
        },
        runner: {
            path: '/app/runtime/guardrails/local_guardrails_runner.py',
            exists: true,
        },
        guardrails: {
            importable: true,
            version: '0.6.3',
        },
        ...overrides,
    };
}

function probeResult(overrides: Partial<GuardrailValidationResult>): GuardrailValidationResult {
    return {
        validatorId: 'smoke-binding',
        validatorName: 'runtime.guardrails.smoke_validators.SmokeContainsWord',
        engineKind: 'local_guardrails_ai',
        success: true,
        passed: false,
        shouldDeny: true,
        violations: [],
        evidence: [],
        warnings: [],
        durationMs: 1,
        ...overrides,
    };
}

describe('LocalGuardrailsRuntimeSmokeService', () => {
    it('returns skipped when runtime readiness is not healthy', async () => {
        const svc = new LocalGuardrailsRuntimeSmokeService(
            {
                checkReadiness: vi.fn(async () => readiness({
                    ready: false,
                    guardrails: {
                        importable: false,
                        error: 'No module named guardrails',
                    },
                })),
            } as any,
            {
                testBinding: vi.fn(),
            } as any,
        );

        const result = await svc.runSmokeValidation();
        expect(result.skipped).toBe(true);
        expect(result.ready).toBe(false);
        expect(result.skipReason).toContain('No module named guardrails');
    });

    it('reports ready when smoke probe returns expected fail result', async () => {
        const probeMock = vi.fn(async () => probeResult({ success: true, passed: false }));
        const svc = new LocalGuardrailsRuntimeSmokeService(
            {
                checkReadiness: vi.fn(async () => readiness({})),
            } as any,
            {
                testBinding: probeMock,
            } as any,
        );

        const result = await svc.runSmokeValidation('this content includes forbidden marker');
        expect(result.skipped).toBe(false);
        expect(result.ready).toBe(true);
        expect(result.expectedFailMatched).toBe(true);
        expect(probeMock).toHaveBeenCalledTimes(1);
    });

    it('reports not-ready when smoke probe does not match expected fail behavior', async () => {
        const svc = new LocalGuardrailsRuntimeSmokeService(
            {
                checkReadiness: vi.fn(async () => readiness({})),
            } as any,
            {
                testBinding: vi.fn(async () => probeResult({ success: true, passed: true })),
            } as any,
        );

        const result = await svc.runSmokeValidation('clean content');
        expect(result.skipped).toBe(false);
        expect(result.ready).toBe(false);
        expect(result.expectedFailMatched).toBe(false);
    });
});

