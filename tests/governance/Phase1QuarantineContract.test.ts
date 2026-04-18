import { describe, expect, it } from 'vitest';
import {
    isPhase1ExecutionProtectedTestName,
    validateQuarantinedTestMetadata,
} from '../../shared/release/QuarantinedTestMetadata';
import { phase1QuarantinedTests } from './Phase1QuarantinedTests';

describe('Phase1QuarantineContract', () => {
    it('allows only explicitly non-execution-impacting quarantine entries', () => {
        for (const entry of phase1QuarantinedTests) {
            expect(validateQuarantinedTestMetadata(entry)).toEqual([]);
            expect(entry.affectsExecution).toBe(false);
        }
    });

    it('treats protected execution-path tests as non-quarantine-eligible', () => {
        expect(isPhase1ExecutionProtectedTestName('tests/PlanExecutionCoordinator.test.ts')).toBe(true);
        expect(isPhase1ExecutionProtectedTestName('tests/ChatLoopExecutor.planExecution.test.ts')).toBe(true);
        expect(isPhase1ExecutionProtectedTestName('tests/ExecutionIsolation.test.ts')).toBe(true);
        expect(isPhase1ExecutionProtectedTestName('tests/InferencePartialAssetsStartup.integration.test.ts')).toBe(false);
    });
});
