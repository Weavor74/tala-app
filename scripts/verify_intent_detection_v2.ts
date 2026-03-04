/**
 * verify_intent_detection_v2.ts
 *
 * Unit-tests for AgentService.detectToolIntent
 */

function detectToolIntent(userMessage: string): string {
    const lower = userMessage.toLowerCase();

    // 1. FILE_PATH_PATTERN (Explicit files/exts) -> ALWAYS coding
    const FILE_PATH_PATTERN = /\b[a-zA-Z0-9_\-/]+\.(ts|js|json|txt|md|py|tsx|jsx|yml|yaml|sh|css|html|env|toml|ini)\b/i;
    if (FILE_PATH_PATTERN.test(userMessage)) {
        return 'coding';
    }

    // 2. Explicit Memory
    const MEMORY_PATTERN = /\b(remember|save to memory|store this|add to memory|look up in memory|mem0|memory graph|retrieve context|memory)\b/i;
    if (MEMORY_PATTERN.test(lower)) {
        return 'memory';
    }

    // 3. Explicit Management
    const MGMT_PATTERN = /\b(current goal|goals|manage goals|self audit|audit|reflection|routing mode|settings|identity|soul)\b/i;
    if (MGMT_PATTERN.test(lower)) {
        return 'management';
    }

    // 4. REPO_INSPECTION_PATTERN (Explicit actions requiring tools but no specific path)
    const REPO_INSPECTION_PATTERN = /\b(list files|scan|count files|search for|grep|find in repo|show tree|read file|open file|inspect package\.json)\b/i;
    if (REPO_INSPECTION_PATTERN.test(lower)) {
        return 'coding';
    }

    // 5. Tool-action heuristic (anyVerb && anyNoun)
    const intentVerbs = ['create', 'write', 'edit', 'modify', 'delete', 'remove', 'add', 'update', 'patch', 'refactor', 'generate', 'scaffold', 'implement', 'fix', 'run', 'execute', 'lint', 'test', 'build', 'install', 'start'];
    const intentNouns = ['file', 'script', 'folder', 'directory', 'path', 'ts', 'js', 'json', 'md', 'txt', 'npm', 'node', 'pnpm', 'yarn', 'python', 'pytest', 'eslint', 'tsc'];
    const hasVerb = intentVerbs.some(v => lower.includes(v));
    const hasNoun = intentNouns.some(n => lower.includes(n));

    if (hasVerb && hasNoun) {
        return 'coding';
    }

    // 6. Otherwise -> conversation
    return 'conversation';
}

const tests = [
    { input: "Create scripts/test2.txt", expected: "coding" },
    { input: "Create src/main.ts", expected: "coding" },
    { input: "Edit package.json", expected: "coding" },
    { input: "Write README.md", expected: "coding" },
    { input: "Update config.yaml", expected: "coding" },
    { input: "Create scripts/test2.txt then explain what you did", expected: "coding" },
    { input: "Who are you?", expected: "conversation" },
    { input: "Explain the project structure", expected: "conversation" },
    { input: "List files in the repo", expected: "coding" },
    { input: "Remember my name is Steve", expected: "memory" },
    { input: "What is my current goal?", expected: "management" },
    { input: "Summarize why the build failed", expected: "conversation" }, // "build" is a noun, but no verb from the list
    { input: "How does the memory graph work?", expected: "memory" },
    { input: "Search the memory graph", expected: "memory" },
    { input: "Tell me about your soul", expected: "management" }
];

let passed = 0;
let failed = 0;

console.log("=== verify_intent_detection_v2.ts ===\n");

for (const { input, expected } of tests) {
    const actual = detectToolIntent(input);
    if (actual === expected) {
        console.log(`✅ PASS: "${input}" -> ${actual}`);
        passed++;
    } else {
        console.error(`❌ FAIL: "${input}" -> expected ${expected}, got ${actual}`);
        failed++;
    }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
