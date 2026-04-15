import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAuthorityService } from '../../services/mcp/McpAuthorityService';
import type { McpServerConfig } from '../../../shared/settings';

function makeConfig(id: string, type: 'stdio' | 'websocket' = 'stdio'): McpServerConfig {
    return {
        id,
        name: `Server ${id}`,
        displayName: `Server ${id}`,
        type,
        command: type === 'stdio' ? 'python' : undefined,
        args: type === 'stdio' ? [`${id}.py`] : undefined,
        url: type === 'websocket' ? 'ws://localhost:8080' : undefined,
        enabled: true,
    };
}

function makeMocks() {
    const mcp = {
        connect: vi.fn(async () => true),
        disconnect: vi.fn(async () => {}),
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
    return { mcp, lifecycle, authority };
}

describe('McpAuthorityService governance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('valid registration remains non-active until activation succeeds', async () => {
        const { authority } = makeMocks();
        authority.syncConfiguredServers([makeConfig('svc1')]);
        expect(authority.getApprovedServerIds()).toEqual([]);
        const activate = await authority.activateServer('svc1');
        expect(activate.ok).toBe(true);
        expect(authority.getApprovedServerIds()).toEqual(['svc1']);
    });

    it('invalid registration is rejected with stable reason code', () => {
        const { authority } = makeMocks();
        const result = authority.validateRegistrationRequest({
            displayName: '',
            transportType: 'stdio',
            transportConfig: { transportType: 'stdio', command: '' },
            enabled: true,
        }, []);
        expect(result.ok).toBe(false);
        expect(result.reasonCode).toBe('mcp_registration_invalid');
    });

    it('configured but unreachable server is classified explicitly', async () => {
        const { authority, mcp } = makeMocks();
        mcp.connect.mockResolvedValue(false);
        authority.syncConfiguredServers([makeConfig('unreachable')]);
        const result = await authority.activateServer('unreachable');
        expect(result.ok).toBe(false);
        expect(result.reasonCode).toBe('mcp_unreachable');
    });

    it('reachable but auth-invalid server is classified explicitly', async () => {
        const { authority, mcp } = makeMocks();
        mcp.connect.mockRejectedValue(new Error('unauthorized auth failed'));
        authority.syncConfiguredServers([makeConfig('auth-fail', 'websocket')]);
        const result = await authority.activateServer('auth-fail');
        expect(result.reasonCode).toBe('mcp_auth_failed');
    });

    it('protocol mismatch is classified explicitly', async () => {
        const { authority, mcp } = makeMocks();
        mcp.connect.mockRejectedValue(new Error('protocol version mismatch'));
        authority.syncConfiguredServers([makeConfig('proto-fail', 'websocket')]);
        const result = await authority.activateServer('proto-fail');
        expect(result.reasonCode).toBe('mcp_protocol_mismatch');
    });

    it('malformed capability declaration is blocked before exposure', async () => {
        const { authority, mcp } = makeMocks();
        mcp.getCapabilities.mockResolvedValue({ tools: [{ name: '' }], resources: [] });
        authority.syncConfiguredServers([makeConfig('bad-caps')]);
        const result = await authority.activateServer('bad-caps');
        expect(result.reasonCode).toBe('mcp_capability_invalid');
        expect(authority.getApprovedServerIds()).toEqual([]);
    });

    it('one server failure does not degrade another healthy server', async () => {
        const { authority, mcp } = makeMocks();
        mcp.connect.mockImplementation(async (cfg: McpServerConfig) => cfg.id === 'good');
        authority.syncConfiguredServers([makeConfig('good'), makeConfig('bad')]);
        const results = await authority.activateAllConfiguredServers();
        expect(results.some((r) => r.serverId === 'good' && r.ok)).toBe(true);
        expect(results.some((r) => r.serverId === 'bad' && !r.ok)).toBe(true);
        expect(authority.getApprovedServerIds()).toEqual(['good']);
    });

    it('timeout classification is explicit and isolated', async () => {
        const { authority, mcp } = makeMocks();
        mcp.connect.mockRejectedValue(new Error('request timed out'));
        authority.syncConfiguredServers([makeConfig('timeout-1')]);
        const result = await authority.activateServer('timeout-1');
        expect(result.reasonCode).toBe('mcp_request_timed_out');
    });

    it('degraded server can recover deterministically to healthy', async () => {
        const { authority, mcp } = makeMocks();
        authority.syncConfiguredServers([makeConfig('recover')]);
        mcp.connect.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const first = await authority.activateServer('recover');
        const second = await authority.activateServer('recover');
        expect(first.ok).toBe(false);
        expect(second.ok).toBe(true);
        expect(authority.getApprovedServerIds()).toEqual(['recover']);
    });

    it('configured state alone does not expose capabilities (renderer cannot invent availability)', async () => {
        const { authority } = makeMocks();
        authority.syncConfiguredServers([makeConfig('not-activated')]);
        const caps = await authority.getApprovedCapabilities('not-activated');
        expect(caps.tools).toEqual([]);
        expect(authority.getApprovedServerIds()).toEqual([]);
    });

    it('duplicate registration is rejected deterministically', () => {
        const { authority } = makeMocks();
        const result = authority.validateRegistrationRequest({
            id: 'dup-id',
            displayName: 'Dup',
            transportType: 'stdio',
            transportConfig: { transportType: 'stdio', command: 'python', args: [] },
            enabled: true,
        }, [makeConfig('dup-id')]);
        expect(result.ok).toBe(false);
        expect(result.reasonCode).toBe('mcp_registration_conflict');
    });

    it('stdio stream corruption risk is classified separately when protocol output is polluted', async () => {
        const { authority, mcp } = makeMocks();
        mcp.connect.mockRejectedValue(new Error('stdout parse error: invalid json'));
        authority.syncConfiguredServers([makeConfig('stdio-corrupt', 'stdio')]);
        const result = await authority.activateServer('stdio-corrupt');
        expect(result.reasonCode).toBe('mcp_stdio_stream_corrupted');
    });
});
