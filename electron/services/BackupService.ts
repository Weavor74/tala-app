
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { resolveAppPath, resolveStoragePath } from './PathResolver';

// Local definition to avoid importing React-dependent settingsData.ts in Main process
interface BackupConfig {
    enabled: boolean;
    intervalHours: number;
    provider: 'local' | 's3' | 'compat' | 'gcs';
    localPath: string;
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
}

/**
 * Automated Workspace Disaster Recovery Service.
 * 
 * The `BackupService` provides scheduled, compressed snapshots of the entire 
 * Tala workspace. It supports a hybrid-cloud strategy where backups are 
 * created locally and optionally mirrored to S3-compatible storage.
 * 
 * **Core Responsibilities:**
 * - **Local Archiving**: Generates `.zip` files using Tier 9 compression.
 * - **Cloud Sync**: Uploads archives to AWS S3, MinIO, GCS, or R2 providers.
 * - **Scheduling**: Manages recurring background jobs with configurable intervals.
 * - **Connectivity Testing**: Validates cloud credentials and bucket permissions.
 * - **Atomicity**: Ensures local zipping completes before starting cloud uploads.
 */
export class BackupService {
    /** The currently active interval timer handle, or null if no backup schedule is active. */
    private interval: NodeJS.Timeout | null = null;

    /**
     * Initializes the backup service and starts the schedule.
     */
    public init() {
        this.schedule();
    }

    /**
     * Reads the backup configuration from `app_settings.json`.
     */
    private getConfig(): BackupConfig | null {
        const settingsPath = resolveStoragePath('app_settings.json');
        if (fs.existsSync(settingsPath)) {
            try {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
                return settings.backup as BackupConfig;
            } catch (error) {
                console.error('[BackupService] Failed to parse app_settings.json', error);
                return null;
            }
        }
        return null;
    }

    private getWorkspaceSourceDir(): string {
        const settingsPath = resolveStoragePath('app_settings.json');
        try {
            if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { storage?: { localPath?: string } };
                const configuredWorkspace = settings?.storage?.localPath;
                if (configuredWorkspace && typeof configuredWorkspace === 'string') {
                    return resolveAppPath('', configuredWorkspace, {
                        externalByConfiguration: true,
                        label: 'workspace-root',
                    });
                }
            }
        } catch (error) {
            console.warn('[BackupService] Failed to resolve workspace from settings, using default workspace.', error);
        }

