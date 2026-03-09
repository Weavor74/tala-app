import { ToolCapability } from './reflectionEcosystemTypes';

export class CapabilityGating {
    /**
     * Resolves the set of safe tool capabilities based on the current mode and active workflow.
     */
    public resolveCapabilities(activeMode: string, isEngineeringWorkflowActive: boolean): Set<ToolCapability> {
        const capabilities = new Set<ToolCapability>();

        // Always allow basic diagnostics reading for all modes
        capabilities.add('logs_read');
        capabilities.add('repo_read');

        if (activeMode === 'assistant') {
            capabilities.add('repo_search');
            capabilities.add('diagnostics_run');
        }

        if (activeMode === 'hybrid') {
            capabilities.add('repo_search');
            capabilities.add('diagnostics_run');
            // Hybrid gets some write privileges but restricted from core identity
            capabilities.add('repo_write_docs');
            capabilities.add('repo_write_tests');
        }

        if (activeMode === 'rp') {
            // RP gets almost nothing repository-wise
        }

        // If the engineering loop is explicitly triggered, we grant wide access
        // Engineering workflow could be running *within* an assistant session, but requires elevated explicit consent.
        if (isEngineeringWorkflowActive || activeMode === 'engineering') {
            capabilities.add('repo_read');
            capabilities.add('repo_search');
            capabilities.add('repo_write_staged'); // Can stage candidate patches
            capabilities.add('repo_write_docs');
            capabilities.add('repo_write_tests');
            capabilities.add('logs_read');
            capabilities.add('diagnostics_run');
            capabilities.add('shell_safe');
            capabilities.add('tests_run');
            capabilities.add('validation_run');
            capabilities.add('reflection_read');
            capabilities.add('reflection_write');
            capabilities.add('promotion_execute'); // Can push to live
            capabilities.add('rollback_execute');
            capabilities.add('identity_read');
            // Note: repo_write_protected and identity_edit_* must still pass ImmutableIdentity tests even in engineering mode.
        }

        return capabilities;
    }

    /**
     * Helper to verify if an invoked tool action is permitted.
     */
    public isActionAllowed(actionType: ToolCapability, activeMode: string, isEngineeringWorkflowActive: boolean): boolean {
        const caps = this.resolveCapabilities(activeMode, isEngineeringWorkflowActive);
        return caps.has(actionType);
    }
}
