import { ContextAssembler } from './electron/services/router/ContextAssembler';

console.log("--- Context Assembler Fallback Verification ---");

// Test Case 1: Substantive Intent, No Memories
const handoff1 = ContextAssembler.assemble([], 'assistant', 'technical', false);
const hasFallback1 = handoff1.blocks.some(b => b.header.includes('FALLBACK CONTRACT'));
console.log(`Test 1 (Technical, No Memories): Fallback Injected = ${hasFallback1} | Status: ${hasFallback1 ? 'PASS' : 'FAIL'}`);

// Test Case 2: Greeting Intent, No Memories (Retrieval Suppressed)
const handoff2 = ContextAssembler.assemble([], 'assistant', 'greeting', true);
const hasFallback2 = handoff2.blocks.some(b => b.header.includes('FALLBACK CONTRACT'));
console.log(`Test 2 (Greeting, Suppressed): Fallback Injected = ${hasFallback2} | Status: ${!hasFallback2 ? 'PASS' : 'FAIL'}`);

// Test Case 3: Substantive Intent, Has Memories
const mockMemories = [{ id: '1', text: 'Test memory', timestamp: Date.now(), salience: 0.5, confidence: 0.9, created_at: Date.now(), last_accessed_at: null, last_reinforced_at: Date.now(), access_count: 0, associations: [], status: 'active' as const }];
const handoff3 = ContextAssembler.assemble(mockMemories, 'assistant', 'technical', false);
const hasFallback3 = handoff3.blocks.some(b => b.header.includes('FALLBACK CONTRACT'));
console.log(`Test 3 (Technical, Has Memories): Fallback Injected = ${hasFallback3} | Status: ${!hasFallback3 ? 'PASS' : 'FAIL'}`);

if (!hasFallback1 || hasFallback2 || hasFallback3) {
    console.error("Some ContextAssembler tests failed!");
    process.exit(1);
} else {
    console.log("All ContextAssembler tests passed!");
}
