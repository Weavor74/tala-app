import { IntentClassifier } from './electron/services/router/IntentClassifier';

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

async function runTests() {
    console.log("=== Running Scenario S1: Pure Greeting ===");
    let s1 = IntentClassifier.classify("Morning");
    console.log(s1);
    assert(s1.class === 'greeting', "S1 must be greeting");

    console.log("=== Running Scenario S2: Mixed Technical ===");
    let s2 = IntentClassifier.classify("Morning. Help me debug the memory router.");
    console.log(s2);
    assert(['mixed', 'technical'].includes(s2.class), "S2 must not be pure greeting");

    console.log("=== Running Scenario S3: RP Social Greeting ===");
    let s3 = IntentClassifier.classify("Morning Tala, how are you holding up?");
    console.log(s3);
    assert(['greeting', 'mixed', 'social_checkin'].includes(s3.class), "S3 must not fail catastrophically");

    console.log("=== Running Scenario S4: Hybrid Mixed Request ===");
    let s4 = IntentClassifier.classify("Morning. Help me think through the memory issue, but stay Tala.");
    console.log(s4);
    assert(['mixed', 'technical'].includes(s4.class), "S4 must be mixed, not pure greeting");

    console.log("All intent classification scenarios PASSED.");
}

runTests().catch(console.error);
