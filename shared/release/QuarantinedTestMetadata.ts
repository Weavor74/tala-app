export interface QuarantinedTestMetadata {
    testName: string;
    subsystem: string;
    reason: string;
    affectsExecution: boolean;
    affectsMemoryAuthority?: boolean;
    affectsDiagnosticsTruth?: boolean;
    owner?: string;
}

const PHASE1_PROTECTED_PATHS: readonly string[] = [
    'PlanExecutionCoordinator',
    'ChatLoopExecutor.planExecution',
    'ExecutionIsolation',
    'ChatLoopExecutor',
    'PlanExecutionCoordinator',
    'planning/PlanExecutionCoordinator',
    'planning/ChatLoopExecutor',
    'ToolExecutionCoordinator',
    'WorkflowHandoffCoordinator',
    'AgentHandoffCoordinator',
    'RuntimeDiagnosticsAggregator',
];

export function isPhase1ExecutionProtectedTestName(testName: string): boolean {
    const normalized = testName.toLowerCase();
    return PHASE1_PROTECTED_PATHS.some((token) => normalized.includes(token.toLowerCase()));
}

export function validateQuarantinedTestMetadata(entry: QuarantinedTestMetadata): string[] {
    const issues: string[] = [];
    if (!entry.testName || entry.testName.trim().length === 0) {
        issues.push('missing_test_name');
    }
    if (!entry.subsystem || entry.subsystem.trim().length === 0) {
        issues.push('missing_subsystem');
    }
    if (!entry.reason || entry.reason.trim().length === 0) {
        issues.push('missing_reason');
    }
    if (entry.affectsExecution !== false) {
        issues.push('quarantine_entry_must_set_affectsExecution_false');
    }
    if (isPhase1ExecutionProtectedTestName(entry.testName)) {
        issues.push('protected_execution_path_tests_are_not_quarantine_eligible');
    }
    return issues;
}
