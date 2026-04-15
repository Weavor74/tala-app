import type { McpServerConfig } from '../../../shared/settings';
import type { McpInventoryDiagnostics, McpServiceDiagnostics, RuntimeStatus } from '../../../shared/runtimeDiagnosticsTypes';
import type {
    McpActivationState,
    McpApprovedCapabilityExposure,
    McpAuthorityReasonCode,
    McpAuthorityServerSnapshot,
    McpAuthoritySnapshot,
    McpOnboardingPhaseOutcome,
    McpHttpTransportConfig,
    McpProviderRecord,
    McpRegistrationRequest,
    McpRegistrationResult,
    McpServerClassification,
    McpStdioTransportConfig,
    McpWebsocketTransportConfig,
} from '../../../shared/mcpAuthorityTypes';
import { McpService } from '../McpService';
import { McpLifecycleManager } from '../McpLifecycleManager';
import {
    appendPhase,
    buildApprovedCapabilityExposure,
    classifyActivationResult,
    normalizeProviderRegistration,
    redactProviderDiagnostics,
    validateProviderRegistration,
} from './McpProviderTemplate';

type CapabilityPayload = { tools: any[]; resources: any[]; prompts: any[] };

const nowIso = (now: () => number) => new Date(now()).toISOString();

function statusFromClassification(c: McpServerClassification): RuntimeStatus {
    if (!c.configured) return 'unknown';
    if (c.disabled) return 'disabled';
    if (c.active) return 'ready';
    if (c.degraded) return 'degraded';
    if (!c.reachable) return 'unavailable';
    if (!c.policyApproved) return 'failed';
    return 'starting';
}

function emptyClassification(now: () => number): McpServerClassification {
    return {
        configured: false,
        reachable: false,
        authenticated: false,
        protocolCompatible: false,
        capabilityValid: false,
        healthy: false,
        policyApproved: false,
        active: false,
        degraded: false,
        disabled: false,
        reasonCodes: ['mcp_not_configured'],
        status: 'unknown',
        lastEvaluatedAt: nowIso(now),
    };
}

function classifyErrorReason(error: unknown, transport: 'stdio' | 'websocket' | 'http'): McpAuthorityReasonCode {
    const message = String((error as any)?.message ?? error ?? '').toLowerCase();
    if (message.includes('timeout') || message.includes('timed out')) return 'mcp_request_timed_out';
    if (message.includes('auth') || message.includes('unauthorized') || message.includes('forbidden')) return 'mcp_auth_failed';
    if (message.includes('version') || message.includes('protocol') || message.includes('handshake')) return 'mcp_protocol_mismatch';
    if (transport === 'stdio' && (message.includes('json') || message.includes('parse') || message.includes('stdout'))) return 'mcp_stdio_stream_corrupted';
    return 'mcp_unreachable';
}

function toProviderRecord(config: McpServerConfig, now: () => number): McpProviderRecord {
    const normalized = normalizeProviderRegistration({
        id: config.id,
        displayName: config.displayName || config.name,
        providerKind: config.providerKind ?? 'external_mcp_server',
        templateKind: config.templateKind ?? config.type,
        transportType: config.type,
        transportConfig: config.type === 'stdio'
            ? { transportType: 'stdio', command: config.command || '', args: config.args || [], env: config.env || {}, cwd: config.cwd, startupTimeoutMs: config.startupTimeoutMs }
            : config.type === 'websocket'
                ? { transportType: 'websocket', url: config.url || '', timeoutMs: config.timeoutMs, expectedProtocolVersion: config.expectedCapabilityClass?.[0] }
                : { transportType: 'http', baseUrl: config.baseUrl || config.url || '', timeoutMs: config.timeoutMs, healthEndpoint: config.healthEndpoint, headers: config.headers },
        authMode: config.authToken ? 'token' : 'none',
        capabilityPolicy: { allowedFeatureIds: config.allowedFeatureIds, trustPolicyTier: config.trustPolicyTier },
        activationStrategy: config.activationStrategy ?? 'manual',
        healthCheckStrategy: config.healthCheckStrategy ?? 'protocol_handshake',
        protocolExpectation: { expectedCapabilityClass: config.expectedCapabilityClass },
        diagnostics: { tags: config.diagnosticsTags ?? [] },
        enabled: config.enabled,
    }, now);
    if (!normalized.record) throw new Error(normalized.reason || 'Failed to normalize provider record');
    return normalized.record;
}

