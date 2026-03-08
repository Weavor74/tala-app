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
        this.emitDiagnostics();
    }

    emitDiagnostics() {
        console.log(`[LogViewerService] Diagnostic Logging Initialized:`);
        console.log(` - Logs Root: ${this.logsDir}`);
        const sources = [
            { id: 'audit', file: 'audit-log.jsonl' },
            { id: 'prompt', file: 'prompt-audit.jsonl' },
            { id: 'runtime-errors', file: 'runtime-errors.jsonl' },
            { id: 'performance', file: 'performance-metrics.jsonl' }
        ];

        sources.forEach(s => {
            const fullPath = path.join(this.logsDir, s.file);
            const exists = fs.existsSync(fullPath);
            console.log(` - Registered Source: ${s.id} (Exists: ${exists})`);
            if (exists) console.log(`   Path: ${fullPath}`);
        });
    }

    appendJsonl(fileName, record, diagnosticTag) {
        try {
            const filePath = path.join(this.logsDir, fileName);
            if (!fs.existsSync(this.logsDir)) {
                fs.mkdirSync(this.logsDir, { recursive: true });
            }
            const line = JSON.stringify(record) + '\n';
            fs.appendFileSync(filePath, line, 'utf-8');
            console.log(`[${diagnosticTag}] append success: ${fileName}`);
        } catch (e) {
            console.warn(`[${diagnosticTag}] append failed to ${fileName}: ${e.message}`);
        }
    }

    logRuntimeError(err) {
        this.appendJsonl('runtime-errors.jsonl', { timestamp: new Date().toISOString(), message: err.message }, 'RuntimeErrorLog');
    }

    logPerformanceMetric(metric) {
        this.appendJsonl('performance-metrics.jsonl', { timestamp: new Date().toISOString(), ...metric }, 'PerformanceMetrics');
    }

    logPromptAudit(record) {
        this.appendJsonl('prompt-audit.jsonl', { timestamp: new Date().toISOString(), ...record }, 'PromptAudit');
    }
}

console.log('--- STARTING LOG WRITER VERIFICATION ---');
const service = new LogViewerServiceMock();

console.log('\n--- TESTING WRITERS ---');
service.logRuntimeError(new Error('Validation Test Error'));
service.logPerformanceMetric({ name: 'test_metric', value: 42 });
service.logPromptAudit({ turnId: 'test_turn' });
console.log('--- VERIFICATION COMPLETE ---');
