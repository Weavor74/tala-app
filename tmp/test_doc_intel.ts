import { DocumentationIntelligenceService } from '../electron/services/DocumentationIntelligenceService';
import * as path from 'path';

async function test() {
    console.log('--- Documentation Intelligence Layer Test ---');
    const baseDir = process.cwd();
    console.log(`Base directory: ${baseDir}`);

    const docIntel = new DocumentationIntelligenceService(baseDir);

    console.log('\n1. Initializing Service (Igniting)...');
    await docIntel.ignite();

    console.log('\n2. Testing Retrieval (Query: "TalaContextRouter")');
    const context = docIntel.getRelevantContext('TalaContextRouter');
    console.log('\n--- Retrieved Context Start ---');
    console.log(context);
    console.log('--- Retrieved Context End ---');

    console.log('\n3. Testing Retrieval (Query: "AgentService")');
    const context2 = docIntel.getRelevantContext('AgentService');
    console.log('\n--- Retrieved Context Start ---');
    console.log(context2);
    console.log('--- Retrieved Context End ---');
}

test().catch(console.error);
