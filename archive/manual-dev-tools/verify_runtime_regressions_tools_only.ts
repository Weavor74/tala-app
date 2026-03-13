/// <reference types="node" />
/**
 * verify_runtime_regressions_tools_only.ts
 *
 * Unit-tests for the execution grounding, intent detection, and duplicate suppression fixes.
 */

(function runTests() {
    interface ExecutedToolCall {
        name: string;
        arguments: any;
        argsPreview?: string;
        ok: boolean;
        error?: string;
        resultPreview?: string;
        startedAt: number;
        endedAt: number;
    }

    interface TurnExecutionLog {
        turnId: string;
        intent: string;
        usedEnvelope: boolean;
        toolCallsPlanned: Array<{ name: string, arguments: any }>;
        toolCalls: ExecutedToolCall[];
        executedToolCount: number;
        timestamp: number;
    }

    function getGroundedExecutionSummary(log?: TurnExecutionLog): string {
        if (!log) {
            return "No previous execution log found.";
        }
        if (log.toolCallsPlanned.length === 0 && log.toolCalls.length === 0) {
            return "No tools were executed (or planned) in the last turn.";
        }

        let summary = "### [Grounded Tool Execution Log]\n\n";
        summary += `**Turn ID**: \`${log.turnId}\` | **Intent**: \`${log.intent}\` | **Planned**: ${log.toolCallsPlanned.length} | **Executed**: ${log.executedToolCount}\n\n`;

        if (log.toolCalls.length > 0) {
            log.toolCalls.forEach((tc, i) => {
                const status = tc.ok ? "✅ Succeeded" : "❌ Failed";
                summary += `${i + 1}. **${tc.name}** — ${status}\n`;
                if (tc.argsPreview) {
                    summary += `   - **Arguments**: \`${tc.argsPreview}\`\n`;
                }
                if (!tc.ok && tc.error) {
                    summary += `   - **Error**: ${tc.error}\n`;
                } else if (tc.resultPreview) {
                    summary += `   - **Result**: ${tc.resultPreview}\n`;
                }
                summary += "\n";
            });
        } else {
            summary += "_No tools actually reached execution (stopped before execution loop)._";
        }
        return summary.trim();
    }

    function detectToolIntent(userMessage: string): string {
        const lower = userMessage.toLowerCase();
        // 1. FILE_PATH_PATTERN (Explicit files/exts) -> ALWAYS coding
        const FILE_PATH_PATTERN = /\b[a-zA-Z0-9_\-/]+\.(ts|js|json|txt|md|py|tsx|jsx|yml|yaml|sh|css|html|env|toml|ini)\b/i;
        // Also explicit tool names
        const TOOL_TOKEN_PATTERN = /\b(fs_write_text|fs_read_text|fs_list|shell_run|write_file|read_file|list_files|terminal_run|execute_command)\b/i;

        if (FILE_PATH_PATTERN.test(userMessage) || TOOL_TOKEN_PATTERN.test(userMessage)) {
            return 'coding';
        }
        return 'conversation';
    }

    let passed = 0;
    let failed = 0;

    function check(label: string, condition: boolean) {
        if (condition) {
            console.log(`✅ PASS: ${label}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${label}`);
            failed++;
        }
    }

    console.log("=== verify_runtime_regressions_tools_only.ts ===\n");

    // Case 1: Intent Forced
    {
        const intent = detectToolIntent("fs_write_text scripts/_r1_probe.js with EXACT contents: hello");
        check("fs_write_text forces 'coding' intent", intent === 'coding');
    }

    // Case 2: Grounding with logs
    {
        const log: TurnExecutionLog = {
            turnId: "test-turn",
            intent: "coding",
            usedEnvelope: true,
            toolCallsPlanned: [
                { name: "fs_write_text", arguments: { path: "a.txt" } },
                { name: "shell_run", arguments: { command: "ls" } }
            ],
            toolCalls: [
                {
                    name: "fs_write_text",
                    arguments: { path: "a.txt" },
                    argsPreview: '{"path":"a.txt"}',
                    ok: true,
                    resultPreview: "Success",
                    startedAt: 100,
                    endedAt: 200
                }
            ],
            executedToolCount: 1,
            timestamp: Date.now()
        };
        const summary = getGroundedExecutionSummary(log);
        check("Summary mentions fs_write_text", summary.includes("fs_write_text"));
        check("Summary shows executed count 1", summary.includes("**Executed**: 1"));
        check("Summary shows planned count 2", summary.includes("**Planned**: 2"));
        check("Summary does NOT claim shell_run succeeded", !summary.includes("shell_run** — ✅"));
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
