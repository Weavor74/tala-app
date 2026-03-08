import * as crypto from 'crypto';

export class RuntimeSafety {
    private toolHistory: Map<string, number[]> = new Map();
    private recentResponses: string[] = [];
    private memoryHashes: Set<string> = new Set();
    private readonly MAX_RESPONSES = 5;
    private readonly TOOL_COOLDOWN_MS = 10000;
    private readonly LOOP_THRESHOLD = 3;

    /**
     * Records a tool execution with current timestamp.
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
     * Checks if the assistant is repeating itself.
     * Returns true if a loop is detected.
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
