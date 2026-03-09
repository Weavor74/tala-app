import * as crypto from 'crypto';

/**
 * Agent Behavioral Monitoring & Safety System.
 * 
 * The `RuntimeSafety` service monitors the agent's actions in real-time to 
 * detect and prevent unintended behaviors, such as infinite loops, redundant 
 * tool calls, or duplicate memory persistence.
 * 
 * **Core Responsibilities:**
 * - **Tool Cooldowns**: Enforces a minimum time between repetitive tool calls.
 * - **Loop Detection**: Monitors the last several assistant responses for exact 
 *   or near-exact string matches to identify stalled reasoning loops.
 * - **Duplicate Memory Prevention**: Uses hashing to ensure the agent doesn't 
 *   write the same "fact" multiple times in a short window.
 * - **Context Throttling**: Limits the history of recorded tool executions to 
 *   maintain high performance.
 */
export class RuntimeSafety {
    private toolHistory: Map<string, number[]> = new Map();
    private recentResponses: string[] = [];
    private memoryHashes: Set<string> = new Set();
    private readonly MAX_RESPONSES = 5;
    private readonly TOOL_COOLDOWN_MS = 10000;
    private readonly LOOP_THRESHOLD = 3;

    /**
     * Records a tool execution for loop and cooldown monitoring.
     * 
     * Maintains a rolling window of the last 10 executions per tool. This 
     * metadata is used by `AgentService` to determine if a turn should be 
     * throttled or if the agent is stuck in a repetitive cycle.
     * 
     * @param toolName - The identifier of the tool being executed.
     */
    public recordToolExecution(toolName: string): void {
        const now = Date.now();
        if (!this.toolHistory.has(toolName)) {
            this.toolHistory.set(toolName, []);
        }
        this.toolHistory.get(toolName)!.push(now);

        // Cleanup old timestamps to keep history lean
        const history = this.toolHistory.get(toolName)!;
        if (history.length > 10) {
            this.toolHistory.set(toolName, history.slice(-10));
        }
    }

    /**
     * Checks if a tool is within its cooldown period.
     */
    public isToolCooldownActive(toolName: string): boolean {
        const history = this.toolHistory.get(toolName);
        if (!history || history.length === 0) return false;

        const lastExecuted = history[history.length - 1];
        return (Date.now() - lastExecuted) < this.TOOL_COOLDOWN_MS;
    }

    /**
     * Detects repetitive string patterns in the assistant's dialogue.
     * 
     * Maintains a rolling window of `MAX_RESPONSES` (default 5). If the 
     * current normalized response appears `LOOP_THRESHOLD` (default 3) times 
     * within that window, a loop is signaled.
     * 
     * @param text - The latest text response from the agent.
     * @returns True if a repetitive loop is detected.
     */
    public checkResponseLoop(text: string): boolean {
        if (!text || text.trim().length === 0) return false;

        const normalized = text.trim().toLowerCase();
        this.recentResponses.push(normalized);
        if (this.recentResponses.length > this.MAX_RESPONSES) {
            this.recentResponses.shift();
        }

        const count = this.recentResponses.filter(r => r === normalized).length;
        return count >= this.LOOP_THRESHOLD;
    }

    /**
     * Checks if memory content is a duplicate of something recently written.
     */
    public isDuplicateMemory(text: string): boolean {
        const hash = this.hashText(text);
        if (this.memoryHashes.has(hash)) {
            return true;
        }
        this.memoryHashes.add(hash);

        // Keep hashes set manageable
        if (this.memoryHashes.size > 100) {
            const first = this.memoryHashes.values().next().value;
            if (first !== undefined) this.memoryHashes.delete(first);
        }
        return false;
    }

    private hashText(text: string): string {
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    public reset(): void {
        this.toolHistory.clear();
        this.recentResponses = [];
        this.memoryHashes.clear();
    }
}

export const runtimeSafety = new RuntimeSafety();
