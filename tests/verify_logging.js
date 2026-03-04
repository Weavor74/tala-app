const fs = require('fs');
const path = require('path');
const os = require('os');

// Mimic the logging logic from AgentService.ts to verify the log format and directory creation
const userDataDir = '/tmp/tala-test';
const auditLogPath = path.join(userDataDir, 'data', 'logs', 'mode_audit.log');

function logMode(activeMode, activeProfileId, astroState) {
    if (!fs.existsSync(path.dirname(auditLogPath))) fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    const auditEntry = `[${new Date().toISOString()}] MODE: ${activeMode} | PROFILE: ${activeProfileId} | ASTRO: ${astroState.length > 10} | TOOLS: true\n`;
    fs.appendFileSync(auditLogPath, auditEntry);
}

console.log("--- Verifying Mode Audit Logging ---");

// Test 1: RP Mode
logMode('rp', 'tala', 'Active: Normal');
console.log("Logged RP mode entry.");

// Test 2: Assist Mode
logMode('assist', 'assist', 'Active: High Intensity');
console.log("Logged Assist mode entry.");

const content = fs.readFileSync(auditLogPath, 'utf-8');
console.log("\nLog File Content:");
console.log(content);

if (content.includes('MODE: rp') && content.includes('MODE: assist')) {
    console.log("\n✅ Logging Verification PASSED.");
} else {
    console.log("\n❌ Logging Verification FAILED.");
}
