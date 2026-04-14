export interface LocalGuardrailsRuntimeReadiness {
    providerKind: 'local_guardrails_ai';
    checkedAt: string;
    ready: boolean;
    python: {
        resolved: boolean;
        path?: string;
        error?: string;
    };
    runner: {
        path: string;
        exists: boolean;
    };
    guardrails: {
        importable: boolean;
        version?: string;
        pythonVersion?: string;
        error?: string;
        diagnostics?: {
            sysExecutable?: string;
            sysVersion?: string;
            cwd?: string;
            sysPath?: string[];
            pythonhome?: string;
            pythonpath?: string;
            guardrailsImportSucceeded?: boolean;
            guardrailsImportError?: string;
        };
    };
}
