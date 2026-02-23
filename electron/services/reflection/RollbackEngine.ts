import fs from 'fs';
import path from 'path';
import { OutcomeRecord } from './types';

/**
 * Restores the system to a previous state if an update fails or is rejected.
 * Uses the timestamped backups created by ApplyEngine.
 */
export class RollbackEngine {
    private backupDir: string;

    constructor(userDataDir: string) {
        this.backupDir = path.join(userDataDir, 'memory', 'backups', 'reflection_changes');
    }

    /**
     * Performs a rollback for a specific outcome.
     * Scans the backup directory for files matching the proposal ID
     * and restores them to their original locations.
     */
    async performRollback(outcome: OutcomeRecord): Promise<boolean> {
        console.log(`[RollbackEngine] Reverting changes for proposal: ${outcome.proposalId}`);

        if (!fs.existsSync(this.backupDir)) {
            console.warn(`[RollbackEngine] No backup directory found at ${this.backupDir}`);
            return false;
        }

        // Find backup files for this proposal (format: proposalId_timestamp_filename.bak)
        const backupFiles = fs.readdirSync(this.backupDir)
            .filter(f => f.startsWith(outcome.proposalId));

        if (backupFiles.length === 0) {
            console.warn(`[RollbackEngine] No backup files found for proposal ${outcome.proposalId}`);
            return false;
        }

        let restored = 0;
        for (const backupFile of backupFiles) {
            try {
                const backupPath = path.join(this.backupDir, backupFile);
                const metadata = this.parseBackupMetadata(backupPath);

                if (metadata && metadata.originalPath) {
                    const content = fs.readFileSync(backupPath, 'utf-8');
                    fs.writeFileSync(metadata.originalPath, content, 'utf-8');
                    console.log(`[RollbackEngine] ✅ Restored: ${metadata.originalPath}`);
                    restored++;
                }
            } catch (e) {
                console.error(`[RollbackEngine] Failed to restore ${backupFile}:`, e);
            }
        }

        console.log(`[RollbackEngine] Restored ${restored}/${backupFiles.length} files for proposal ${outcome.proposalId}`);
        return restored > 0;
    }

    /**
     * Reads the backup file's embedded metadata comment (first line)
     * to determine the original path.
     */
    private parseBackupMetadata(backupPath: string): { originalPath: string } | null {
        try {
            const content = fs.readFileSync(backupPath, 'utf-8');
            // ApplyEngine writes backups with a metadata header:
            // // BACKUP_ORIGINAL_PATH: <path>
            const match = content.match(/^\/\/ BACKUP_ORIGINAL_PATH: (.+)$/m);
            if (match) {
                return { originalPath: match[1].trim() };
            }

            // Fallback: Try to extract from filename
            // Format: proposalId_timestamp_encodedPath.bak
            const parts = path.basename(backupPath, '.bak').split('_');
            if (parts.length >= 3) {
                const encodedPath = parts.slice(2).join('_');
                const originalPath = encodedPath.replace(/--/g, path.sep);
                if (fs.existsSync(path.dirname(originalPath))) {
                    return { originalPath };
                }
            }

            return null;
        } catch {
            return null;
        }
    }
}
