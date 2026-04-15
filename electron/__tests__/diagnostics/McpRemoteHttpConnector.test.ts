import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServerConfig } from '../../../shared/settings';
import { McpService } from '../../services/McpService';
import { McpAuthorityService } from '../../services/mcp/McpAuthorityService';

type CloseFn = () => Promise<void>;

function createLifecycleMock() {
    return {
        registerService: vi.fn(),
        onServiceStarting: vi.fn(),
        onServiceReady: vi.fn(),
        onServiceUnavailable: vi.fn(),
        onServiceDegraded: vi.fn(),
        onServiceFailed: vi.fn(),
        onInventoryRefreshed: vi.fn(),
    };
}

async function startRawHttpServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: CloseFn }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}/mcp`,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

async function startStreamableMcpServer(options?: { malformedTools?: boolean }): Promise<{ baseUrl: string; close: CloseFn }> {
    const server = createServer((req, res) => {
        if (!req.url?.startsWith('/mcp')) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        const handle = async () => {
            if (req.method !== 'POST') {
                res.statusCode = 405;
                res.end('method not allowed');
                return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const bodyText = Buffer.concat(chunks).toString('utf8');
            const payload = bodyText ? JSON.parse(bodyText) : null;
            const messages = Array.isArray(payload) ? payload : [payload];
            const responses = messages
                .map((msg: any) => {
                    if (!msg || typeof msg !== 'object') return null;
                    if (msg.method === 'initialize' && msg.id !== undefined) {
                        return {
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: {
                                protocolVersion: msg.params?.protocolVersion || '2025-03-26',
                                capabilities: { tools: {}, resources: {}, prompts: {} },
                                serverInfo: { name: 'remote-http-test', version: '1.0.0' },
                            },
                        };
                    }
                    if (msg.method === 'tools/list' && msg.id !== undefined) {
                        return {
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: {
                                tools: options?.malformedTools
                                    ? [{ name: '' }]
                                    : [{ name: 'remote_alpha', description: 'Remote alpha', inputSchema: { type: 'object', properties: {} } }],
                            },
                        };
                    }
                    if (msg.method === 'resources/list' && msg.id !== undefined) {
                        return {
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: { resources: [] },
                        };
                    }
                    if (msg.method === 'prompts/list' && msg.id !== undefined) {
                        return {
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: { prompts: [] },
                        };
                    }
                    if (msg.id !== undefined) {
                        return {
                            jsonrpc: '2.0',
                            id: msg.id,
                            error: { code: -32601, message: `method not found: ${msg.method}` },
                        };
                    }
                    return null;
                })
                .filter(Boolean);
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            if (responses.length === 0) {
                res.end('{}');
                return;
            }
            res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses));
        };
        void handle().catch((error) => {
            // eslint-disable-next-line no-console
            console.error('streamable-http-test-server-error', error);
            res.statusCode = 500;
            res.end(String(error?.stack || error));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    return {
        baseUrl: `http://127.0.0.1:${port}/mcp`,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

function makeHttpConfig(id: string, baseUrl: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
    return {
        id,
        name: id,
        displayName: id,
        type: 'http',
        baseUrl,
        timeoutMs: 2_000,
        enabled: true,
        ...overrides,
    };
}

async function allocateUnusedBaseUrl(): Promise<string> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    return `http://127.0.0.1:${port}/mcp`;
}

