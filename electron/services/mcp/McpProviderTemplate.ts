import type {
    McpActivationState,
    McpApprovedCapabilityExposure,
    McpAuthorityReasonCode,
    McpOnboardingPhase,
    McpOnboardingPhaseOutcome,
    McpProviderActivationRequest,
    McpProviderCapabilityPolicy,
    McpProviderDiagnosticsMetadata,
    McpProviderRecord,
    McpProviderRegistrationInput,
    McpProviderTemplateContract,
    McpProviderTransportConfig,
    McpQuarantinedCapability,
    McpRegistrationResult,
    McpStdioTransportConfig,
    McpWebsocketTransportConfig,
    McpHttpTransportConfig,
} from '../../../shared/mcpAuthorityTypes';

function slugifyId(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || 'mcp-provider';
}

function stableTransportFingerprint(config: McpProviderTransportConfig): string {
    if (config.transportType === 'stdio') {
        const joinedArgs = config.args.join(' ');
        const cwd = config.cwd || '';
        return `${config.command}|${joinedArgs}|${cwd}`;
    }
    if (config.transportType === 'websocket') {
        return config.url.trim().toLowerCase();
    }
    return config.baseUrl.trim().toLowerCase();
}

function nowIso(now: () => number): string {
    return new Date(now()).toISOString();
}

function phase(
    now: () => number,
    input: Omit<McpOnboardingPhaseOutcome, 'timestamp'>,
): McpOnboardingPhaseOutcome {
    return { ...input, timestamp: nowIso(now) };
}

export function createStdioMcpProviderTemplate(input: {
    displayName: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    startupTimeoutMs?: number;
    capabilityPolicy?: McpProviderCapabilityPolicy;
    diagnostics?: Partial<McpProviderDiagnosticsMetadata>;
}): McpProviderTemplateContract {
    return {
        providerKind: 'external_mcp_server',
        templateKind: 'stdio',
        idStrategy: 'derived_deterministic',
        displayName: input.displayName,
        transportType: 'stdio',
        transportConfig: {
            transportType: 'stdio',
            command: input.command,
            args: input.args ?? [],
            env: input.env ?? {},
            cwd: input.cwd,
            startupTimeoutMs: input.startupTimeoutMs,
        },
        authMode: 'none',
        capabilityPolicy: input.capabilityPolicy ?? {},
        activationStrategy: 'manual',
        healthCheckStrategy: 'protocol_handshake',
        diagnostics: {
            owner: 'mcp_authority_service',
            redactEnvKeys: input.diagnostics?.redactEnvKeys ?? ['TOKEN', 'SECRET', 'KEY'],
            tags: input.diagnostics?.tags ?? ['transport:stdio'],
        },
    };
}

export function createHttpMcpProviderTemplate(input: {
    displayName: string;
    baseUrl: string;
    timeoutMs?: number;
    healthEndpoint?: string;
    headers?: Record<string, string>;
    expectedProtocolVersion?: string;
    capabilityPolicy?: McpProviderCapabilityPolicy;
    diagnostics?: Partial<McpProviderDiagnosticsMetadata>;
}): McpProviderTemplateContract {
    return {
        providerKind: 'external_mcp_server',
        templateKind: 'http',
        idStrategy: 'derived_deterministic',
        displayName: input.displayName,
        transportType: 'http',
        transportConfig: {
            transportType: 'http',
            baseUrl: input.baseUrl,
            timeoutMs: input.timeoutMs,
            healthEndpoint: input.healthEndpoint,
            headers: input.headers,
            expectedProtocolVersion: input.expectedProtocolVersion,
        },
        authMode: input.headers ? 'header' : 'none',
        capabilityPolicy: input.capabilityPolicy ?? {},
        activationStrategy: 'manual',
        healthCheckStrategy: 'transport_probe',
        diagnostics: {
            owner: 'mcp_authority_service',
            redactHeaderKeys: input.diagnostics?.redactHeaderKeys ?? ['authorization', 'x-api-key'],
            tags: input.diagnostics?.tags ?? ['transport:http'],
        },
    };
}

