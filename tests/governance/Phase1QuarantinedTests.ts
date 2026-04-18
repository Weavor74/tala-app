import type { QuarantinedTestMetadata } from '../../shared/release/QuarantinedTestMetadata';

/**
 * Phase-1 release quarantine list.
 *
 * Only tests with explicitly non-execution impact are eligible.
 */
export const phase1QuarantinedTests: QuarantinedTestMetadata[] = [
    {
        testName: 'tests/InferencePartialAssetsStartup.integration.test.ts',
        subsystem: 'inference-bootstrap',
        reason: 'Known environment-dependent inference asset readiness failure; unrelated to plan execution authority path.',
        affectsExecution: false,
        affectsMemoryAuthority: false,
        affectsDiagnosticsTruth: false,
        owner: 'runtime-inference',
    },
];
