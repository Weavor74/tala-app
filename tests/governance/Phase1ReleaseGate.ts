import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    isPhase1ExecutionProtectedTestName,
    validateQuarantinedTestMetadata,
} from '../../shared/release/QuarantinedTestMetadata';
import { phase1QuarantinedTests } from './Phase1QuarantinedTests';

type FailureRecord = {
    testName: string;
};

const PHASE1_PROTECTED_TEST_FILES = [
    'tests/PlanExecutionCoordinator.test.ts',
    'tests/ChatLoopExecutor.planExecution.test.ts',
    'tests/ExecutionIsolation.test.ts',
];

function runTargetedPhase1Tests(): void {
    const command = `npm run -s test -- ${PHASE1_PROTECTED_TEST_FILES.join(' ')}`;
    const result = spawnSync(
        command,
        {
            stdio: 'inherit',
            shell: true,
        },
    );
    if ((result.status ?? 1) !== 0) {
        throw new Error('phase1_execution_path_tests_failed');
    }
}

function validateQuarantineManifest(): void {
    const issues: string[] = [];
    for (const entry of phase1QuarantinedTests) {
        const entryIssues = validateQuarantinedTestMetadata(entry);
        for (const issue of entryIssues) {
            issues.push(`${entry.testName}:${issue}`);
        }
    }
    if (issues.length > 0) {
        throw new Error(`quarantine_manifest_invalid:${issues.join(',')}`);
    }
}

function normalizeFailureRecords(raw: unknown): FailureRecord[] {
    if (!Array.isArray(raw)) {
        throw new Error('failed_tests_report_must_be_array');
    }
    return raw.map((item) => {
        if (!item || typeof item !== 'object' || typeof (item as FailureRecord).testName !== 'string') {
            throw new Error('failed_tests_report_invalid_entry');
        }
        return { testName: (item as FailureRecord).testName };
    });
}

function validateFailureReportIfProvided(): void {
    const reportPath = process.env.PHASE1_FAILED_TESTS_REPORT?.trim();
    if (!reportPath) return;
    const absolutePath = path.resolve(reportPath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`failed_tests_report_not_found:${absolutePath}`);
    }
    const parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as unknown;
    const failures = normalizeFailureRecords(parsed);

    for (const failure of failures) {
        if (isPhase1ExecutionProtectedTestName(failure.testName)) {
            throw new Error(`protected_execution_failure_detected:${failure.testName}`);
        }
        const match = phase1QuarantinedTests.find((entry) => entry.testName === failure.testName);
        if (!match) {
            throw new Error(`unquarantined_failure_detected:${failure.testName}`);
        }
        if (match.affectsExecution !== false) {
            throw new Error(`execution_impacting_failure_cannot_be_quarantined:${failure.testName}`);
        }
    }
}

function main(): void {
    validateQuarantineManifest();
    runTargetedPhase1Tests();
    validateFailureReportIfProvided();
    process.stdout.write('phase1_release_gate_passed\n');
}

main();
