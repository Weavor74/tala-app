import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../../../shared/settings';
import { McpAuthorityService } from '../../services/mcp/McpAuthorityService';
import {
    buildApprovedCapabilityExposure,
    createHttpMcpProviderTemplate,
    createStdioMcpProviderTemplate,
    redactProviderDiagnostics,
    validateProviderRegistration,
} from '../../services/mcp/McpProviderTemplate';

function makeAuthority() {
    const mcp = {
        connect: vi.fn(async () => true),
        disconnect: vi.fn(async () => { }),
        getCapabilities: vi.fn(async () => ({ tools: [{ name: 'alpha' }], resources: [] })),
    };
    const lifecycle = {
        registerService: vi.fn(),
        onServiceStarting: vi.fn(),
        onServiceReady: vi.fn(),
        onServiceUnavailable: vi.fn(),
        onServiceDegraded: vi.fn(),
        onServiceFailed: vi.fn(),
        onInventoryRefreshed: vi.fn(),
    };
    const now = vi.fn(() => Date.parse('2026-04-15T12:00:00.000Z'));
    const authority = new McpAuthorityService(mcp as any, lifecycle as any, now);
    return { mcp, authority };
}

describe('MCP provider templates and onboarding contracts', () => {
    it('stdio provider registration validates required fields', () => {
        const validation = validateProviderRegistration({
            displayName: 'stdio-provider',
            transportType: 'stdio',
            transportConfig: { transportType: 'stdio', command: '' },
            enabled: true,
        }, []);
        expect(validation.ok).toBe(false);
        expect(validation.reasonCode).toBe('mcp_transport_invalid');
    });

    it('http provider registration validates required fields', () => {
        const validation = validateProviderRegistration({
            displayName: 'http-provider',
            transportType: 'http',
            transportConfig: { transportType: 'http', baseUrl: '' },
            enabled: true,
        }, []);
        expect(validation.ok).toBe(false);
        expect(validation.reasonCode).toBe('mcp_transport_invalid');
    });

    it('normalization produces canonical persisted shape', () => {
        const validation = validateProviderRegistration({
            displayName: 'My Local Tool',
            transportType: 'stdio',
            transportConfig: { transportType: 'stdio', command: 'python', args: ['server.py'] },
            enabled: true,
        }, []);
        expect(validation.ok).toBe(true);
        expect(validation.normalized?.id).toMatch(/my-local-tool/);
        expect(validation.normalized?.providerKind).toBe('external_mcp_server');
    });

    it('duplicate provider transport registration is rejected deterministically', () => {
        const first = validateProviderRegistration({
            displayName: 'Tool A',
            transportType: 'stdio',
            transportConfig: { transportType: 'stdio', command: 'python', args: ['a.py'] },
            enabled: true,
        }, []);
        const second = validateProviderRegistration({
            displayName: 'Tool B',
            transportType: 'stdio',
            transportConfig: { transportType: 'stdio', command: 'python', args: ['a.py'] },
            enabled: true,
        }, [first.normalized!]);
        expect(second.ok).toBe(false);
        expect(second.reasonCode).toBe('mcp_registration_conflict');
    });

    it('activation result uses canonical outcome structure', async () => {
        const { authority } = makeAuthority();
        const config: McpServerConfig = {
            id: 'alpha',
            name: 'alpha',
            displayName: 'alpha',
            type: 'stdio',
            command: 'python',
            args: ['server.py'],
            enabled: true,
        };
        authority.syncConfiguredServers([config]);
        const activation = await authority.activateServer('alpha');
        expect(activation.activation?.activationAttempted).toBe(true);
        expect(activation.activation?.transportConnected).toBe(true);
        expect(activation.activation?.active).toBe(true);
    });

    it('malformed capabilities are quarantined and blocked before exposure', async () => {
        const { authority, mcp } = makeAuthority();
        mcp.getCapabilities.mockResolvedValue({ tools: [{ name: '' }], resources: [] });
        authority.syncConfiguredServers([{
            id: 'bad-cap',
            name: 'bad-cap',
            displayName: 'bad-cap',
            type: 'stdio',
            command: 'python',
            args: ['bad.py'],
            enabled: true,
        }]);
        const activation = await authority.activateServer('bad-cap');
        expect(activation.reasonCode).toBe('mcp_capability_invalid');
        const approved = await authority.getApprovedCapabilities('bad-cap');
        expect(approved.tools).toHaveLength(0);
    });

    it('approved capabilities are exposed only through canonical contract', async () => {
        const { authority } = makeAuthority();
        authority.syncConfiguredServers([{
            id: 'approved',
            name: 'approved',
            displayName: 'approved',
            type: 'stdio',
            command: 'python',
            args: ['ok.py'],
            enabled: true,
        }]);
        await authority.activateServer('approved');
        const approved = await authority.getApprovedCapabilities('approved');
        expect(approved.tools[0]?._provenance?.providerId).toBe('approved');
    });

    it('diagnostics redact sensitive transport config', () => {
        const template = createHttpMcpProviderTemplate({
            displayName: 'remote',
            baseUrl: 'https://example.com',
            headers: { authorization: 'secret-token' },
        });
        const validation = validateProviderRegistration({
            displayName: template.displayName,
            transportType: template.transportType,
            transportConfig: template.transportConfig,
            diagnostics: template.diagnostics,
            enabled: true,
        }, []);
        const redacted = redactProviderDiagnostics(validation.normalized!);
        expect(((redacted.transportConfig as any).headers.authorization)).toBe('<redacted>');
    });

    it('future provider templates can reuse canonical builders without bypassing authority', () => {
        const stdio = createStdioMcpProviderTemplate({
            displayName: 'builder-stdio',
            command: 'python',
            args: ['x.py'],
        });
        const http = createHttpMcpProviderTemplate({
            displayName: 'builder-http',
            baseUrl: 'https://remote.local',
        });
        expect(stdio.providerKind).toBe('external_mcp_server');
        expect(http.providerKind).toBe('external_mcp_server');
    });

    it('onboarding phase outputs are deterministic and machine-usable', () => {
        const validation = validateProviderRegistration({
            displayName: 'phase-check',
            transportType: 'stdio',
            transportConfig: { transportType: 'stdio', command: 'python' },
            enabled: true,
        }, []);
        expect(validation.phases.map((p) => p.phase)).toEqual([
            'registration_submission',
            'registration_validation',
            'normalization',
        ]);
        expect(validation.phases.every((p) => typeof p.timestamp === 'string')).toBe(true);
    });

    it('legacy payload style cannot bypass canonical onboarding validation', () => {
        const validation = validateProviderRegistration({
            id: 'legacy',
            displayName: 'legacy',
            transportType: 'stdio',
            transportConfig: { transportType: 'stdio', command: '' },
            enabled: true,
        }, []);
        expect(validation.ok).toBe(false);
        expect(validation.reasonCode).toBe('mcp_transport_invalid');
    });

    it('buildApprovedCapabilityExposure captures quarantined counts deterministically', () => {
        const exposure = buildApprovedCapabilityExposure('svc', {
            tools: [{ name: 'ok' }, { name: '' }],
            resources: [{ uri: 'x' }, null],
            prompts: [{ name: 'p1' }, {}],
        }, () => Date.parse('2026-04-15T12:00:00.000Z'));
        expect(exposure.approvedCounts).toEqual({ tools: 1, resources: 1, prompts: 1 });
        expect(exposure.quarantinedCounts).toEqual({ tools: 1, resources: 1, prompts: 1 });
    });
});