describe('MCP remote Streamable HTTP connector', () => {
    const closers: CloseFn[] = [];

    afterEach(async () => {
        while (closers.length > 0) {
            const closer = closers.pop();
            if (closer) {
                await closer();
            }
        }
    });

    it('valid HTTP registration activates successfully through real connector', async () => {
        const remote = await startStreamableMcpServer();
        closers.push(remote.close);
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-good', remote.baseUrl)]);
        const result = await authority.activateServer('remote-good');
        expect(result.ok).toBe(true);
        expect(result.state).toBe('active');
        expect(result.activation?.transportConnected).toBe(true);
        const caps = await authority.getApprovedCapabilities('remote-good');
        expect(caps.tools.some((t: any) => t.name === 'remote_alpha')).toBe(true);
    });

    it('unreachable HTTP endpoint classifies as mcp_unreachable', async () => {
        const unreachableBaseUrl = await allocateUnusedBaseUrl();
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-down', unreachableBaseUrl)]);
        const result = await authority.activateServer('remote-down');
        expect(result.reasonCode).toBe('mcp_unreachable');
    });

    it('auth failure classifies explicitly', async () => {
        const authRejectServer = await startRawHttpServer((_req, res) => {
            res.statusCode = 401;
            res.end('unauthorized');
        });
        closers.push(authRejectServer.close);
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-auth', authRejectServer.baseUrl)]);
        const result = await authority.activateServer('remote-auth');
        expect(result.reasonCode).toBe('mcp_auth_failed');
    });

    it('protocol mismatch classifies explicitly', async () => {
        const mismatchServer = await startRawHttpServer((_req, res) => {
            res.statusCode = 400;
            res.end('protocol mismatch');
        });
        closers.push(mismatchServer.close);
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-mismatch', mismatchServer.baseUrl)]);
        const result = await authority.activateServer('remote-mismatch');
        expect(result.reasonCode).toBe('mcp_protocol_mismatch');
    });

    it('malformed capability payload is quarantined and blocked', async () => {
        const remote = await startStreamableMcpServer({ malformedTools: true });
        closers.push(remote.close);
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-malformed', remote.baseUrl)]);
        const result = await authority.activateServer('remote-malformed');
        expect(result.reasonCode).toBe('mcp_capability_invalid');
        const approved = await authority.getApprovedCapabilities('remote-malformed');
        expect(approved.tools).toEqual([]);
    });

    it('approved capabilities flow only through canonical exposure contract', async () => {
        const remote = await startStreamableMcpServer();
        closers.push(remote.close);
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-approved', remote.baseUrl)]);
        await authority.activateServer('remote-approved');
        const approved = await authority.getApprovedCapabilities('remote-approved');
        expect(approved.tools[0]?._provenance?.providerId).toBe('remote-approved');
    });

    it('timeout classification is explicit and isolated', async () => {
        const hangingServer = await startRawHttpServer((_req, _res) => {
            // Intentionally never ends response to trigger timeout.
        });
        closers.push(hangingServer.close);
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-timeout', hangingServer.baseUrl, { timeoutMs: 200 })]);
        const result = await authority.activateServer('remote-timeout');
        expect(result.reasonCode).toBe('mcp_request_timed_out');
    });

    it('one failing remote provider does not degrade another provider', async () => {
        const remote = await startStreamableMcpServer();
        closers.push(remote.close);
        const unreachableBaseUrl = await allocateUnusedBaseUrl();
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([
            makeHttpConfig('remote-healthy', remote.baseUrl),
            makeHttpConfig('remote-failing', unreachableBaseUrl),
        ]);
        const results = await authority.activateAllConfiguredServers();
        expect(results.some((r) => r.serverId === 'remote-healthy' && r.ok)).toBe(true);
        expect(results.some((r) => r.serverId === 'remote-failing' && !r.ok)).toBe(true);
        expect(authority.getApprovedServerIds()).toEqual(['remote-healthy']);
    });

    it('diagnostics redact headers/auth for remote provider', () => {
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-redact', 'https://example.invalid/mcp', {
            headers: { authorization: 'secret', 'x-api-key': 'top-secret', 'x-safe': 'visible' },
        })]);
        const inventory = authority.getInventoryDiagnostics();
        const service = inventory.services.find((s) => s.serviceId === 'remote-redact');
        const headers = ((service?.metadata as any)?.providerDiagnostics?.transportConfig?.headers ?? {}) as Record<string, string>;
        expect(headers.authorization).toBe('<redacted>');
        expect(headers['x-api-key']).toBe('<redacted>');
        expect(headers['x-safe']).toBe('visible');
    });

    it('degraded remote provider can recover deterministically to healthy', async () => {
        const probe = createServer();
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
        const port = (probe.address() as AddressInfo).port;
        await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
        const baseUrl = `http://127.0.0.1:${port}/mcp`;

        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-recover', baseUrl)]);
        const first = await authority.activateServer('remote-recover');

        const remote = await startStreamableMcpServer();
        closers.push(remote.close);
        // Re-sync with same id but new reachable endpoint.
        authority.syncConfiguredServers([makeHttpConfig('remote-recover', remote.baseUrl)]);
        const second = await authority.activateServer('remote-recover');

        expect(first.ok).toBe(false);
        expect(second.ok).toBe(true);
        expect(authority.getApprovedServerIds()).toEqual(['remote-recover']);
    });

    it('onboarding phase outputs remain machine-usable for HTTP providers', async () => {
        const remote = await startStreamableMcpServer();
        closers.push(remote.close);
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-phases', remote.baseUrl)]);
        const result = await authority.activateServer('remote-phases');
        expect((result.phases || []).every((p) => typeof p.phase === 'string' && typeof p.status === 'string')).toBe(true);
        expect((result.phases || []).some((p) => p.phase === 'handshake_classification')).toBe(true);
        expect((result.phases || []).some((p) => p.phase === 'capability_exposure')).toBe(true);
    });

    it('remote activation cannot bypass authority (configured != approved)', async () => {
        const remote = await startStreamableMcpServer();
        closers.push(remote.close);
        const authority = new McpAuthorityService(new McpService(), createLifecycleMock() as any);
        authority.syncConfiguredServers([makeHttpConfig('remote-no-bypass', remote.baseUrl)]);
        expect(authority.getApprovedServerIds()).toEqual([]);
        const approved = await authority.getApprovedCapabilities('remote-no-bypass');
        expect(approved.tools).toEqual([]);
    });
});
