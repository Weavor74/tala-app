import { MemoryService, MemoryItem } from '../MemoryService';
import { Mode, ModePolicyEngine } from './ModePolicyEngine';
import { IntentClassifier, Intent } from './IntentClassifier';
import { MemoryFilter } from './MemoryFilter';
import { ContextAssembler, TurnContext } from './ContextAssembler';
import { DocumentationIntelligenceService } from '../DocumentationIntelligenceService';

/**
 * Tala Context Router
 * 
 * The primary entry point for context orchestration in the TALA ecosystem.
 * It determines how to assemble the prompt for each turn by classifying intent,
 * filtering relevant memories, and enforcing mode-based capability policies.
 * 
 * **Pipeline Logic:**
 * 1. **Intent Classification**: Analyzes the query to identify the user's goal.
 * 2. **Retrieval Gating**: Bypasses memory search for simple intents (e.g., greetings).
 * 3. **Memory Retrieval**: Searches the `MemoryService` using mode-scoped weights.
 * 4. **Policy Enforcement**: Filters memories based on security and mode constraints.
 * 5. **Contradiction Resolution**: Merges conflicting memory state.
 * 6. **Prompt Assembly**: Generates the final instruction blocks via the `ContextAssembler`.
 * 7. **Capability Resolution**: Maps the current state to allowed system tools.
 */
export class TalaContextRouter {
    private memoryService: MemoryService;

    constructor(memoryService: MemoryService) {
        this.memoryService = memoryService;
    }

    /**
     * The primary entry point for context orchestration.
     */
    public async process(turnId: string, query: string, mode: Mode, docIntel?: DocumentationIntelligenceService): Promise<TurnContext> {
        console.log(`[TalaRouter] Processing turn ${turnId} in mode=${mode} `);

        // 1. Resolve Mode (Handled by input)
        // 2. Classify Intent
        const intent = IntentClassifier.classify(query);
        const isGreetingOnly = intent.class === 'greeting';
        const retrievalSuppressed = isGreetingOnly; // Gating logic

        console.log(`[TalaRouter] Intent: ${intent.class} | Suppressed: ${retrievalSuppressed} | Reason: ${intent.precedenceLog || 'standard'} `);

        // 3. Retrieval Phase (Conditional)
        let resolved: MemoryItem[] = [];
        let candidateCount = 0;
        let excludedCount = 0;

        if (!retrievalSuppressed) {
            // We query the MemoryService which already implements weighted ranking and association expansion
            // strictly for the requested mode.
            const candidates = await this.memoryService.search(query, 10, mode);
            candidateCount = candidates.length;

            // 4. Validation & Policy Enforcement
            // No untagged memory may enter (handled by Search/Normalize)
            // Strict exclusion based on mode_scope and status
            const filtered = MemoryFilter.filter(candidates, mode, intent);
            excludedCount = candidateCount - filtered.length;

            // 5. Contradiction Resolution
            resolved = MemoryFilter.resolveContradictions(filtered);
        } else {
            console.log(`[TalaRouter] Retrieval bypassed due to ${intent.class} intent.`);
        }

        // 6. Documentation Retrieval Phase (NEW)
        let docContext = '';
        const DOC_RELEVANCE_PATTERN = /\b(architecture|design|interface|spec|protocol|how does|explain|docs|documentation|logic|engine|service|requirement|traceability|security)\b/i;
        if (docIntel && DOC_RELEVANCE_PATTERN.test(query) && mode !== 'rp') {
            console.log(`[TalaRouter] Turn identified as documentation-relevant. Requesting doc context...`);
            docContext = docIntel.getRelevantContext(query);
        }

        // 7. Assembly & Handoff
        // Pass retrievalSuppressed flag to tell assembler not to emit a fallback block when retrieval was intentionally gated.
        const promptBlocks = ContextAssembler.assemble(resolved, mode, intent.class, retrievalSuppressed, docContext).blocks;
        const fallbackUsed = promptBlocks.some((b: import('./ContextAssembler').ContextBlock) => b.header.includes('FALLBACK CONTRACT'));

        // 7. Capability Resolution (done here so TurnContext is self-contained)
        const blockedCapabilities: string[] = [];
        const allowedCapabilities: string[] = [];

        if (mode === 'rp') {
            // RP mode: no external memory/system tools at all
            blockedCapabilities.push('all');
        } else if (retrievalSuppressed) {
            // Greeting suppression: block only memory retrieval tools
            blockedCapabilities.push('memory_retrieval');
        } else {
            allowedCapabilities.push('all');
        }

        console.log(`[TalaRouter] Routing complete.Approved memories: ${resolved.length}/${candidateCount}`);
        console.log(`[TalaRouter] Capabilities — allowed=${JSON.stringify(allowedCapabilities)} blocked=${JSON.stringify(blockedCapabilities)}`);

        const context: TurnContext = {
            turnId,
            resolvedMode: mode,
            intent: {
                class: intent.class,
                confidence: intent.confidence || 0.9,
                isGreeting: isGreetingOnly
            },
            retrieval: {
                suppressed: retrievalSuppressed,
                approvedCount: resolved.length,
                excludedCount: excludedCount
            },
            promptBlocks,
            fallbackUsed,
            allowedCapabilities: allowedCapabilities as any,
            blockedCapabilities: blockedCapabilities as any,
            persistedMode: mode
        };

        return context;
    }
}