function normalizeTransportConfig(input: McpProviderRegistrationInput): McpProviderTransportConfig | null {
    if (input.transportType === 'stdio') {
        const config: McpStdioTransportConfig = {
            transportType: 'stdio',
            command: String((input.transportConfig as any)?.command ?? '').trim(),
            args: Array.isArray((input.transportConfig as any)?.args) ? (input.transportConfig as any).args.filter((a: unknown) => typeof a === 'string') : [],
            env: typeof (input.transportConfig as any)?.env === 'object' && (input.transportConfig as any)?.env
                ? { ...(input.transportConfig as any).env }
                : {},
            cwd: typeof (input.transportConfig as any)?.cwd === 'string' && (input.transportConfig as any)?.cwd.trim()
                ? (input.transportConfig as any).cwd.trim()
                : undefined,
            startupTimeoutMs: Number.isFinite((input.transportConfig as any)?.startupTimeoutMs)
                ? Math.max(1000, Number((input.transportConfig as any).startupTimeoutMs))
                : undefined,
        };
        return config;
    }

    if (input.transportType === 'websocket') {
        const config: McpWebsocketTransportConfig = {
            transportType: 'websocket',
            url: String((input.transportConfig as any)?.url ?? '').trim(),
            timeoutMs: Number.isFinite((input.transportConfig as any)?.timeoutMs)
                ? Math.max(1000, Number((input.transportConfig as any).timeoutMs))
                : undefined,
            expectedProtocolVersion: typeof (input.transportConfig as any)?.expectedProtocolVersion === 'string'
                ? (input.transportConfig as any).expectedProtocolVersion.trim()
                : undefined,
        };
        return config;
    }

    if (input.transportType === 'http') {
        const config: McpHttpTransportConfig = {
            transportType: 'http',
            baseUrl: String((input.transportConfig as any)?.baseUrl ?? '').trim(),
            timeoutMs: Number.isFinite((input.transportConfig as any)?.timeoutMs)
                ? Math.max(1000, Number((input.transportConfig as any).timeoutMs))
                : undefined,
            healthEndpoint: typeof (input.transportConfig as any)?.healthEndpoint === 'string'
                ? (input.transportConfig as any).healthEndpoint.trim()
                : undefined,
            headers: typeof (input.transportConfig as any)?.headers === 'object' && (input.transportConfig as any)?.headers
                ? { ...(input.transportConfig as any).headers }
                : undefined,
            expectedProtocolVersion: typeof (input.transportConfig as any)?.expectedProtocolVersion === 'string'
                ? (input.transportConfig as any).expectedProtocolVersion.trim()
                : undefined,
        };
        return config;
    }

    return null;
}

export function normalizeProviderRegistration(
    input: McpProviderRegistrationInput,
    now: () => number = () => Date.now(),
): { record?: McpProviderRecord; reasonCode?: McpAuthorityReasonCode; reason?: string } {
    const transportConfig = normalizeTransportConfig(input);
    if (!transportConfig) {
        return { reasonCode: 'mcp_transport_invalid', reason: 'Unsupported transport type for provider registration' };
    }

    const deterministicId = slugifyId(
        input.id?.trim()
        || `${input.displayName}-${input.transportType}-${stableTransportFingerprint(transportConfig)}`,
    );
    const ts = nowIso(now);
    return {
        record: {
            id: deterministicId,
            displayName: input.displayName.trim(),
            providerKind: input.providerKind ?? 'external_mcp_server',
            templateKind: input.templateKind ?? input.transportType,
            transportType: input.transportType,
            transportConfig,
            authMode: input.authMode ?? 'none',
            capabilityPolicy: input.capabilityPolicy ?? {},
            activationStrategy: input.activationStrategy ?? 'manual',
            healthCheckStrategy: input.healthCheckStrategy ?? 'protocol_handshake',
            diagnostics: {
                owner: 'mcp_authority_service',
                redactEnvKeys: input.diagnostics?.redactEnvKeys ?? ['TOKEN', 'SECRET', 'KEY'],
                redactHeaderKeys: input.diagnostics?.redactHeaderKeys ?? ['authorization', 'x-api-key'],
                tags: input.diagnostics?.tags ?? [],
            },
            protocolExpectation: input.protocolExpectation,
            tags: input.tags ?? [],
            enabled: !!input.enabled,
            createdAt: ts,
            updatedAt: ts,
        },
    };
}

