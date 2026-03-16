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
    | 'unknown';

export interface RoutedIntent {
    intent: DeterministicIntent;
    confidence: number;
    // Specific tool to execute if deterministic
    suggestedTool?: string; 
    // Arguments extracted via regex (e.g. file path)
    extractedArgs?: Record<string, string>; 
    isDeterministic: boolean;
    requires_llm: boolean;
}

/**
 * Parses user input to see if it perfectly matches a deterministic action
 * (e.g. "read ToolService.ts", "what changed", "run diagnostics").
 * If it does, the Orchestrator can execute the tool directly WITHOUT an LLM call.
 */
export class DeterministicIntentRouter {
    public static route(input: string): RoutedIntent {
        const text = input.trim();
        const lower = text.toLowerCase();

        // 1. Exact or highly specific matches
        if (/^(hi|hello|hey|good morning|yo|greetings)$/i.test(lower)) {
            return { intent: 'greeting', confidence: 1.0, isDeterministic: true, requires_llm: true };
        }

        if (/(run diagnostics|system check|check repo health|run repo audit|audit (?:the )?repo|repo audit)/i.test(lower)) {
            return { 
                intent: 'repo_audit', 
                confidence: 0.95, 
                isDeterministic: true, 
                suggestedTool: 'system_diagnose',
                requires_llm: false 
            };
        }

        if (/(what branch am i on|current branch|git branch|show branch)/i.test(lower)) {
            return { 
                intent: 'git_branch', 
                confidence: 0.95, 
                isDeterministic: true, 
                suggestedTool: 'shell_run', 
                extractedArgs: { command: 'git branch --show-current' },
                requires_llm: false 
            };
        }

        if (/(git status|what changed|show git diff)/i.test(lower)) {
            // Usually we'd map this to a Git tool
            return { 
                intent: 'git_operation', 
                confidence: 0.95, 
                isDeterministic: true, 
                suggestedTool: 'shell_run', 
                extractedArgs: { command: 'git status' },
                requires_llm: false 
            };
        }

        // 2. File Reads ("read <path>" or "cat <path>" or "show me <path>")
        // Ensure it doesn't have complex trailing instructions (e.g. "read X and explain the routing logic")
        const readMatch = /^(?:read|show|cat(?: me)?)\s+([\w\.\/\-\\]+\.[a-z]+)$/i.exec(lower);
        if (readMatch) {
            return {
                intent: 'file_read',
                confidence: 0.98,
                suggestedTool: 'fs_read_text',
                extractedArgs: { path: readMatch[1] },
                isDeterministic: true,
                requires_llm: false
            };
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
            return {
                intent: 'file_list',
                confidence: 0.95,
                suggestedTool: 'fs_list',
                extractedArgs: { path: resolvedPath },
                isDeterministic: true,
                requires_llm: false
            };
        }

        // 4. Code Search
        const searchRegex = /^(?:search(?: for)?|find|grep)\s+(?:occurrences of\s+)?(['"]?)(.*?)\1$/i;
        const searchMatch = searchRegex.exec(text);
        if (searchMatch && !lower.includes('explain') && !lower.includes('how')) {
            return {
                intent: 'code_search',
                confidence: 0.95,
                suggestedTool: 'fs_search',
                extractedArgs: { query: searchMatch[2] },
                isDeterministic: true,
                requires_llm: false
            };
        }

        // 5. Memory Queries
        if (/(explain|why did|how does|what is the diff|write a plan)/i.test(lower)) {
            return { intent: 'explanation', confidence: 0.9, isDeterministic: false, requires_llm: true };
        }

        return { intent: 'unknown', confidence: 0.0, isDeterministic: false, requires_llm: true };
    }
}
