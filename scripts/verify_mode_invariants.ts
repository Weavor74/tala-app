// verify_mode_invariants.ts
// Pure logic verification of the invariants implemented in AgentService.ts

async function verifyInvariants() {
    console.log('--- Verifying Routing Invariant Logic (Standalone) ---');

    const testInvariant = (mode: string, intent: string, toolsCount: number) => {
        if (intent === 'conversation' && toolsCount > 0) {
            throw new Error(`Policy Violation: Tools cannot be used in a conversational turn (mode=${mode}, tools=${toolsCount}).`);
        }
        if (mode === 'rp' && toolsCount > 0) {
            throw new Error(`Policy Violation: Tools are disabled in Roleplay mode (intent=${intent}, tools=${toolsCount}).`);
        }
    };

    const testCases = [
        { mode: 'assistant', intent: 'conversation', tools: 1, shouldFail: true },
        { mode: 'assistant', intent: 'coding', tools: 5, shouldFail: false },
        { mode: 'rp', intent: 'coding', tools: 1, shouldFail: true },
        { mode: 'hybrid', intent: 'coding', tools: 3, shouldFail: false },
        { mode: 'rp', intent: 'conversation', tools: 0, shouldFail: false },
    ];

    let failed = 0;

    for (const tc of testCases) {
        process.stdout.write(`Testing mode=${tc.mode}, intent=${tc.intent}, tools=${tc.tools}... `);
        try {
            testInvariant(tc.mode, tc.intent, tc.tools);
            if (tc.shouldFail) {
                console.log('❌ FAILED (Expected error)');
                failed++;
            } else {
                console.log('✅ PASSED');
            }
        } catch (e: any) {
            if (tc.shouldFail) {
                console.log(`✅ PASSED (Caught: ${e.message})`);
            } else {
                console.log(`❌ FAILED (Unexpected error: ${e.message})`);
                failed++;
            }
        }
    }

    if (failed > 0) {
        console.error(`\nFound ${failed} failures in invariant logic.`);
        process.exit(1);
    } else {
        console.log('\nAll invariant logic tests passed.');
        process.exit(0);
    }
}

verifyInvariants().catch(console.error);
