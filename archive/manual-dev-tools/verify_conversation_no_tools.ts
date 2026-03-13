import { AgentService } from '../electron/services/AgentService';
import { ToolService } from '../electron/services/ToolService';

async function verifyConversationNoTools() {
    console.log('--- Verifying Conversation Intent Sends No Tools ---');
    // We mock detectToolIntent to return 'conversation'
    const agent = new AgentService();
    (agent as any).detectToolIntent = () => 'conversation';

    // Check ToolService.getToolDefinitions
    const toolService = new ToolService();
    const tools = toolService.getToolDefinitions('conversation');
    console.log(`ToolService.getToolDefinitions('conversation') returned ${tools.length} tools.`);

    if (tools.length !== 0) {
        console.error('❌ FAILED: ToolService should return 0 tools for conversation.');
        process.exit(1);
    }

    console.log('✅ SUCCESS: ToolService returns 0 tools for conversation.');
    process.exit(0);
}

verifyConversationNoTools().catch(e => {
    console.error(e);
    process.exit(1);
});