function toConfigRecord(record: McpProviderRecord): McpServerConfig {
    const stdioConfig = record.transportType === 'stdio' ? (record.transportConfig as McpStdioTransportConfig) : null;
    const websocketConfig = record.transportType === 'websocket' ? (record.transportConfig as McpWebsocketTransportConfig) : null;
    const httpConfig = record.transportType === 'http' ? (record.transportConfig as McpHttpTransportConfig) : null;
    return {
        id: record.id,
        name: record.displayName,
        displayName: record.displayName,
        type: record.transportType,
        providerKind: record.providerKind,
        templateKind: record.templateKind,
        activationStrategy: record.activationStrategy,
        healthCheckStrategy: record.healthCheckStrategy,
        command: stdioConfig?.command,
        args: stdioConfig?.args,
        env: stdioConfig?.env,
        cwd: stdioConfig?.cwd,
        startupTimeoutMs: stdioConfig?.startupTimeoutMs,
        url: websocketConfig?.url ?? httpConfig?.baseUrl,
        baseUrl: httpConfig?.baseUrl,
        headers: httpConfig?.headers,
        timeoutMs: websocketConfig?.timeoutMs ?? httpConfig?.timeoutMs,
        healthEndpoint: httpConfig?.healthEndpoint,
        expectedCapabilityClass: record.protocolExpectation?.expectedCapabilityClass,
        allowedFeatureIds: record.capabilityPolicy.allowedFeatureIds,
        trustPolicyTier: record.capabilityPolicy.trustPolicyTier,
        diagnosticsTags: record.diagnostics.tags,
        enabled: record.enabled,
    };
}

export class McpAuthorityService {
    private registry = new Map<string, McpServerConfig>();
    private providerRecords = new Map<string, McpProviderRecord>();
    private classification = new Map<string, McpServerClassification>();
    private activationState = new Map<string, McpActivationState>();
    private approvedCapabilities = new Map<string, McpApprovedCapabilityExposure>();
    private onboardingPhases = new Map<string, McpOnboardingPhaseOutcome[]>();
    private updatedAt = new Date(0).toISOString();

    constructor(private readonly mcpService: McpService, private readonly lifecycleManager: McpLifecycleManager, private readonly now: () => number = () => Date.now()) { }

    public getInventoryDiagnostics(): McpInventoryDiagnostics {
        const services: McpServiceDiagnostics[] = [];
        for (const [id, cfg] of this.registry.entries()) {
            const c = this.classification.get(id) ?? emptyClassification(this.now);
            const providerRecord = this.providerRecords.get(id);
            const exposure = this.approvedCapabilities.get(id);
            services.push({
                serviceId: id,
                displayName: cfg.displayName || cfg.name,
                kind: cfg.type,
                providerKind: providerRecord?.providerKind,
                templateKind: providerRecord?.templateKind,
                enabled: cfg.enabled,
                status: c.status,
                degraded: c.degraded,
                ready: c.active,
                lastTransitionTime: c.lastEvaluatedAt,
                lastFailureReason: c.reasonCodes[0],
                restartCount: 0,
                classification: c,
                reasonCodes: c.reasonCodes,
                activationState: this.activationState.get(id) ?? 'pending_activation',
                approvedCapabilityCounts: exposure?.approvedCounts ?? { tools: 0, resources: 0, prompts: 0 },
                quarantinedCapabilityCounts: exposure?.quarantinedCounts ?? { tools: 0, resources: 0, prompts: 0 },
                metadata: {
                    onboardingPhases: this.onboardingPhases.get(id) ?? [],
                    providerDiagnostics: providerRecord ? redactProviderDiagnostics(providerRecord) : undefined,
                    approvedCapabilityCounts: exposure?.approvedCounts ?? { tools: 0, resources: 0, prompts: 0 },
                    quarantinedCapabilityCounts: exposure?.quarantinedCounts ?? { tools: 0, resources: 0, prompts: 0 },
                },
            });
        }
        const totalReady = services.filter((s) => s.ready).length;
        const totalDegraded = services.filter((s) => s.degraded).length;
        const totalUnavailable = services.filter((s) => s.status === 'unavailable' || s.status === 'failed').length;
        return { services, totalConfigured: services.length, totalReady, totalDegraded, totalUnavailable, criticalUnavailable: false, lastUpdated: this.updatedAt };
    }