export function validateProviderRegistration(
    input: McpProviderRegistrationInput,
    existing: McpProviderRecord[],
    now: () => number = () => Date.now(),
): { ok: boolean; reasonCode?: McpAuthorityReasonCode; reason?: string; normalized?: McpProviderRecord; phases: McpOnboardingPhaseOutcome[] } {
    const phases: McpOnboardingPhaseOutcome[] = [
        phase(now, { phase: 'registration_submission', status: 'succeeded' }),
    ];

    if (!input.displayName?.trim()) {
        phases.push(phase(now, { phase: 'registration_validation', status: 'failed', reasonCode: 'mcp_registration_invalid', detail: 'displayName is required' }));
        return { ok: false, reasonCode: 'mcp_registration_invalid', reason: 'displayName is required', phases };
    }

    const normalized = normalizeProviderRegistration(input, now);
    if (!normalized.record) {
        phases.push(phase(now, { phase: 'registration_validation', status: 'failed', reasonCode: normalized.reasonCode, detail: normalized.reason }));
        return { ok: false, reasonCode: normalized.reasonCode, reason: normalized.reason, phases };
    }
    const record = normalized.record;

    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(record.id)) {
        phases.push(phase(now, { phase: 'registration_validation', status: 'failed', reasonCode: 'mcp_registration_invalid', detail: 'Invalid deterministic provider id' }));
        return { ok: false, reasonCode: 'mcp_registration_invalid', reason: 'Invalid deterministic provider id', phases };
    }

    const duplicateId = existing.some((e) => e.id === record.id);
    if (duplicateId) {
        phases.push(phase(now, { phase: 'registration_validation', status: 'failed', reasonCode: 'mcp_registration_conflict', detail: `Duplicate provider id: ${record.id}` }));
        return { ok: false, reasonCode: 'mcp_registration_conflict', reason: `Duplicate provider id: ${record.id}`, phases };
    }

    const sameTransport = existing.find((e) =>
        e.transportType === record.transportType
        && stableTransportFingerprint(e.transportConfig) === stableTransportFingerprint(record.transportConfig),
    );
    if (sameTransport) {
        phases.push(phase(now, { phase: 'registration_validation', status: 'failed', reasonCode: 'mcp_registration_conflict', detail: `Conflicting provider transport already registered: ${sameTransport.id}` }));
        return {
            ok: false,
            reasonCode: 'mcp_registration_conflict',
            reason: `Conflicting provider transport already registered: ${sameTransport.id}`,
            phases,
        };
    }

    if (record.transportType === 'stdio' && !(record.transportConfig as McpStdioTransportConfig).command.trim()) {
        phases.push(phase(now, { phase: 'registration_validation', status: 'failed', reasonCode: 'mcp_transport_invalid', detail: 'stdio command is required' }));
        return { ok: false, reasonCode: 'mcp_transport_invalid', reason: 'stdio command is required', phases };
    }
    if (record.transportType === 'websocket' && !(record.transportConfig as McpWebsocketTransportConfig).url) {
        phases.push(phase(now, { phase: 'registration_validation', status: 'failed', reasonCode: 'mcp_transport_invalid', detail: 'websocket url is required' }));
        return { ok: false, reasonCode: 'mcp_transport_invalid', reason: 'websocket url is required', phases };
    }
    if (record.transportType === 'http' && !(record.transportConfig as McpHttpTransportConfig).baseUrl) {
        phases.push(phase(now, { phase: 'registration_validation', status: 'failed', reasonCode: 'mcp_transport_invalid', detail: 'http baseUrl is required' }));
        return { ok: false, reasonCode: 'mcp_transport_invalid', reason: 'http baseUrl is required', phases };
    }

    phases.push(phase(now, { phase: 'registration_validation', status: 'succeeded' }));
    phases.push(phase(now, { phase: 'normalization', status: 'succeeded' }));
    return { ok: true, normalized: record, phases };
}

