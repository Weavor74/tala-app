import { IBrain, ChatMessage } from '../brains/IBrain';
import { ToolService } from './ToolService';
import { ToolExecutionCoordinator } from './tools/ToolExecutionCoordinator';

/**
 * Agentic Orchestrator Service
 * 
 * Manages background AI sub-agents ("Minions") for autonomous task execution.
 * It extracts the core agentic tool-use loop into a headless version that can
 * reason and act without direct UI side-effects or persistent session pollution.
 * 
 * **Usage Context:**
 * - Used for parallel background tasks (e.g., code analysis, log filtering).
 * - Provides a "Headless Loop" that simulates the agent's main decision cycle.
 * - Handles recursive tool execution and multi-turn reasoning cycles.
 */
export class OrchestratorService {
    private brain: IBrain;
    private tools: ToolService;
    private coordinator: ToolExecutionCoordinator;

    constructor(brain: IBrain, tools: ToolService) {
        this.brain = brain;
        this.tools = tools;
        this.coordinator = new ToolExecutionCoordinator(this.tools);
    }

    /**
     * Updates the active brain instance.
     */
    public setBrain(brain: IBrain) {
        this.brain = brain;
    }

    /**
     * Runs a multi-turn tool-use loop in the background.
     * 
     * @param prompt The goal/task for the sub-agent.
     * @param systemPrompt The persona/instructions for the sub-agent.
     * @param maxTurns Maximum number of tool-use cycles (default 5).
     * @returns The final text response from the sub-agent.
     */
    public async runHeadlessLoop(prompt: string, systemPrompt: string, maxTurns: number = 5): Promise<string> {
        console.log(`[Orchestrator] Starting headless loop for task: ${prompt.substring(0, 50)}...`);

        let messages: ChatMessage[] = [{ role: 'user', content: prompt }];
        let turn = 0;
        let finalOutput = "";

        const toolDefs = this.tools.getToolDefinitions();

        while (turn < maxTurns) {
            turn++;
            console.log(`[Orchestrator] Turn ${turn}/${maxTurns}`);

            try {
                const response = await this.brain.generateResponse(messages, systemPrompt, undefined, toolDefs);

                const assistantMsg: ChatMessage = {
                    role: 'assistant',
                    content: response.content || "",
                    tool_calls: response.toolCalls
                };
                messages.push(assistantMsg);

                if (!response.toolCalls || response.toolCalls.length === 0) {
                    finalOutput = response.content;
                    break;
                }

                // Execute tools
                for (const call of response.toolCalls) {
                    const functionName = call.function.name;
                    let args = call.function.arguments;
                    if (typeof args === 'string') {
                        try { args = JSON.parse(args); } catch (e) { }
                    }

                    console.log(`[Orchestrator] Executing tool: ${functionName}`);
                    let result: string | { result: string; images: string[] };
                    try {
                        const invResult = await this.coordinator.executeTool(functionName, args, undefined, {
                            executionType: 'autonomy_task',
                            executionOrigin: 'autonomy_engine',
                            executionMode: 'system',
                        });
                        result = invResult.data as string | { result: string; images: string[] };
                    } catch (e: unknown) {
                        result = `Error: ${e instanceof Error ? e.message : String(e)}`;
                    }

                    // Special case: we don't handle UI-heavy side effects (like browse_get_dom) 
                    // in the SAME way as AgentService here because we don't have an onEvent handler.
                    // However, we want the sub-agent to be able to read the filesystem/terminal.

                    let resultContent: string;
                    if (typeof result === 'string') {
                        resultContent = result;
                    } else if (result && typeof (result as any).result === 'string') {
                        resultContent = (result as any).result;
                    } else {
                        resultContent = String(result);
                    }

                    messages.push({
                        role: 'tool',
                        content: resultContent,
                        tool_call_id: call.id,
                        name: functionName
                    });
                }

            } catch (e: unknown) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                console.error(`[Orchestrator] Turn ${turn} failed:`, errorMsg);
                return `Orchestration Error: ${errorMsg}`;
            }
        }

        return finalOutput || "No response generated.";
    }
}
