const { ToolService } = require('./testToolService');

const tools = new ToolService();

// Mock dependencies
tools.setSystemInfo({});
tools.mcpService = {
    callTool: () => { }
};
tools.mcpTools = new Map();
tools.mcpTools.set('test_mcp_tool', {
    serverId: 'tala-core',
    def: {
        name: 'test_mcp',
        description: 'Test Tool',
        inputSchema: {
            type: 'object',
            properties: {
                flag: { type: 'boolean' }
            }
        }
    }
});

try {
    const schemas = tools.getToolDefinitions();
    console.log(JSON.stringify(schemas, null, 2));
} catch (e) {
    console.error("Crash during getToolDefinitions:", e);
}
