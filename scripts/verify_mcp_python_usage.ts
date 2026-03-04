import fs from 'fs';
import path from 'path';

const SERVICES_DIR = path.join(process.cwd(), 'electron', 'services');

async function verifyPythonUsage() {
    console.log('--- Verifying MCP Python Usage Segregation ---');
    const files = fs.readdirSync(SERVICES_DIR).filter(f => f.endsWith('.ts'));
    let violations = 0;

    const forbidden = [
        /venv\\Scripts\\python\.exe/i,
        /venv\/bin\/python/i,
        /\.venv\\Scripts\\python\.exe/i,
        /\.venv\/bin\/python/i
    ];

    for (const file of files) {
        const content = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf-8');
        for (const pattern of forbidden) {
            if (pattern.test(content)) {
                // Ignore SystemService itself as it detects venvs for OTHER purposes
                if (file === 'SystemService.ts') continue;

                console.error(`VIOLATION in ${file}: Found forbidden venv python path matching ${pattern}`);
                violations++;
            }
        }
    }

    if (violations === 0) {
        console.log('PASS: No forbidden venv paths found in services.');
        process.exit(0);
    } else {
        console.error(`FAIL: Found ${violations} violations.`);
        process.exit(1);
    }
}

verifyPythonUsage().catch(console.error);