    public getDiagnosticsInventory(): McpInventoryDiagnostics { return this.getInventoryDiagnostics(); }

    public getSnapshot(): McpAuthoritySnapshot {
        const servers: McpAuthorityServerSnapshot[] = [];
        for (const [id, cfg] of this.registry.entries()) {
            servers.push({
                config: { ...cfg },
                classification: { ...(this.classification.get(id) ?? emptyClassification(this.now)) },
                activationState: this.activationState.get(id) ?? 'pending_activation',
                providerRecord: this.providerRecords.get(id),
                approvedCapabilityExposure: this.approvedCapabilities.get(id),
            });
        }
        return { servers, updatedAt: this.updatedAt };
    }

    public getApprovedServerIds(): string[] {
        return [...this.classification.entries()].filter(([, c]) => c.active && c.policyApproved && c.healthy).map(([id]) => id);
    }

    public async getApprovedCapabilities(serverId: string): Promise<CapabilityPayload> {
        const approved = this.approvedCapabilities.get(serverId);
        return approved ? { tools: approved.tools, resources: approved.resources, prompts: approved.prompts } : { tools: [], resources: [], prompts: [] };
    }

    public syncConfiguredServers(configs: McpServerConfig[]): McpRegistrationResult[] {
        const results: McpRegistrationResult[] = [];
        const previousIds = new Set(this.registry.keys());
        const acceptedRecords: McpProviderRecord[] = [];
        for (const cfg of configs) {
            const candidate = toProviderRecord(cfg, this.now);
            const validation = validateProviderRegistration({ ...candidate, transportConfig: candidate.transportConfig, enabled: candidate.enabled }, acceptedRecords, this.now);
            if (!validation.ok || !validation.normalized) {
                results.push(classifyActivationResult({ serverId: cfg.id || 'unknown', state: 'rejected', reasonCode: validation.reasonCode ?? 'mcp_registration_invalid', reason: validation.reason, phases: validation.phases, registrationAccepted: false, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false }));
                continue;
            }
            const record = validation.normalized;
            acceptedRecords.push(record);
            const normalizedConfig = toConfigRecord(record);
            this.registry.set(record.id, normalizedConfig);
            this.providerRecords.set(record.id, record);
            this.onboardingPhases.set(record.id, validation.phases);
            this.lifecycleManager.registerService(record.id, record.displayName, normalizedConfig.type, normalizedConfig.enabled);
            previousIds.delete(record.id);
            const current = this.classification.get(record.id) ?? emptyClassification(this.now);
            current.configured = true;
            current.disabled = !record.enabled;
            current.reasonCodes = record.enabled ? [] : ['mcp_disabled'];
            current.status = statusFromClassification(current);
            current.lastEvaluatedAt = nowIso(this.now);
            this.classification.set(record.id, current);
            this.activationState.set(record.id, record.enabled ? 'pending_activation' : 'registered');
            results.push(classifyActivationResult({ serverId: record.id, state: record.enabled ? 'pending_activation' : 'registered', phases: validation.phases, registrationAccepted: true, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false }));
        }
        for (const removedId of previousIds) {
            this.registry.delete(removedId);
            this.providerRecords.delete(removedId);
            this.classification.delete(removedId);
            this.activationState.delete(removedId);
            this.approvedCapabilities.delete(removedId);
            this.onboardingPhases.delete(removedId);
            void this.mcpService.disconnect(removedId);
        }
        this.updatedAt = nowIso(this.now);
        this.lifecycleManager.onInventoryRefreshed();
        return results;
    }

