import { TalaContextRouter } from '../../services/router/TalaContextRouter';
import { MemoryService } from '../../services/MemoryService';
import { Mode } from '../../services/router/ModePolicyEngine';
import { MockMemoryService } from './MockServices';

async function verifyRegressionPack() {
    console.log("=== EXECUTING GOLDEN REGRESSION PACK ===");

    // Setup Mock
    const mockMem = new MockMemoryService();
    // Simulate typical explicitly returned memory pool
    const fixtures: any[] = [
        {
            id: 'MEM-LONDON',
            text: "User lives in London.",
            metadata: { source: "explicit", category: "interaction", mem_id: "MEM-LONDON", salience: 0.9, confidence: 1.0 },
            score: 0.9,
            timestamp: Date.now(),
            salience: 0.9,
            confidence: 1.0,
            created_at: Date.now(),
            last_accessed_at: null,
            last_reinforced_at: null,
            status: 'active',
            associations: []
        },
        {
            id: 'MEM-PARIS',
            text: "User lives in Paris.",
            metadata: { source: "rag", category: "interaction", mem_id: "MEM-PARIS", salience: 0.5, confidence: 0.6 },
            score: 0.5,
            timestamp: Date.now() - 100000,
            salience: 0.5,
            confidence: 0.6,
            created_at: Date.now() - 100000,
            last_accessed_at: null,
            last_reinforced_at: null,
            status: 'active',
            associations: []
        }
    ];
    mockMem.mockResults = fixtures;

    // Initialize Router
    const router = new TalaContextRouter(mockMem as unknown as MemoryService);

    let failed = 0;
    const assert = (scenario: string, condition: boolean, message: string) => {
        if (!condition) {
            console.error(`[FAIL] ${scenario}: ${message}`);
            failed++;
        } else {
            console.log(`[PASS] ${scenario}`);
        }
    };

    try {
        // GRP-01
        let ctx = await router.process('test-1', 'Good morning my love', 'rp');
        assert('GRP-01 (Pure Roleplay)', ctx.retrieval.suppressed === true && ctx.promptBlocks.length === 0, 'Retrieval was not suppressed for RP greeting.');

        // GRP-02
        ctx = await router.process('test-2', 'How do I fix the terminal error?', 'assistant');
        assert('GRP-02 (Technical)', ctx.promptBlocks.some(b => b.header.includes('[MEMORY CONTEXT]')), 'Technical context missing in Assistant mode.');

        // GRP-03
        ctx = await router.process('test-3', 'Where do I live?', 'hybrid');
        const textCtx = ctx.promptBlocks.map(b => b.content).join(' ');
        assert('GRP-03 (Contradiction)', textCtx.includes('London') && !textCtx.includes('Paris'), 'Contradiction failed: Both/Wrong memory rendered.');

        // GRP-04
        ctx = await router.process('test-4', 'Morning Tala. Help me debug the memory router.', 'assistant');
        assert('GRP-04 (Mixed Intent)', ctx.retrieval.suppressed === false && ctx.intent.class !== 'greeting', 'Mixed technical intent wrongly suppressed.');

        // GRP-05
        // Change mock to 0 results
        mockMem.mockResults = [];
        ctx = await router.process('test-5', 'What is my preferred default mode?', 'assistant');
        assert('GRP-05 (Fallback)', ctx.fallbackUsed === true, 'Fallback block missing on zero memories.');

        // GRP-06
        mockMem.mockResults = fixtures;
        ctx = await router.process('test-6', 'Morning', 'assistant');
        assert('GRP-06 (Capability Tool Gating)', ctx.blockedCapabilities.includes('memory_retrieval'), 'Memory tools not blocked for pure greeting in assistant mode.');

    } catch (e) {
        console.error("Test Harness Error:", e);
        failed++;
    }

    console.log(`\n=== REGRESSION RESULTS ===`);
    if (failed > 0) {
        console.error(`FAILED: ${failed} scenarios did not meet the baseline.`);
        process.exit(1);
    } else {
        console.log(`SUCCESS: All Golden Regression Pack scenarios pass.`);
        process.exit(0);
    }
}

verifyRegressionPack();
