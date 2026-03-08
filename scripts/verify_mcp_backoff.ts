import { McpService, ServerState } from '../electron/services/McpService';

async function verifyMcpBackoff() {
    console.log('--- Verifying MCP Exponential Backoff ---');
    const mcp = new McpService();

    // 1. Mock a failing server config
    const config: any = {
        id: 'fail-server',
        name: 'Failing Server',
        type: 'stdio',
        command: 'non-existent-command',
        enabled: true
    };

    console.log('Attempting initial connection (should fail)...');
    const connected = await mcp.connect(config);
    console.log(`Connection result: ${connected}`);

    // Check state
    const conns = (mcp as any).connections;
    const conn = conns.get('fail-server');
    console.log(`Server state: ${conn.state}, Retry count: ${conn.retryCount}`);

    if (conn.state !== ServerState.DEGRADED) {
        console.error('❌ FAILED: Server should be in DEGRADED state.');
        process.exit(1);
    }

    // 2. Test backoff timing logic
    mcp.startHealthLoop();
    console.log('Health loop started. Waiting 15s (backoff is 30s)...');

    await new Promise(resolve => setTimeout(resolve, 15000));

    const connAfter15 = conns.get('fail-server');
    console.log(`Retry count after 15s: ${connAfter15.retryCount} (should be 1)`);
    if (connAfter15.retryCount !== 1) {
        console.error('❌ FAILED: Retried too early.');
        process.exit(1);
    }

    console.log('Waiting another 20s (total 35s, backoff should expire)...');
    await new Promise(resolve => setTimeout(resolve, 20000));

    const connAfter35 = conns.get('fail-server');
    console.log(`Retry count after 35s: ${connAfter35.retryCount} (should be 2)`);
    if (connAfter35.retryCount < 2) {
        console.error('❌ FAILED: Backoff should have expired and retried.');
        process.exit(1);
    }

    console.log('✅ SUCCESS: MCP Backoff logic verified.');
    mcp.stopHealthLoop();
    process.exit(0);
}

verifyMcpBackoff().catch(e => {
    console.error(e);
    process.exit(1);
});
