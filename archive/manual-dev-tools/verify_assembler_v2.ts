import { ContextAssembler } from './electron/services/router/ContextAssembler';

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

async function runTests() {
    console.log("=== Running Scenario S5: No-Memory Fallback ===");

    // Substantive query asking about memory, zero approved memories returned
    const s5_handoff = ContextAssembler.assemble([], 'assistant', 'technical', false);

    // Check if the fallback block was injected
    const hasFallback = s5_handoff.blocks.some(b => b.header.includes('FALLBACK CONTRACT'));
    console.log("Fallback Injected (Substantive):", hasFallback);
    assert(hasFallback === true, "S5 MUST inject a strict fallback block");

    console.log("=== Running Control Scenario: Greeting Suppression ===");

    // If retrieval was suppressed merely due to greeting, DO NOT inject the fallback
    const cg_handoff = ContextAssembler.assemble([], 'assistant', 'greeting', true);
    const cgHasFallback = cg_handoff.blocks.some(b => b.header.includes('FALLBACK CONTRACT'));
    console.log("Fallback Injected (Greeting):", cgHasFallback);
    assert(cgHasFallback === false, "Greeting suppression MUST NOT inject a fallback memory block");

    console.log("All ContextAssembler fallback scenarios PASSED.");
}

runTests().catch(console.error);
