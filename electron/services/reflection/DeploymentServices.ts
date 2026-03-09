import * as fs from 'fs';
import * as path from 'path';
import { PromotionRecord, RollbackRecord, CandidatePatch, ValidationReport } from './reflectionEcosystemTypes';
import { ReflectionDataDirectories } from './DataDirectoryPaths';
import { ProtectedFileRegistry } from './ProtectedFileRegistry';
import { ImmutableIdentityRegistry } from './ImmutableIdentityRegistry';

export class PromotionService {
    private directories: ReflectionDataDirectories;
    private protectedRegistry: ProtectedFileRegistry;
    private identityRegistry: ImmutableIdentityRegistry;
    private rootDir: string;

    constructor(rootDir: string, directories: ReflectionDataDirectories, protectedRegistry: ProtectedFileRegistry, identityRegistry: ImmutableIdentityRegistry) {
        this.rootDir = rootDir;
        this.directories = directories;
        this.protectedRegistry = protectedRegistry;
        this.identityRegistry = identityRegistry;
    }

    /**
     * PHASE 5: PROMOTE
     * Safely applies a validated patch to the live workspace.
     */
    public async promotePatch(candidate: CandidatePatch, validationReport: ValidationReport, promotedBy: string = 'internal_auto'): Promise<PromotionRecord> {
        console.log(`[PromotionService] Attempting promotion for patch ${candidate.patchId}...`);

        if (validationReport.overallResult !== 'pass') {
            throw new Error(`Promotion denied: Validation report did not pass. Reason: ${validationReport.summary}`);
        }

        const promotionId = `promo_${Date.now()}`;
        const timestamp = new Date().toISOString();
        const safeTimestamp = timestamp.replace(/:/g, '-').replace(/\./g, '-');

        // 1. Identity Pre-flight check
        for (const file of candidate.filesModified.concat(candidate.filesCreated)) {
            const safety = this.identityRegistry.checkIdentitySafety(file, 'write_live');
            if (!safety.safe) {
                throw new Error(`Promotion denied: Immutable Identity violation on ${file}. Reason: ${safety.reason}`);
            }
        }

        // 2. Prepare Archive
        const archiveDir = path.join(this.directories.prePatchDir, safeTimestamp);
        fs.mkdirSync(archiveDir, { recursive: true });

        const filesPromoted: string[] = [];
        const filesArchived: string[] = [];
        const filesRejected: string[] = [];

        const manifest = {
            timestamp,
            issueId: candidate.issueId,
            patchId: candidate.patchId,
            promotionId,
            promotedBy,
            files: [] as any[]
        };

        // 3. Backup Originals & Promote
        try {
            for (const relPath of candidate.filesModified.concat(candidate.filesCreated)) {
                const livePath = path.resolve(this.rootDir, relPath);
                const stagedPath = path.join(candidate.stagingPath, relPath);
                const archivePath = path.join(archiveDir, relPath);

                // Ensure archive subdirs exist
                fs.mkdirSync(path.dirname(archivePath), { recursive: true });

                // Backup live file if it exists
                if (fs.existsSync(livePath)) {
                    fs.copyFileSync(livePath, archivePath);
                    filesArchived.push(relPath);
                }

                // Ensure live subdirs exist
                fs.mkdirSync(path.dirname(livePath), { recursive: true });

                // Copy staged file to live
                fs.copyFileSync(stagedPath, livePath);
                filesPromoted.push(relPath);

                manifest.files.push({
                    livePath: relPath,
                    stagedPath: stagedPath,
                    archivePath: fs.existsSync(livePath) ? relPath : null
                });
            }

            // Write archive manifest
            const manifestPath = path.join(this.directories.manifestsDir, `${promotionId}_manifest.json`);
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

            const record: PromotionRecord = {
                promotionId,
                patchId: candidate.patchId,
                promotedAt: timestamp,
                archiveManifestPath: manifestPath,
                filesPromoted,
                filesArchived,
                filesRejected,
                promotedBy,
                reason: 'Validation passed successfully.',
                rollbackPointer: manifestPath,
                outcome: 'success'
            };

            // TODO: Append generalized audit record to audit-log.jsonl

            return record;
        } catch (error: any) {
            console.error('[PromotionService] Promotion failed during filesystem operation:', error);
            // In a real system, invoke RollbackService here to undo partial writes using the constructed manifest.
            throw new Error(`Promotion failed during deployment: ${error.message}`);
        }
    }
}

export class RollbackService {
    private rootDir: string;
    private directories: ReflectionDataDirectories;

    constructor(rootDir: string, directories: ReflectionDataDirectories) {
        this.rootDir = rootDir;
        this.directories = directories;
    }

    /**
     * PHASE 7: ROLLBACK
     * Restores files using a promotion manifest.
     */
    public async rollbackPromotion(manifestPath: string): Promise<RollbackRecord> {
        console.log(`[RollbackService] Initiating rollback using manifest: ${manifestPath}`);

        if (!fs.existsSync(manifestPath)) {
            throw new Error(`Manifest not found: ${manifestPath}`);
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const rollbackId = `rb_${Date.now()}`;
        const archiveDir = path.join(this.directories.prePatchDir, manifest.timestamp.replace(/:/g, '-').replace(/\./g, '-'));

        const restoredFiles: string[] = [];

        try {
            for (const fileDef of manifest.files) {
                const livePath = path.resolve(this.rootDir, fileDef.livePath);

                if (fileDef.archivePath) {
                    const archiveFile = path.join(archiveDir, fileDef.archivePath);
                    if (fs.existsSync(archiveFile)) {
                        fs.copyFileSync(archiveFile, livePath);
                        restoredFiles.push(fileDef.livePath);
                    }
                } else {
                    // File was originally created during promotion, so to roll back, delete it.
                    if (fs.existsSync(livePath)) {
                        fs.unlinkSync(livePath);
                        restoredFiles.push(`deleted(created): ${fileDef.livePath}`);
                    }
                }
            }

            return {
                rollbackId,
                promotionId: manifest.promotionId,
                executedAt: new Date().toISOString(),
                restoredFiles,
                archiveSource: archiveDir,
                reason: 'Manual or automated rollback request',
                outcome: 'success'
            };
        } catch (error: any) {
            console.error('[RollbackService] Rollback failed:', error);
            return {
                rollbackId,
                promotionId: manifest.promotionId,
                executedAt: new Date().toISOString(),
                restoredFiles,
                archiveSource: archiveDir,
                reason: `Failed: ${error.message}`,
                outcome: 'failure'
            };
        }
    }
}