export function classifyActivationResult(input: {
    serverId: string;
    state: McpActivationState;
    reasonCode?: McpAuthorityReasonCode;
    reason?: string;
    phases: McpOnboardingPhaseOutcome[];
    registrationAccepted: boolean;
    activationAttempted: boolean;
    transportConnected: boolean;
    authSatisfied: boolean;
    protocolCompatible: boolean;
    capabilityDeclarationsValid: boolean;
    policyApproved: boolean;
    active: boolean;
    degraded: boolean;
    blocked: boolean;
}): McpRegistrationResult {
    return {
        ok: input.active,
        state: input.state,
        serverId: input.serverId,
        reasonCode: input.reasonCode,
        reason: input.reason,
        phases: input.phases,
        activation: {
            registrationAccepted: input.registrationAccepted,
            activationAttempted: input.activationAttempted,
            transportConnected: input.transportConnected,
            authSatisfied: input.authSatisfied,
            protocolCompatible: input.protocolCompatible,
            capabilityDeclarationsValid: input.capabilityDeclarationsValid,
            policyApproved: input.policyApproved,
            active: input.active,
            degraded: input.degraded,
            blocked: input.blocked,
        },
    };
}

function normalizeTool(tool: any, index: number, providerId: string): { ok: true; value: any } | { ok: false; quarantined: McpQuarantinedCapability } {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !tool.name.trim()) {
        return {
            ok: false,
            quarantined: {
                kind: 'tool',
                reasonCode: 'mcp_capability_invalid',
                detail: 'tool declarations must include a non-empty name',
                index,
            },
        };
    }
    return {
        ok: true,
        value: {
            ...tool,
            name: tool.name.trim(),
            _provenance: { providerId, capabilityKind: 'tool' },
        },
    };
}

function normalizeResource(resource: any, index: number, providerId: string): { ok: true; value: any } | { ok: false; quarantined: McpQuarantinedCapability } {
    if (!resource || typeof resource !== 'object') {
        return {
            ok: false,
            quarantined: {
                kind: 'resource',
                reasonCode: 'mcp_capability_invalid',
                detail: 'resource declarations must be objects',
                index,
            },
        };
    }
    return {
        ok: true,
        value: {
            ...resource,
            _provenance: { providerId, capabilityKind: 'resource' },
        },
    };
}