    public validateRegistrationRequest(request: McpRegistrationRequest, existingConfigs: McpServerConfig[]): McpRegistrationResult {
        const existingRecords = existingConfigs.map((cfg) => toProviderRecord(cfg, this.now));
        const validation = validateProviderRegistration(request, existingRecords, this.now);
        if (!validation.ok) return classifyActivationResult({ serverId: request.id || 'unknown', state: 'rejected', reasonCode: validation.reasonCode ?? 'mcp_registration_invalid', reason: validation.reason, phases: validation.phases, registrationAccepted: false, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false });
        return classifyActivationResult({ serverId: validation.normalized!.id, state: request.enabled ? 'pending_activation' : 'registered', phases: validation.phases, registrationAccepted: true, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false });
    }

    public buildConfigFromRegistration(request: McpRegistrationRequest): McpServerConfig {
        const normalized = normalizeProviderRegistration(request, this.now);
        if (!normalized.record) throw new Error(normalized.reason || 'Invalid MCP registration payload');
        return toConfigRecord(normalized.record);
    }

    public registerServerWithPersistence(request: McpRegistrationRequest, existingConfigs: McpServerConfig[], persistNextConfigs: (configs: McpServerConfig[]) => void): McpRegistrationResult {
        const validation = this.validateRegistrationRequest(request, existingConfigs);
        const phases = [...(validation.phases ?? [])];
        if (!validation.ok) return validation;
        const nextConfigs = [...existingConfigs, this.buildConfigFromRegistration(request)];
        try {
            persistNextConfigs(nextConfigs);
            appendPhase(phases, 'persistence', 'succeeded', this.now);
            this.syncConfiguredServers(nextConfigs);
            return { ...validation, phases };
        } catch (error) {
            appendPhase(phases, 'persistence', 'failed', this.now, 'mcp_registration_invalid', String(error));
            return classifyActivationResult({ serverId: validation.serverId, state: 'rejected', reasonCode: 'mcp_registration_invalid', reason: String((error as any)?.message ?? error), phases, registrationAccepted: false, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false });
        }
    }

    public async activateAllConfiguredServers(): Promise<McpRegistrationResult[]> {
        const ids = [...this.registry.values()].filter((cfg) => cfg.enabled).map((cfg) => cfg.id);
        const results = await Promise.allSettled(ids.map((id) => this.activateServer(id)));
        return results.map((r, idx) => r.status === 'fulfilled' ? r.value : classifyActivationResult({ serverId: ids[idx] || 'unknown', state: 'degraded', reasonCode: 'mcp_unreachable', reason: String(r.reason), phases: [], registrationAccepted: true, activationAttempted: true, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: true, blocked: false }));
    }