        return (process.env.VITE_DEV_SERVER_URL || !app.isPackaged)
            ? resolveAppPath('')
            : resolveStoragePath('workspace');
    }

    private resolveBackupOutputDir(config: BackupConfig): string {
        if (!config.localPath) {
            return resolveAppPath(path.join('exports', 'backups'));
        }

        return resolveAppPath('', config.localPath, {
            externalByConfiguration: true,
            label: 'backup-local-path',
        });
    }

    /**
     * Initializes or resets the background backup scheduler.
     * 
     * Reads `intervalHours` from settings and establishes a `setInterval` 
     * timer. Minimum frequency is forced to 1 hour to prevent system resource 
     * exhaustion during rapid settings changes.
     */
    public schedule() {
        if (this.interval) clearInterval(this.interval);

        const config = this.getConfig();
        if (!config || !config.enabled) return;

        console.log(`[BackupService] Scheduled backup every ${config.intervalHours} hours.`);
        // Ensure minimum interval of 1 hour to prevent flooding
        const ms = Math.max(1, config.intervalHours) * 60 * 60 * 1000;

        this.interval = setInterval(() => {
            this.performBackup();
        }, ms);
    }

    /**
     * Helper to create an S3 Client from config
     */
    private getS3Client(config: BackupConfig): S3Client | null {
        if (!config.accessKeyId || !config.secretAccessKey) return null;

        const s3Config: any = {
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey
            },
            region: config.region || 'us-east-1',
            forcePathStyle: true // Needed for MinIO and some others
        };

        if (config.endpoint) {
            s3Config.endpoint = config.endpoint;
        }

        return new S3Client(s3Config);
    }

    /**
     * Tests the connection to the configured Cloud Provider.
     */
    public async testConnection(configOverride?: BackupConfig): Promise<{ success: boolean; error?: string }> {
        const config = configOverride || this.getConfig();
        if (!config) return { success: false, error: 'No configuration found.' };
        if (config.provider === 'local') return { success: true };

        try {
            const client = this.getS3Client(config);
            if (!client) return { success: false, error: 'Missing Credentials (Access Key / Secret Key).' };

            const command = new ListBucketsCommand({});
            await client.send(command);

            return { success: true };
        } catch (error: any) {
            console.error('[BackupService] Connection Test Failed:', error);
            return { success: false, error: error.message || 'Connection failed' };
        }
    }

    /**
     * Uploads the generated zip file to the cloud provider.
     */
    private async uploadToCloud(zipPath: string, config: BackupConfig): Promise<void> {
        const client = this.getS3Client(config);
        if (!client) throw new Error('Invalid Cloud Credentials');
        if (!config.bucket) throw new Error('No Bucket Configured');

        const fileStream = fs.createReadStream(zipPath);
        const fileName = path.basename(zipPath);

        // Use 'backup/' prefix or root
        const key = `tala-backups/${fileName}`;

        console.log(`[BackupService] Uploading ${fileName} to ${config.bucket}/${key}...`);

        const upload = new Upload({
            client,
            params: {
                Bucket: config.bucket,
                Key: key,
                Body: fileStream
            }
        });

        upload.on('httpUploadProgress', (progress) => {
            console.log(`[BackupService] Upload Progress: ${progress.loaded}/${progress.total}`);
        });

        await upload.done();
        console.log('[BackupService] Upload Complete.');
    }

    /**
     * Executes an immediate, full-workspace backup workflow.
     * 
     * **Execution Flow:**
     * 1. **Discovery**: Identifies the source workspace directory and output path.
     * 2. **Local Zip**: Synchronously aggregates workspace files into a timestamped 
     *    ZIP archive with maximum compression.
     * 3. **Cloud Mirroring**: If a remote provider is configured, streams the 
     *    local ZIP to the target bucket.
     * 4. **Cleanup**: Retains the local ZIP as a primary fallback (staging area).
     * 
     * @returns Success status and the local filesystem path to the archive.
     */
    public async performBackup(): Promise<{ success: boolean; path?: string; error?: string }> {
        const config = this.getConfig();
        if (!config) return { success: false, error: 'Backup disabled or unconfigured.' };

        console.log('[BackupService] Starting backup...');

        const sourceDir = this.getWorkspaceSourceDir();
        if (!fs.existsSync(sourceDir)) {
            return { success: false, error: `Workspace source does not exist: ${sourceDir}` };
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const zipName = `tala_backup_${timestamp}.zip`;

        // Determine Local Output Path
        // We always create a local zip first, then optionally upload it.
        const backupDir = this.resolveBackupOutputDir(config);

        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const zipPath = path.join(backupDir, zipName);

        try {
            await new Promise<void>((resolve, reject) => {
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } });

                output.on('close', () => resolve());
                archive.on('error', (err) => reject(err));

                archive.pipe(output);
                archive.directory(sourceDir, false);
                archive.finalize();
            });

            console.log(`[BackupService] Local backup created at ${zipPath}`);

            // Upload if Cloud is enabled
            if (config.provider !== 'local') {
                await this.uploadToCloud(zipPath, config);
                // Optionally delete local file if we want "Cloud Only"? 
                // Settings says "Local (Fallback)", suggesting we keep it? 
                // Or maybe we treat the local path as a staging area.
                // For now, keep it. Safe.
            }

            return { success: true, path: zipPath };

        } catch (error: any) {
            console.error('[BackupService] Backup failed:', error);
            return { success: false, error: error.message };
        }
    }
}

