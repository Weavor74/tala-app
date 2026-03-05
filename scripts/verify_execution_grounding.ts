/// <reference types="node" />
/**
 * verify_execution_grounding.ts
 *
 * Unit-tests for the execution log grounding logic in AgentService.
 */

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
    toolCalls: ExecutedToolCall[];
}

function getGroundedExecutionSummary(lastTurnExecutionLog?: TurnExecutionLog): string {
    if (!lastTurnExecutionLog || lastTurnExecutionLog.toolCalls.length === 0) {
        return "No tools were executed in the last turn (no execution log found).";
    }

    let summary = "### [Grounded Tool Execution Log]\n\n";
    lastTurnExecutionLog.toolCalls.forEach((tc, i) => {
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
    return summary.trim();
}

(function runTests() {
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

    console.log("=== verify_execution_grounding.ts ===\n");

    // Case 1: Empty Log
    {
        const summary = getGroundedExecutionSummary(undefined);
        check("Empty log returns correct 'No tools' message", summary.includes("No tools were executed"));
    }

    // Case 2: Multi-tool log with success and failure
    {
        const log: TurnExecutionLog = {
            turnId: "test-turn-1",
            intent: "coding",
            usedEnvelope: true,
            toolCalls: [
                {
                    name: "fs_write_text",
                    arguments: { path: "test.py", content: "print(1)" },
                    argsPreview: '{"path":"test.py","content":"print(1)"}',
                    ok: true,
                    resultPreview: "Success",
                    startedAt: 100,
                    endedAt: 200
                },
                {
                    name: "shell_run",
                    arguments: { command: "python test.py" },
                    argsPreview: '{"command":"python test.py"}',
                    ok: false,
                    error: "Command failed: python not found",
                    startedAt: 210,
                    endedAt: 300
                }
            ]
        };
        const summary = getGroundedExecutionSummary(log);
        check("Summary contains header", summary.includes("Grounded Tool Execution Log"));
        check("Summary contains fs_write_text", summary.includes("fs_write_text"));
        check("Summary contains success status", summary.includes("✅ Succeeded"));
        check("Summary contains shell_run", summary.includes("shell_run"));
        check("Summary contains fail status", summary.includes("❌ Failed"));
        check("Summary contains error message", summary.includes("python not found"));
        check("Summary contains argsPreview", summary.includes("**Arguments**: `{\"command\":\"python test.py\"}`"));
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
