import { MemoryService } from './electron/services/MemoryService';

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

async function runTests() {
    const service = new MemoryService();

    console.log("=== Running Scenario S7: Source Normalization ===");

    // Using the private method via casting for test purposes
    const normalize = (service as any).normalizeMemory.bind(service);

    const leg1 = normalize({ id: "leg-1", text: "Old memory", metadata: { source: "undefined" } });
    console.log("Normalized undefined source to:", leg1.metadata.source);
    assert(leg1.metadata.source === 'explicit', "Undefined source should map to explicit");

    const leg2 = normalize({ id: "leg-2", text: "Old conversation", metadata: { source: "conversation" } });
    console.log("Normalized conversation source to:", leg2.metadata.source);
    assert(leg2.metadata.source === 'explicit', "Conversation source should map to explicit");

    const valid = normalize({ id: "can-1", text: "Valid mem0", metadata: { source: "mem0" } });
    console.log("Normalized canonical mem0 to:", valid.metadata.source);
    assert(valid.metadata.source === 'mem0', "Canonical sources should remain unchanged");

    console.log("All source normalization scenarios PASSED.");
}

runTests().catch(console.error);
