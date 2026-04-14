export type GuardrailsDiagnosticEventName =
    | 'guardrails.runtime.health'
    | 'guardrails.runtime.probe'
    | 'guardrails.preflight'
    | 'guardrails.activation'
    | 'guardrails.enforcement';

export type GuardrailsDiagnosticDecision = 'allow' | 'warn' | 'deny';

export type GuardrailsDiagnosticStatus =
    | 'ready'
    | 'degraded'
    | 'blocked'
    | 'failed'
    | 'passed';

export interface GuardrailsDiagnosticEventPayload {
    subsystem: 'guardrails';
    eventName: GuardrailsDiagnosticEventName;
    providerKind?: string;
    profileId?: string;
    ruleId?: string;
    bindingId?: string;
    decision?: GuardrailsDiagnosticDecision;
    status?: GuardrailsDiagnosticStatus;
    pythonExecutable?: string;
    runnerPath?: string;
    importError?: string;
    fixHint?: string;
    durationMs?: number;
    timestamp?: string;
    reason?: string;
    code?: string;
    [key: string]: unknown;
}
