import { describe, expect, it, vi } from 'vitest';
import { ToolService } from '../electron/services/ToolService';

describe('ToolServiceMcpRefreshSignature', () => {
    it('does not invalidate registry repeatedly for identical MCP tool sets', async () => {
        const tools = Object.create(ToolService.prototype) as any;
        tools.mcpService = null;
        tools.mcpAuthority = null;
        tools.tools = new Map();
        tools.mcpTools = new Map();
        tools.toolRegistryVersion = 0;
        tools.definitionCache = new Map();
        tools.lastMcpToolSignature = '';
        tools.mcpRefreshInFlight = null;
        const invalidateSpy = vi.spyOn(tools, 'invalidateCache');
        tools.mcpService = {
            getActiveConnections: () => ['srv1'],
            getCapabilities: async () => ({
                tools: [{ name: 'foo_tool', inputSchema: { type: 'object', properties: {} } }],
            }),
        };

        await tools.refreshMcpTools();
        const firstCount = invalidateSpy.mock.calls.length;
        await tools.refreshMcpTools();
        const secondCount = invalidateSpy.mock.calls.length;

        expect(firstCount).toBeGreaterThan(0);
        expect(secondCount).toBe(firstCount);
    });
});
