import { RuntimeSafety } from '../electron/services/RuntimeSafety';

async function runTests() {
    console.log("=== Runtime Safety Verification ===\n");
    const safety = new RuntimeSafety();
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

    // 1. Tool Execution Cooldown
    {
        console.log("Testing Tool Cooldown...");
        safety.recordToolExecution("fs_write_text");
        check("Cooldown active immediately after record", safety.isToolCooldownActive("fs_write_text") === true);
        check("Cooldown NOT active for other tool", safety.isToolCooldownActive("fs_read_text") === false);
    }

    // 2. Response Loop Detection
    {
        console.log("\nTesting Response Loop Detection...");
        const resp = "I have listed the files for you.";
        check("1st occurrence - no loop", safety.checkResponseLoop(resp) === false);
        check("2nd occurrence - no loop", safety.checkResponseLoop(resp) === false);
        check("3rd occurrence - LOOP DETECTED", safety.checkResponseLoop(resp) === true);

        check("Different response - no loop", safety.checkResponseLoop("Hello world") === false);
    }

    // 3. Memory Deduplication
    {
        console.log("\nTesting Memory Deduplication...");
        const mem = "User likes coffee";
        check("1st write - not duplicate", safety.isDuplicateMemory(mem) === false);
        check("2nd write - DUPLICATE detected", safety.isDuplicateMemory(mem) === true);
        check("Different memory - not duplicate", safety.isDuplicateMemory("User likes tea") === false);
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
