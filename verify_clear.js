const fs = require('fs');
const path = require('path');

// Mock electron app for standalone test
const app = {
    getPath: (name) => {
        if (name === 'userData') return 'd:/src/client1/tala-app/data';
        return '';
    }
};

class LogViewerServiceMock {
    constructor() {
        this.logsDir = path.join(app.getPath('userData'), 'logs');
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    listSources() {
        return [
            { id: 'audit', filePath: path.join(this.logsDir, 'audit-log.jsonl') },
            { id: 'prompt', filePath: path.join(this.logsDir, 'prompt-audit.jsonl') },
            { id: 'runtime-errors', filePath: path.join(this.logsDir, 'runtime-errors.jsonl') },
            { id: 'performance', filePath: path.join(this.logsDir, 'performance-metrics.jsonl') },
        ];
    }

    appendJsonl(fileName, record, diagnosticTag) {
        try {
            const filePath = path.join(this.logsDir, fileName);
            fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
            console.log(`[${diagnosticTag}] append success: ${fileName}`);
        } catch (e) {
            console.warn(`[${diagnosticTag}] append failed: ${e.message}`);
        }
    }

    async clearSource(sourceId) {
        const sources = this.listSources();
        const source = sources.find(s => s.id === sourceId);
        if (!source) throw new Error(`Cannot clear unknown source: ${sourceId}`);

        try {
            if (fs.existsSync(source.filePath)) {
                fs.truncateSync(source.filePath, 0);
            } else {
                fs.writeFileSync(source.filePath, '');
            }

            this.appendJsonl('audit-log.jsonl', {
                timestamp: new Date().toISOString(),
                event: 'log_clear',
                source: sourceId,
                result: 'success',
                mode: 'single_source'
            }, 'AuditLog');

            console.log(`[LogViewerService] Cleared source: ${sourceId}`);
        } catch (e) {
            console.error(`[LogViewerService] Failed to clear source ${sourceId}:`, e.message);
        }
    }

    async clearAll() {
        const sources = this.listSources();
        let clearedCount = 0;

        for (const source of sources) {
            await this.clearSource(source.id);
            clearedCount++;
        }

        this.appendJsonl('audit-log.jsonl', {
            timestamp: new Date().toISOString(),
            event: 'log_clear',
            source: 'all',
            result: 'completed',
            clearedCount,
            mode: 'all_sources'
        }, 'AuditLog');

        return { count: clearedCount };
    }
}

async function verify() {
    console.log('--- STARTING LOG CLEAR VERIFICATION ---');
    const service = new LogViewerServiceMock();

    // Populate with dummy data first
    console.log('\n--- POPULATING DATA ---');
    fs.writeFileSync(path.join(service.logsDir, 'prompt-audit.jsonl'), '{"old":"data"}\n');
    console.log('Created dummy prompt-audit.jsonl');

    const initialSize = fs.statSync(path.join(service.logsDir, 'prompt-audit.jsonl')).size;
    console.log(`Initial size: ${initialSize} bytes`);

    console.log('\n--- CLEARING PROMPT SOURCE ---');
    await service.clearSource('prompt');

    const clearedSize = fs.statSync(path.join(service.logsDir, 'prompt-audit.jsonl')).size;
    console.log(`Cleared size: ${clearedSize} bytes`);

    console.log('\n--- CHECKING AUDIT LOG ---');
    const auditContent = fs.readFileSync(path.join(service.logsDir, 'audit-log.jsonl'), 'utf-8');
    const lastLine = auditContent.trim().split('\n').pop();
    console.log(`Last audit record: ${lastLine}`);

    console.log('\n--- CLEARING ALL ---');
    await service.clearAll();

    console.log('\n--- FINAL FILE CHECK ---');
    service.listSources().forEach(s => {
        const exists = fs.existsSync(s.filePath);
        const size = exists ? fs.statSync(s.filePath).size : 'N/A';
        console.log(`File: ${path.basename(s.filePath)}, Exists: ${exists}, Size: ${size}`);
    });

    console.log('--- VERIFICATION COMPLETE ---');
}

verify();
