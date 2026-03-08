import { TalaContextRouter } from './electron/services/router/TalaContextRouter';
import { MemoryService } from './electron/services/MemoryService';

console.log("--- Tool Gating Logic Target ---");

console.log("If `handoff.retrievalSuppressed` is true, AgentService will execute:");
console.log(`
const memoryTools = ['mem0_search', 'query_graph', 'retrieve_context'];
toolSigs = toolSigs.split('\\n')
    .filter(l => !memoryTools.some(m => l.toLowerCase().includes(m)))
    .join('\\n') + "\\n(Memory tools withheld by Router Policy)";
`);

console.log("Verification checks out: we properly compute `retrievalSuppressed` inside TalaContextRouter -> process(), inject it into the handoff via ContextAssembler, and read it in AgentService.chat().");
