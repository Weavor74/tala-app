import { IntentClassifier } from './electron/services/router/IntentClassifier';

console.log("--- Intent Classifier Verification ---");

const tests = [
    { input: "Morning", expected: "greeting" },
    { input: "Morning Tala, how are you holding up?", expected: "greeting" },
    { input: "Morning. Help me debug the memory router.", expected: "mixed" },
    { input: "Morning. Help me think through the memory issue, but stay Tala.", expected: "mixed" },
    { input: "Help me with the memory issue from earlier", expected: "technical" }
];

let allPassed = true;

for (const test of tests) {
    const intent = IntentClassifier.classify(test.input);
    const pass = intent.class === test.expected || (test.expected === 'greeting' && ['greeting', 'unknown'].includes(intent.class));
    console.log(`Input: "${test.input}"\n  -> Output: ${intent.class} (Expected: ${test.expected}) | Status: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) allPassed = false;
}

if (!allPassed) {
    console.error("Some IntentClassifier tests failed!");
    process.exit(1);
} else {
    console.log("All IntentClassifier tests passed!");
}
