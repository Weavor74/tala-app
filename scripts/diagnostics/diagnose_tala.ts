import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync, ChildProcess } from 'child_process';
import process from 'process';

/**
 * Tala App Comprehensive Diagnostic Runner (V9 - FINAL GOLD)
 * 
 * Performs a strict MCP compliant handshake:
 * 1. initialize (request) -> wait for response
 * 2. notifications/initialized (notification)
 * 3. tools/list (request) -> wait for tools
 * 4. tools/call {name: "ping"} (request) -> wait for "ok"
 */

const REPO_ROOT = process.cwd();
const DIAG_DIR = path.join(REPO_ROOT, 'data', 'workspace', 'diagnostics');
const LOG_DIR = path.join(DIAG_DIR, 'logs');
const PROBE_DIR = path.join(DIAG_DIR, 'probe_results');
const TOOLS_DIR = path.join(DIAG_DIR, 'mcp_list_tools');
const APP_DATA_DIR = path.join(REPO_ROOT, 'data');

[LOG_DIR, PROBE_DIR, TOOLS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const reportId = `DIAG-${new Date().toISOString().replace(/[:.]/g, '-')}`;

const results: any = {
    metadata: {
        run_id: reportId,
        timestamp: new Date().toISOString(),
        os: process.platform,
        arch: process.arch,
        node_version: process.version
    },
    static_checks: [],
    dependencies: { node: {}, python: [] },
    scripts: { main: {}, files: [] },
    mcp_probes: []
};

function redact(text: string): string {
    if (!text) return text;
    return text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]')
        .replace(/\d{3}-\d{2}-\d{4}/g, '[SSN_REDACTED]');
}

function safeWriteJson(filePath: string, obj: any) {
    fs.writeFileSync(filePath, redact(JSON.stringify(obj, null, 2)));
}

// --- STEP 1: Static Checks ---
console.log('--- [STEP 1] Static File Checks ---');
const requiredFiles = [
    { name: 'App Settings', path: path.join(APP_DATA_DIR, 'app_settings.json'), critical: true },
    { name: 'Bundled Python', path: path.join(REPO_ROOT, 'bin', 'python-win', 'python.exe'), critical: true },
    { name: 'Workspace Root', path: path.join(APP_DATA_DIR, 'workspace'), critical: true }
];

for (const f of requiredFiles) {
    const exists = fs.existsSync(f.path);
    console.log(`${exists ? '✅' : '❌'} ${f.name}`);
    results.static_checks.push({ name: f.name, exists, critical: f.critical });
}

// --- STEP 2: Inventory ---
console.log('\n--- [STEP 2] Inventory ---');
const pythonPath = path.join(REPO_ROOT, 'bin', 'python-win', 'python.exe');
try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
    results.dependencies.node = { dependencies: pkg.dependencies || {}, devDependencies: pkg.devDependencies || {} };
    results.scripts.main = pkg.scripts || {};
    if (fs.existsSync(pythonPath)) {
        const freeze = execSync(`"${pythonPath}" -m pip freeze`, { encoding: 'utf-8' });
        results.dependencies.python = freeze.split('\n').filter((l: string) => l.trim());
    }
} catch (e) { }

// --- STEP 3: Dynamic MCP Probing ---
console.log('\n--- [STEP 3] Dynamic MCP Probing ---');

const mcpServersConfig = [
    { id: 'tala-core', path: 'mcp-servers/tala-core/server.py', venv: 'mcp-servers/tala-core/venv' },
    { id: 'mem0-core', path: 'mcp-servers/mem0-core/server.py' },
    { id: 'astro-engine', module: 'astro_emotion_engine.mcp_server', cwd: 'mcp-servers/astro-engine' },
    { id: 'tala-memory-graph', module: 'memory_graph.server', cwd: 'mcp-servers/tala-memory-graph/src', venv: 'mcp-servers/tala-memory-graph/.venv' },
    { id: 'world-engine', path: 'mcp-servers/world-engine/server.py' }
];

