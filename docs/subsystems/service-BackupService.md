# Service: BackupService.ts

**Source**: [electron\services\BackupService.ts](../../electron/services/BackupService.ts)

## Class: `BackupService`

## Overview
Automated Workspace Disaster Recovery Service.  The `BackupService` provides scheduled, compressed snapshots of the entire  Tala workspace. It supports a hybrid-cloud strategy where backups are  created locally and optionally mirrored to S3-compatible storage.  **Core Responsibilities:** - **Local Archiving**: Generates `.zip` files using Tier 9 compression. - **Cloud Sync**: Uploads archives to AWS S3, MinIO, GCS, or R2 providers. - **Scheduling**: Manages recurring background jobs with configurable intervals. - **Connectivity Testing**: Validates cloud credentials and bucket permissions. - **Atomicity**: Ensures local zipping completes before starting cloud uploads.

### Methods

#### `init`
Initializes the backup service and starts the schedule./

**Arguments**: ``

---
#### `getConfig`
Reads the backup configuration from `app_settings.json`./

**Arguments**: ``
**Returns**: `BackupConfig | null`

---
#### `schedule`
Initializes or resets the background backup scheduler.  Reads `intervalHours` from settings and establishes a `setInterval`  timer. Minimum frequency is forced to 1 hour to prevent system resource  exhaustion during rapid settings changes./

**Arguments**: ``

---
#### `getS3Client`
Helper to create an S3 Client from config/

**Arguments**: `config: BackupConfig`
**Returns**: `S3Client | null`

---
#### `testConnection`
Tests the connection to the configured Cloud Provider./

**Arguments**: `configOverride?: BackupConfig`
**Returns**: `Promise<`

---
#### `uploadToCloud`
Uploads the generated zip file to the cloud provider./

**Arguments**: `zipPath: string, config: BackupConfig`
**Returns**: `Promise<void>`

---
#### `performBackup`
Executes an immediate, full-workspace backup workflow.  **Execution Flow:** 1. **Discovery**: Identifies the source workspace directory and output path. 2. **Local Zip**: Synchronously aggregates workspace files into a timestamped     ZIP archive with maximum compression. 3. **Cloud Mirroring**: If a remote provider is configured, streams the     local ZIP to the target bucket. 4. **Cleanup**: Retains the local ZIP as a primary fallback (staging area).  @returns Success status and the local filesystem path to the archive./

**Arguments**: ``
**Returns**: `Promise<`

---
