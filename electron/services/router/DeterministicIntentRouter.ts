import { IntentClass } from './IntentClassifier';

export type DeterministicIntent = 
    | 'greeting' 
    | 'repo_query' 
    | 'file_list' 
    | 'repo_list' 
    | 'file_read' 
    | 'file_write' 
    | 'code_search' 
    | 'code_edit' 
    | 'git_operation' 
    | 'git_branch'
    | 'repo_audit'
    | 'terminal_operation' 
    | 'documentation_query' 
    | 'memory_query' 
    | 'diagnostics' 
    | 'system_check' 
    | 'planning' 
    | 'explanation' 
    | 'browser_navigate'
    | 'memory_add'
    | 'memory_list'
    | 'memory_search'
    | 'unknown';

export type DeterministicOperationKind =
    | 'repo_audit'
    | 'git_branch'
    | 'git_status'
    | 'file_read'
    | 'file_list'
    | 'code_search'
    | 'memory_add'
    | 'memory_list'
    | 'memory_search'
    | 'browser_navigate';

export interface DeterministicOperation {
    kind: DeterministicOperationKind;
    toolName: string;
    args: Record<string, any>;
    requiresLlm: false;
}

export interface RoutedIntent {
    intent: DeterministicIntent;
    confidence: number;
    // Specific tool to execute if deterministic
    suggestedTool?: string; 
    // Arguments extracted via regex (e.g. file path)
    extractedArgs?: Record<string, string>; 
    isDeterministic: boolean;
    requires_llm: boolean;
    deterministicOperation?: DeterministicOperation;
}

/**
 * Parses user input to see if it perfectly matches a deterministic action
 * (e.g. "read ToolService.ts", "what changed", "run diagnostics").
 * If it does, the Orchestrator can execute the tool directly WITHOUT an LLM call.
 */
export class DeterministicIntentRouter {
    private static buildToolRoute(
        intent: DeterministicIntent,
        confidence: number,
        kind: DeterministicOperationKind,
        toolName: string,
        args: Record<string, any>,
    ): RoutedIntent {
        return {
            intent,
            confidence,
            isDeterministic: true,
            suggestedTool: toolName,
            extractedArgs: args as Record<string, string>,
            requires_llm: false,
            deterministicOperation: {
                kind,
                toolName,
                args,
                requiresLlm: false,
            },
        };
    }

    public static route(input: string): RoutedIntent {
        const text = input.trim();
        const lower = text.toLowerCase();

        // 1. Exact or highly specific matches
        if (/^(hi|hello|hey|good morning|yo|greetings)$/i.test(lower)) {
            return { intent: 'greeting', confidence: 1.0, isDeterministic: true, requires_llm: true };
        }

        if (/(run diagnostics|system check|check repo health|run repo audit|audit (?:the )?repo|repo audit)/i.test(lower)) {
            return this.buildToolRoute('repo_audit', 0.95, 'repo_audit', 'system_diagnose', {});
        }

        if (/(what branch am i on|current branch|git branch|show branch)/i.test(lower)) {
            return this.buildToolRoute('git_branch', 0.95, 'git_branch', 'shell_run', { command: 'git branch --show-current' });
        }

        if (/(git status|what changed|show git diff)/i.test(lower)) {
            return this.buildToolRoute('git_operation', 0.95, 'git_status', 'shell_run', { command: 'git status' });
        }

        // 2. File Reads ("read <path>" or "cat <path>" or "show me <path>")
        // Ensure it doesn't have complex trailing instructions (e.g. "read X and explain the routing logic")
        const readMatch = /^(?:read|show|cat(?: me)?)\s+([\w\.\/\-\\]+\.[a-z]+)$/i.exec(lower);
        if (readMatch) {
            return this.buildToolRoute('file_read', 0.98, 'file_read', 'fs_read_text', { path: readMatch[1] });
        }

        // 3. Expanded Directory Listing Matcher
        // Handles: "list * in <path>", "show * in <path>", "what's in <path>", "contents of <path>", etc.
        const listRegex = /^(?:list|show|what is|what's|contents of|ls)\s+(?:(?:files|services|folder|directory|contents|under|in|at|of)\s+)*([\w\.\/\-\\]*)$/i;
        const listMatch = listRegex.exec(lower);
        
        // Secondary check for "list <path>" or "files in <path>"
        const listMatchStrict = /^(?:list|show|files in)\s+([\w\.\/\-\\]+)$/i.exec(lower);
        
        const finalMatch = listMatch || listMatchStrict;

        if (finalMatch && !lower.includes('explain') && !lower.includes('why')) {
            const resolvedPath = finalMatch[1] || '.';
            return this.buildToolRoute('file_list', 0.95, 'file_list', 'fs_list', { path: resolvedPath });
        }

        // 4. Code Search
        const searchRegex = /^(?:search(?: for)?|find|grep)\s+(?:occurrences of\s+)?(['"]?)(.*?)\1$/i;
        const searchMatch = searchRegex.exec(text);
        if (searchMatch && !lower.includes('explain') && !lower.includes('how') && !/^(search|find|look up)\s+(memory|memories)\b/i.test(lower)) {
            return this.buildToolRoute('code_search', 0.95, 'code_search', 'fs_search', { query: searchMatch[2] });
        }

        // 5. Memory deterministic operations (tool-first)
        const memoryAddMatch = /^(?:remember|save (?:this )?memory|store (?:this )?memory|add memory)\s+(.+)$/i.exec(text);
        if (memoryAddMatch && memoryAddMatch[1]?.trim()) {
            return this.buildToolRoute('memory_add', 0.95, 'memory_add', 'mem0_add', { text: memoryAddMatch[1].trim() });
        }

        const memoryListMatch = /^(?:list|show|get)\s+(?:my\s+)?(?:recent\s+)?memories(?:\s+(?:last|limit)\s*(\d+))?$/i.exec(lower);
        if (memoryListMatch) {
            const parsedLimit = Number.parseInt(memoryListMatch[1] || '5', 10);
            const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 5;
            return this.buildToolRoute('memory_list', 0.95, 'memory_list', 'mem0_get_recent', { limit });
        }

        const memorySearchMatch = /^(?:search|find|look up)\s+(?:memory|memories)(?:\s+for|\s+about)?\s+(.+)$/i.exec(text);
        if (memorySearchMatch && memorySearchMatch[1]?.trim()) {
            return this.buildToolRoute('memory_search', 0.94, 'memory_search', 'mem0_search', { query: memorySearchMatch[1].trim() });
        }

        // 6. Browser deterministic open/navigation (single-step only)
        const browserNavigateMatch = /^(?:open|go to|navigate to|browse)\s+(\S+)$/i.exec(text);
        if (browserNavigateMatch) {
            const candidate = browserNavigateMatch[1].trim();
            const isUrlLike =
                /^https?:\/\/\S+$/i.test(candidate) ||
                /^www\.[^\s]+\.[a-z]{2,}(?:\/\S*)?$/i.test(candidate) ||
                /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[\/?#]\S*)?$/i.test(candidate);
            if (isUrlLike) {
                const normalizedUrl = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
                return this.buildToolRoute('browser_navigate', 0.95, 'browser_navigate', 'browse', { url: normalizedUrl });
            }
        }

        // 7. Memory / explanation queries that should keep LLM path
        if (/(explain|why did|how does|what is the diff|write a plan)/i.test(lower)) {
            return { intent: 'explanation', confidence: 0.9, isDeterministic: false, requires_llm: true };
        }

        return { intent: 'unknown', confidence: 0.0, isDeterministic: false, requires_llm: true };
    }
}