    public async activateServer(serverId: string): Promise<McpRegistrationResult> {
        const cfg = this.registry.get(serverId);
        if (!cfg) return classifyActivationResult({ serverId, state: 'rejected', reasonCode: 'mcp_not_configured', reason: 'Server not configured', phases: [], registrationAccepted: false, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false });
        const c = this.classification.get(serverId) ?? emptyClassification(this.now);
        c.configured = true;
        c.disabled = !cfg.enabled;
        c.reasonCodes = [];
        const phases: McpOnboardingPhaseOutcome[] = [];
        appendPhase(phases, 'activation_attempt', 'succeeded', this.now);

        if (!cfg.enabled) {
            c.reasonCodes = ['mcp_disabled'];
            c.status = statusFromClassification(c);
            c.lastEvaluatedAt = nowIso(this.now);
            this.classification.set(serverId, c);
            this.activationState.set(serverId, 'registered');
            this.onboardingPhases.set(serverId, phases);
            return classifyActivationResult({ serverId, state: 'registered', phases, registrationAccepted: true, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false });
        }

        if (cfg.type === 'http') {
            c.reachable = false;
            c.degraded = true;
            c.reasonCodes = ['mcp_transport_not_supported'];
            c.status = statusFromClassification(c);
            c.lastEvaluatedAt = nowIso(this.now);
            this.classification.set(serverId, c);
            this.activationState.set(serverId, 'degraded');
            this.approvedCapabilities.delete(serverId);
            appendPhase(phases, 'handshake_classification', 'failed', this.now, 'mcp_transport_not_supported', 'http runtime connector is not enabled');
            this.onboardingPhases.set(serverId, phases);
            return classifyActivationResult({ serverId, state: 'degraded', reasonCode: 'mcp_transport_not_supported', reason: 'http runtime connector is not enabled', phases, registrationAccepted: true, activationAttempted: true, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: true, blocked: false });
        }

        this.lifecycleManager.onServiceStarting(serverId);
        try {
            const connected = await this.mcpService.connect(cfg);
            if (!connected) {
                c.reachable = false;
                c.degraded = true;
                c.reasonCodes = ['mcp_unreachable'];
                c.status = statusFromClassification(c);
                c.lastEvaluatedAt = nowIso(this.now);
                this.classification.set(serverId, c);
                this.activationState.set(serverId, 'degraded');
                this.lifecycleManager.onServiceUnavailable(serverId, 'connect_failed');
                appendPhase(phases, 'handshake_classification', 'failed', this.now, 'mcp_unreachable', 'connect_failed');
                this.onboardingPhases.set(serverId, phases);
                return classifyActivationResult({ serverId, state: 'degraded', reasonCode: 'mcp_unreachable', reason: 'connect_failed', phases, registrationAccepted: true, activationAttempted: true, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: true, blocked: false });
            }
            c.reachable = true;
            c.protocolCompatible = true;
            c.authenticated = true;
            appendPhase(phases, 'handshake_classification', 'succeeded', this.now);

            const exposure = buildApprovedCapabilityExposure(serverId, await this.mcpService.getCapabilities(serverId, 'connect'), this.now);
            if (exposure.quarantined.length > 0) {
                c.capabilityValid = false;
                c.degraded = true;
                c.reasonCodes = ['mcp_capability_invalid', 'mcp_capability_quarantined'];
                c.status = statusFromClassification(c);
                c.lastEvaluatedAt = nowIso(this.now);
                this.classification.set(serverId, c);
                this.activationState.set(serverId, 'degraded');
                this.approvedCapabilities.delete(serverId);
                this.lifecycleManager.onServiceDegraded(serverId, 'invalid_capability_declaration');
                appendPhase(phases, 'capability_validation', 'failed', this.now, 'mcp_capability_invalid', 'Malformed capability declaration quarantined');
                this.onboardingPhases.set(serverId, phases);
                return classifyActivationResult({ serverId, state: 'degraded', reasonCode: 'mcp_capability_invalid', reason: 'Malformed capability declaration quarantined', phases, registrationAccepted: true, activationAttempted: true, transportConnected: true, authSatisfied: true, protocolCompatible: true, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: true, blocked: false });
            }
            appendPhase(phases, 'capability_validation', 'succeeded', this.now);

            const policy = this.evaluatePolicyApproval(cfg, exposure.tools || []);
            if (!policy.ok) {
                c.policyApproved = false;
                c.reasonCodes = ['mcp_policy_blocked'];
                c.status = statusFromClassification(c);
                c.lastEvaluatedAt = nowIso(this.now);
                this.classification.set(serverId, c);
                this.activationState.set(serverId, 'blocked_by_policy');
                this.approvedCapabilities.delete(serverId);
                this.lifecycleManager.onServiceFailed(serverId, policy.reason || 'policy blocked');
                appendPhase(phases, 'policy_approval', 'failed', this.now, 'mcp_policy_blocked', policy.reason);
                this.onboardingPhases.set(serverId, phases);
                return classifyActivationResult({ serverId, state: 'blocked_by_policy', reasonCode: 'mcp_policy_blocked', reason: policy.reason, phases, registrationAccepted: true, activationAttempted: true, transportConnected: true, authSatisfied: true, protocolCompatible: true, capabilityDeclarationsValid: true, policyApproved: false, active: false, degraded: false, blocked: true });
            }
            appendPhase(phases, 'policy_approval', 'succeeded', this.now);

            c.capabilityValid = true;
            c.policyApproved = true;
            c.healthy = true;
            c.active = true;
            c.degraded = false;
            c.reasonCodes = [];
            c.status = statusFromClassification(c);
            c.lastEvaluatedAt = nowIso(this.now);
            this.classification.set(serverId, c);
            this.activationState.set(serverId, 'active');
            this.approvedCapabilities.set(serverId, exposure);
            this.lifecycleManager.onServiceReady(serverId);
            appendPhase(phases, 'capability_exposure', 'succeeded', this.now);
            appendPhase(phases, 'steady_state_health_updates', 'succeeded', this.now);
            this.onboardingPhases.set(serverId, phases);
            return classifyActivationResult({ serverId, state: 'active', phases, registrationAccepted: true, activationAttempted: true, transportConnected: true, authSatisfied: true, protocolCompatible: true, capabilityDeclarationsValid: true, policyApproved: true, active: true, degraded: false, blocked: false });
        } catch (error) {
            const reasonCode = classifyErrorReason(error, cfg.type);
            c.reachable = false;
            c.authenticated = reasonCode === 'mcp_auth_failed' ? false : c.authenticated;
            c.protocolCompatible = reasonCode === 'mcp_protocol_mismatch' ? false : c.protocolCompatible;
            c.degraded = true;
            c.active = false;
            c.healthy = false;
            c.reasonCodes = [reasonCode];
            c.status = statusFromClassification(c);
            c.lastEvaluatedAt = nowIso(this.now);
            this.classification.set(serverId, c);
            this.activationState.set(serverId, 'degraded');
            this.approvedCapabilities.delete(serverId);
            this.lifecycleManager.onServiceFailed(serverId, String((error as any)?.message ?? error));
            appendPhase(phases, 'handshake_classification', 'failed', this.now, reasonCode, String((error as any)?.message ?? error));
            this.onboardingPhases.set(serverId, phases);
            return classifyActivationResult({ serverId, state: 'degraded', reasonCode, reason: String((error as any)?.message ?? error), phases, registrationAccepted: true, activationAttempted: true, transportConnected: false, authSatisfied: reasonCode !== 'mcp_auth_failed', protocolCompatible: reasonCode !== 'mcp_protocol_mismatch', capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: true, blocked: false });
        } finally {
            this.updatedAt = nowIso(this.now);
        }
    }