export function buildApprovedCapabilityExposure(
    providerId: string,
    raw: { tools?: any[]; resources?: any[]; prompts?: any[] },
    now: () => number = () => Date.now(),
): McpApprovedCapabilityExposure {
    const tools: any[] = [];
    const resources: any[] = [];
    const prompts: any[] = [];
    const quarantined: McpQuarantinedCapability[] = [];

    const rawTools = Array.isArray(raw.tools) ? raw.tools : [];
    for (let i = 0; i < rawTools.length; i += 1) {
        const normalized = normalizeTool(rawTools[i], i, providerId);
        if (normalized.ok) tools.push(normalized.value);
        else quarantined.push(normalized.quarantined);
    }

    const rawResources = Array.isArray(raw.resources) ? raw.resources : [];
    for (let i = 0; i < rawResources.length; i += 1) {
        const normalized = normalizeResource(rawResources[i], i, providerId);
        if (normalized.ok) resources.push(normalized.value);
        else quarantined.push(normalized.quarantined);
    }

    const rawPrompts = Array.isArray(raw.prompts) ? raw.prompts : [];
    for (let i = 0; i < rawPrompts.length; i += 1) {
        const promptDef = rawPrompts[i];
        if (!promptDef || typeof promptDef !== 'object' || typeof promptDef.name !== 'string' || !promptDef.name.trim()) {
            quarantined.push({
                kind: 'prompt',
                reasonCode: 'mcp_capability_invalid',
                detail: 'prompt declarations must include a non-empty name',
                index: i,
            });
            continue;
        }
        prompts.push({
            ...promptDef,
            name: promptDef.name.trim(),
            _provenance: { providerId, capabilityKind: 'prompt' },
        });
    }

    const quarantinedCounts = {
        tools: quarantined.filter((q) => q.kind === 'tool').length,
        resources: quarantined.filter((q) => q.kind === 'resource').length,
        prompts: quarantined.filter((q) => q.kind === 'prompt').length,
    };
    return {
        providerId,
        tools,
        resources,
        prompts,
        quarantined,
        approvedCounts: { tools: tools.length, resources: resources.length, prompts: prompts.length },
        quarantinedCounts,
        generatedAt: nowIso(now),
    };
}

export function redactProviderDiagnostics(record: McpProviderRecord): Record<string, unknown> {
    const redactKeys = new Set(
        (record.diagnostics.redactEnvKeys ?? [])
            .map((k) => k.toLowerCase()),
    );
    const redactHeaderKeys = new Set(
        (record.diagnostics.redactHeaderKeys ?? [])
            .map((k) => k.toLowerCase()),
    );

    const base: Record<string, unknown> = {
        id: record.id,
        displayName: record.displayName,
        providerKind: record.providerKind,
        templateKind: record.templateKind,
        transportType: record.transportType,
        enabled: record.enabled,
        tags: record.tags,
    };

    if (record.transportType === 'stdio') {
        const cfg = record.transportConfig as McpStdioTransportConfig;
        const redactedEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(cfg.env ?? {})) {
            const shouldRedact = [...redactKeys].some((key) => key && k.toLowerCase().includes(key));
            redactedEnv[k] = shouldRedact ? '<redacted>' : v;
        }
        base.transportConfig = {
            command: cfg.command,
            args: cfg.args,
            cwd: cfg.cwd,
            startupTimeoutMs: cfg.startupTimeoutMs,
            env: redactedEnv,
        };
    } else if (record.transportType === 'websocket') {
        const cfg = record.transportConfig as McpWebsocketTransportConfig;
        base.transportConfig = {
            url: cfg.url,
            timeoutMs: cfg.timeoutMs,
            expectedProtocolVersion: cfg.expectedProtocolVersion,
        };
    } else {
        const cfg = record.transportConfig as McpHttpTransportConfig;
        const redactedHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(cfg.headers ?? {})) {
            const shouldRedact = [...redactHeaderKeys].some((key) => key && k.toLowerCase().includes(key));
            redactedHeaders[k] = shouldRedact ? '<redacted>' : v;
        }
        base.transportConfig = {
            baseUrl: cfg.baseUrl,
            timeoutMs: cfg.timeoutMs,
            healthEndpoint: cfg.healthEndpoint,
            expectedProtocolVersion: cfg.expectedProtocolVersion,
            headers: redactedHeaders,
        };
    }

    return base;
}

export function createActivationRequest(providerId: string, now: () => number = () => Date.now()): McpProviderActivationRequest {
    return {
        providerId,
        requestedAt: nowIso(now),
        requestedBy: 'api',
    };
}

export function appendPhase(
    phases: McpOnboardingPhaseOutcome[],
    phaseName: McpOnboardingPhase,
    status: McpOnboardingPhaseOutcome['status'],
    now: () => number,
    reasonCode?: McpAuthorityReasonCode,
    detail?: string,
) {
    phases.push(phase(now, { phase: phaseName, status, reasonCode, detail }));
}
