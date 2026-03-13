import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';

// Fix for ESM __dirname
const __dirname = path.dirname(new URL(import.meta.url).pathname);

async function audit() {
    console.log("=== TALA Identity Integrity Audit ===");

    // 1. Check User Profile
    const appData = process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + '/.config');
    const profilePath = path.join(appData, 'tala-app', 'user-profile.json');

    let canonicalUserId: string | null = null;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (fs.existsSync(profilePath)) {
        try {
            const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
            canonicalUserId = profile.userId;
            console.log(`[INFO] Found user profile. userId: ${canonicalUserId}`);

            if (!canonicalUserId || !uuidRegex.test(canonicalUserId)) {
                console.error(`[FAIL] User ID "${canonicalUserId}" is not a valid UUID!`);
            } else {
                console.log(`[PASS] User ID is UUID-compliant.`);
            }
        } catch (e) {
            console.error(`[ERROR] Failed to read profile: ${e}`);
        }
    } else {
        console.warn("[WARN] No user profile found at app data path.");
    }

    // 2. Check Memory Graph Database
    const dbPath = path.resolve(__dirname, '..', 'mcp-servers', 'tala-memory-graph', 'tala_memory_v1.db');
    if (fs.existsSync(dbPath)) {
        console.log(`[INFO] Auditing memory graph: ${dbPath}`);
        const db = new sqlite3.Database(dbPath);
        // @ts-ignore
        const all = promisify(db.all).bind(db);

        try {
            // Find user nodes
            const nodes: any[] = await all("SELECT id, name, attrs_json FROM nodes");

            let userViolations = 0;
            let piiViolations = 0;
            const forbiddenStrings = ['Steven', 'Pollard', 'Orion', 'anonymous-user'];

            for (const node of nodes) {
                const attrs = JSON.parse(node.attrs_json || '{}');
                const isUser = attrs.entity_type === 'user' || node.name.toLowerCase() === 'user';

                if (isUser) {
                    if (!uuidRegex.test(node.id)) {
                        console.error(`[FAIL] Non-UUID user node: ID="${node.id}", Name="${node.name}"`);
                        userViolations++;
                    }
                }

                // Generic PII check in names/attributes
                for (const seed of forbiddenStrings) {
                    if (node.name.toLowerCase().includes(seed.toLowerCase()) || node.attrs_json.toLowerCase().includes(seed.toLowerCase())) {
                        console.error(`[FAIL] Forbidden identity string "${seed}" found in node ${node.id}`);
                        piiViolations++;
                    }
                }
            }

            if (userViolations === 0) console.log("[PASS] All user entities are UUID-compliant.");
            if (piiViolations === 0) console.log("[PASS] No forbidden identity strings found in graph data.");

        } catch (err) {
            console.error(`[ERROR] Failed to query database: ${err}`);
        } finally {
            db.close();
        }
    } else {
        console.warn(`[SKIP] Memory graph DB not found at ${dbPath}`);
    }

    console.log("=== Audit Complete ===");
}

audit().catch(console.error);