    public async disableServer(serverId: string): Promise<McpRegistrationResult> {
        const cfg = this.registry.get(serverId);
        if (!cfg) return classifyActivationResult({ serverId, state: 'rejected', reasonCode: 'mcp_not_configured', reason: 'Server not configured', phases: [], registrationAccepted: false, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false });
        await this.mcpService.disconnect(serverId);
        const c = this.classification.get(serverId) ?? emptyClassification(this.now);
        c.configured = true;
        c.disabled = true;
        c.active = false;
        c.healthy = false;
        c.reasonCodes = ['mcp_disabled'];
        c.status = statusFromClassification(c);
        c.lastEvaluatedAt = nowIso(this.now);
        this.classification.set(serverId, c);
        this.activationState.set(serverId, 'registered');
        this.approvedCapabilities.delete(serverId);
        this.lifecycleManager.onServiceUnavailable(serverId, 'disabled_by_operator');
        this.updatedAt = nowIso(this.now);
        return classifyActivationResult({ serverId, state: 'registered', phases: [], registrationAccepted: true, activationAttempted: false, transportConnected: false, authSatisfied: false, protocolCompatible: false, capabilityDeclarationsValid: false, policyApproved: false, active: false, degraded: false, blocked: false });
    }

    public async restartServer(serverId: string): Promise<McpRegistrationResult> { await this.disableServer(serverId); return this.activateServer(serverId); }

    private evaluatePolicyApproval(cfg: McpServerConfig, tools: Array<{ name?: string }>): { ok: boolean; reason?: string } {
        const allowed = cfg.allowedFeatureIds;
        if (!allowed || allowed.length === 0) return { ok: true };
        const disallowed = tools.map((t) => t?.name || '').filter((name) => name && !allowed.includes(name));
        return disallowed.length > 0 ? { ok: false, reason: `Blocked by allowedFeatureIds policy: ${disallowed.join(', ')}` } : { ok: true };
    }
}
