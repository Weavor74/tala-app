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

    createArchiveFolder(timestamp) {
        const safeTimestamp = timestamp.replace(/:/g, '-').replace(/\./g, '-');
        const archiveDir = path.join(this.logsDir, 'archive', safeTimestamp);
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
        }
        return archiveDir;
    }

    writeArchiveManifest(archiveDir, manifestData) {
        fs.writeFileSync(
            path.join(archiveDir, 'archive-manifest.json'),
            JSON.stringify(manifestData, null, 2),
            'utf-8'
        );
    }

    async archiveSource(sourceId) {
        const timestamp = new Date().toISOString();
        const sources = this.listSources();
        const source = sources.find(s => s.id === sourceId);

        if (!source) throw new Error(`Cannot archive unknown source: ${sourceId}`);

        const result = {
            success: false,
            mode: 'single_source',
            source: sourceId,
            archiveFolder: null,
            copiedFiles: [],
            missingSources: []
        };

        try {
            const archiveDir = this.createArchiveFolder(timestamp);
            result.archiveFolder = archiveDir;

            const filename = path.basename(source.filePath);
            const exists = fs.existsSync(source.filePath);
            const sizeBytes = exists ? fs.statSync(source.filePath).size : 0;
            const destPath = path.join(archiveDir, filename);

            let copied = false;
            if (exists) {
                fs.copyFileSync(source.filePath, destPath);
                copied = true;
            } else {
                result.missingSources.push(sourceId);
            }

            result.copiedFiles.push({
                source: sourceId,
                filename,
                existsAtArchiveTime: exists,
                copied,
                sizeBytes
            });
            result.success = true;

            this.writeArchiveManifest(archiveDir, {
                timestamp,
                mode: result.mode,
                requestedSource: result.source,
                archiveFolder: archiveDir,
                files: result.copiedFiles
            });

            this.appendJsonl('audit-log.jsonl', {
                timestamp,
                event: 'log_archive',
                source: sourceId,
                mode: result.mode,
                result: 'success',
                archiveFolder: archiveDir
            }, 'AuditLog');

            return result;
        } catch (e) {
            console.error(`[LogViewerService] Failed to archive source ${sourceId}:`, e.message);
            throw e;
        }
    }

    async archiveAll() {
        const timestamp = new Date().toISOString();
        const sources = this.listSources();

        const result = {
            success: false,
            mode: 'all_sources',
            source: 'all',
            archiveFolder: null,
            copiedFiles: [],
            missingSources: []
        };

        try {
            const archiveDir = this.createArchiveFolder(timestamp);
            result.archiveFolder = archiveDir;

            for (const source of sources) {
                const filename = path.basename(source.filePath);
                const exists = fs.existsSync(source.filePath);
                const sizeBytes = exists ? fs.statSync(source.filePath).size : 0;
                const destPath = path.join(archiveDir, filename);

                let copied = false;
                if (exists) {
                    fs.copyFileSync(source.filePath, destPath);
                    copied = true; // Use simple assignment for tests
                } else {
                    result.missingSources.push(source.id);
                }

                result.copiedFiles.push({
                    source: source.id,
                    filename,
                    existsAtArchiveTime: exists,
                    copied: copied,
                    sizeBytes
                });
            }

            result.success = true;

            this.writeArchiveManifest(archiveDir, {
                timestamp,
                mode: result.mode,
                requestedSource: null,
                archiveFolder: archiveDir,
                files: result.copiedFiles
            });

            this.appendJsonl('audit-log.jsonl', {
                timestamp,
                event: 'log_archive',
                source: 'all',
                mode: result.mode,
                result: 'success',
                archivedCount: result.copiedFiles.filter(f => f.copied).length,
                missingCount: result.missingSources.length,
                archiveFolder: archiveDir
            }, 'AuditLog');

            return result;
        } catch (e) {
            console.error(`[LogViewerService] Failed to archive all logs:`, e.message);
            throw e;
        }
    }
}

async function verify() {
    console.log('--- STARTING LOG ARCHIVE VERIFICATION ---');
    const service = new LogViewerServiceMock();

    // Populate with dummy data
    console.log('\n--- POPULATING DATA ---');
    fs.writeFileSync(path.join(service.logsDir, 'prompt-audit.jsonl'), '{"type":"prompt_audit", "message":"foo"}\n');
    console.log('Created dummy prompt-audit.jsonl');

    console.log('\n--- ARCHIVING PROMPT SOURCE ---');
    const singleResult = await service.archiveSource('prompt');
    console.log(`Single Archive Result: \n${JSON.stringify(singleResult, null, 2)}`);

    console.log('\n--- VERIFYING MANIFEST ---');
    const manifestPath = path.join(singleResult.archiveFolder, 'archive-manifest.json');
    if (fs.existsSync(manifestPath)) {
        console.log(`Manifest content: \n${fs.readFileSync(manifestPath, 'utf8')}`);
    } else {
        console.error("Manifest missing!");
    }

    console.log('\n--- TEMPORARILY REMOVING RUNTIME ERRORS LOG ---');
    const errPath = path.join(service.logsDir, 'runtime-errors.jsonl');
    let errExisted = fs.existsSync(errPath);
    if (errExisted) {
        fs.unlinkSync(errPath);
        console.log('Removed runtime-errors.jsonl');
    }

    console.log('\n--- ARCHIVING ALL ---');
    const allResult = await service.archiveAll();
    console.log(`All Archive Result: \n${JSON.stringify(allResult, null, 2)}`);

    console.log('\n--- CHECKING AUDIT LOG ---');
    const auditContent = fs.readFileSync(path.join(service.logsDir, 'audit-log.jsonl'), 'utf-8');
    const lines = auditContent.trim().split('\n');
    console.log(`Last 2 audit records:\n${lines.slice(-2).join('\n')}`);

    console.log('--- VERIFICATION COMPLETE ---');
}

verify();
