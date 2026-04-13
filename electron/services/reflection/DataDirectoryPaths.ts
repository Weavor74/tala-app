import * as path from 'path';
import * as fs from 'fs';
import { appStorageRootPath } from '../PathResolver';

export class ReflectionDataDirectories {
    private readonly dataRoot: string;

    constructor(rootPath: string) {
        // Support both app-root and data-root callers without duplicating /data.
        this.dataRoot = path.basename(rootPath) === 'data'
            ? rootPath
            : path.join(rootPath, 'data');
        if (!fs.existsSync(this.dataRoot)) {
            fs.mkdirSync(this.dataRoot, { recursive: true });
        }
        if (!path.resolve(this.dataRoot).toLowerCase().startsWith(path.resolve(appStorageRootPath).toLowerCase())) {
            console.warn(`[PathGuard] write escaped app root path=${this.dataRoot}`);
        }
        this.ensureDirectories();
    }

    private ensureDirectories() {
        const dirs = [
            this.reflectionsRoot,
            this.journalDir,
            this.evidenceDir,
            this.goalsDir,
            this.queueDir,
            this.selfEditsRoot,
            this.stagedDir,
            this.approvedDir,
            this.rejectedDir,
            this.diffsDir,
            this.archivesRoot,
            this.prePatchDir,
            this.manifestsDir,
            this.validationRoot,
            this.validationReportsDir,
            this.validationHistoryDir,
            this.identityRoot,
            this.identityImmutableDir,
            this.logsDir
        ];

        for (const d of dirs) {
            if (!fs.existsSync(d)) {
                fs.mkdirSync(d, { recursive: true });
            }
        }
    }

    get reflectionsRoot() { return path.join(this.dataRoot, 'reflection'); }
    get journalDir() { return path.join(this.reflectionsRoot, 'journal'); }
    get evidenceDir() { return path.join(this.reflectionsRoot, 'evidence'); }
    get goalsDir() { return path.join(this.reflectionsRoot, 'goals'); }
    get queueDir() { return path.join(this.reflectionsRoot, 'queue'); }

    get selfEditsRoot() { return path.join(this.dataRoot, 'self_edits'); }
    get stagedDir() { return path.join(this.selfEditsRoot, 'staged'); }
    get approvedDir() { return path.join(this.selfEditsRoot, 'approved'); }
    get rejectedDir() { return path.join(this.selfEditsRoot, 'rejected'); }
    get diffsDir() { return path.join(this.selfEditsRoot, 'diffs'); }

    get archivesRoot() { return path.join(this.dataRoot, 'archives'); }
    get prePatchDir() { return path.join(this.archivesRoot, 'pre_patch'); }
    get manifestsDir() { return path.join(this.archivesRoot, 'manifests'); }

    get validationRoot() { return path.join(this.dataRoot, 'validation'); }
    get validationReportsDir() { return path.join(this.validationRoot, 'reports'); }
    get validationHistoryDir() { return path.join(this.validationRoot, 'history'); }

    get identityRoot() { return path.join(this.dataRoot, 'identity'); }
    get identityImmutableDir() { return path.join(this.identityRoot, 'immutable'); }

    get logsDir() { return path.join(this.dataRoot, 'logs'); }
}