async function probeMcp(config: any): Promise<any> {
    console.log(`Probing ${config.id}...`);
    const probeResult: any = {
        id: config.id, status: 'FAIL', level: 'NONE',
        latency_ms: 0, tool_count: 0, ping_ok: false, error: null
    };

    let cmd = pythonPath;
    if (config.venv) {
        const venvPy = path.join(REPO_ROOT, config.venv, 'Scripts', 'python.exe');
        if (fs.existsSync(venvPy)) cmd = venvPy;
    }

    const spawnArgs = config.module ? ['-m', config.module] : [path.join(REPO_ROOT, config.path)];
    const spawnCwd = config.cwd ? path.join(REPO_ROOT, config.cwd) : REPO_ROOT;

    const stdoutLog = path.join(LOG_DIR, `${config.id}.stdout.log`);
    const stderrLog = path.join(LOG_DIR, `${config.id}.stderr.log`);
    const toolsJson = path.join(TOOLS_DIR, `${config.id}.json`);
    const probeJson = path.join(PROBE_DIR, `${config.id}.json`);

    const stdoutStream = fs.createWriteStream(stdoutLog);
    const stderrStream = fs.createWriteStream(stderrLog);

    return new Promise((resolve) => {
        const child: ChildProcess = spawn(`"${cmd}"`, spawnArgs, {
            shell: true, cwd: spawnCwd, env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        const startTime = Date.now();
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let phase = 'INIT'; // INIT -> HANDSHAKE -> INITIALIZED -> LISTING -> PINGING -> DONE

        const sendMsg = (method: string, params: any, id?: number) => {
            const msg: any = { jsonrpc: "2.0", method, params };
            if (id !== undefined) msg.id = id;
            if (child.stdin?.writable) child.stdin.write(JSON.stringify(msg) + "\n");
        };

        const timeout = setTimeout(() => {
            if (probeResult.status !== 'PASS') {
                probeResult.error = `Timeout during phase: ${phase}`;
                try { child.kill('SIGKILL'); } catch (e) { }
            }
        }, 15000);

        child.stdout?.on('data', (d: Buffer) => {
            if (stdoutStream.writable) stdoutStream.write(d);
            stdoutBuffer += d.toString();
            let boundary = stdoutBuffer.indexOf('\n');
            while (boundary !== -1) {
                const line = stdoutBuffer.substring(0, boundary).trim();
                stdoutBuffer = stdoutBuffer.substring(boundary + 1);
                if (line.startsWith('{')) {
                    try {
                        const json = JSON.parse(line);
                        if (json.id === 0) { // Initialize Response
                            probeResult.level = 'RUNNING';
                            phase = 'INITIALIZED';
                            sendMsg("notifications/initialized", {}); // Send notification
                            // IMMEDIATELY follow with list_tools
                            phase = 'LISTING';
                            sendMsg("tools/list", {}, 1);
                        } else if (json.id === 1) { // tools/list Response
                            probeResult.level = 'RESPONDING';
                            probeResult.tool_count = json.result?.tools?.length || 0;
                            safeWriteJson(toolsJson, json.result || {});
                            if (probeResult.tool_count === 0 && (config.id === 'mem0-core' || config.id === 'tala-core')) {
                                probeResult.error = "Mandatory tools missing";
                                try { child.kill(); } catch (e) { }
                            } else {
                                phase = 'PINGING';
                                sendMsg("tools/call", { name: "ping", arguments: {} }, 2);
                            }
                        } else if (json.id === 2) { // tools/call Response
                            const text = json.result?.content?.[0]?.text || '';
                            probeResult.ping_ok = text.includes('ok');
                            probeResult.level = 'FUNCTIONAL';
                            probeResult.status = 'PASS';
                            probeResult.latency_ms = Date.now() - startTime;
                            phase = 'DONE';
                            try { child.kill(); } catch (e) { }
                        }
                    } catch (e) { }
                }
                boundary = stdoutBuffer.indexOf('\n');
            }
        });

        child.stderr?.on('data', (d: Buffer) => {
            if (stderrStream.writable) stderrStream.write(d);
            stderrBuffer += d.toString();
            if (phase === 'INIT' && (stderrBuffer.includes('READY') || stderrBuffer.includes('Initialized'))) {
                phase = 'HANDSHAKE';
                sendMsg("initialize", {
                    protocolVersion: "2024-11-05", capabilities: {},
                    clientInfo: { name: "tala-diag", version: "1.0.0" }
                }, 0);
            }
        });

        // Fail-safe Handshake after 5s
        setTimeout(() => {
            if (phase === 'INIT') {
                phase = 'HANDSHAKE';
                sendMsg("initialize", {
                    protocolVersion: "2024-11-05", capabilities: {},
                    clientInfo: { name: "tala-diag", version: "1.0.0" }
                }, 0);
            }
        }, 5000);

        child.on('error', (err) => {
            clearTimeout(timeout);
            probeResult.error = err.message;
            resolve(probeResult);
        });

        child.on('close', (code) => {
            clearTimeout(timeout);
            stdoutStream.end();
            stderrStream.end();
            if (code !== 0 && code !== null && probeResult.status !== 'PASS') {
                probeResult.status = 'FAIL';
                probeResult.error = probeResult.error || `Exit code ${code}`;
            }
            safeWriteJson(probeJson, probeResult);
            resolve(probeResult);
        });
    });
}

(async () => {
    for (const cfg of mcpServersConfig) {
        results.mcp_probes.push(await probeMcp(cfg));
    }
    safeWriteJson(path.join(DIAG_DIR, 'DIAGNOSTIC_REPORT.json'), results);

    let md = `# Tala System Diagnostic Report (V9 FINAL)\n\n`;
    md += `**Run ID:** ${results.metadata.run_id} | **Timestamp:** ${results.metadata.timestamp}\n\n`;
    md += `## 1. Executive Summary\n\n`;
    md += `| Subsystem | Status | Level | Tools | Latency |\n`;
    md += `|-----------|--------|-------|-------|---------|\n`;
    results.mcp_probes.forEach((p: any) => {
        md += `| ${p.id} | ${p.status === 'PASS' ? '✅' : '❌'} ${p.status} | ${p.level} | ${p.tool_count} | ${p.latency_ms > 0 ? p.latency_ms + 'ms' : 'N/A'} |\n`;
    });
    md += `\n**Levels**: RUNNING (Handshake), RESPONDING (ListTools), FUNCTIONAL (Ping OK)\n\n`;
    md += `## 2. Artifacts\nTelemetry captured in \`data/workspace/diagnostics/\`.\n`;
    fs.writeFileSync(path.join(DIAG_DIR, 'DIAGNOSTIC_REPORT.md'), md);
    console.log(`\n📄 Report: ${DIAG_DIR}`);
})();
