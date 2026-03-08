import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

async function verifyAstroImport() {
    const workspaceRoot = process.cwd();
    const mcpServersDir = path.join(workspaceRoot, 'mcp-servers');
    const astroDir = path.join(mcpServersDir, 'astro-engine');
    const pythonPath = process.env.PYTHON_PATH || 'python';

    console.log(`Checking Astro Engine in: ${astroDir}`);
    console.log(`Using Python: ${pythonPath}`);

    const env = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONPATH: astroDir // Add parent dir to PYTHONPATH
    };

    const proc = spawn(pythonPath, ['-m', 'astro_emotion_engine.mcp_server'], {
        cwd: astroDir,
        env
    });

    return new Promise((resolve) => {
        let output = '';
        let errorOutput = '';

        proc.stdout.on('data', (data) => {
            output += data.toString();
            console.log(`[STDOUT] ${data}`);
            if (output.includes('AstroEmotionEngine Engaged')) {
                console.log('✅ Astro Engine started successfully.');
                proc.kill();
                resolve(true);
            }
        });

        proc.stderr.on('data', (data) => {
            errorOutput += data.toString();
            console.error(`[STDERR] ${data}`);
        });

        proc.on('close', (code) => {
            console.log(`Process exited with code ${code}`);
            if (errorOutput.includes('ModuleNotFoundError')) {
                console.error('❌ Failed with ModuleNotFoundError');
                resolve(false);
            }
            resolve(code === 0);
        });

        setTimeout(() => {
            console.log('Timeout waiting for engine startup...');
            proc.kill();
            resolve(false);
        }, 10000);
    });
}

verifyAstroImport().then(success => {
    process.exit(success ? 0 : 1);
});
