import fs from 'fs';
import path from 'path';
import type { GuardrailProfilePreflightResult } from '../../../shared/guardrails/localGuardrailsProfilePreflightTypes';
import { resolveStoragePath } from '../PathResolver';

interface GuardrailsPreflightSnapshotEnvelope {
    version: 1;
    snapshots: GuardrailProfilePreflightResult[];
}

export interface ILocalGuardrailsPreflightSnapshotStore {
    appendSnapshot(snapshot: GuardrailProfilePreflightResult): void;
}

export class LocalGuardrailsPreflightSnapshotStore implements ILocalGuardrailsPreflightSnapshotStore {
    constructor(
        private readonly _snapshotPath: string = resolveStoragePath(
            path.join('diagnostics', 'guardrails_preflight_snapshots.json'),
        ),
        private readonly _maxSnapshots: number = 100,
    ) {}

    appendSnapshot(snapshot: GuardrailProfilePreflightResult): void {
        try {
            const parent = path.dirname(this._snapshotPath);
            if (!fs.existsSync(parent)) {
                fs.mkdirSync(parent, { recursive: true });
            }

            const current = this._readEnvelope();
            current.snapshots.push(snapshot);
            if (current.snapshots.length > this._maxSnapshots) {
                current.snapshots = current.snapshots.slice(-this._maxSnapshots);
            }
            fs.writeFileSync(this._snapshotPath, JSON.stringify(current, null, 2), 'utf-8');
        } catch {
            // Snapshot persistence is best-effort and must never break preflight execution.
        }
    }

    private _readEnvelope(): GuardrailsPreflightSnapshotEnvelope {
        if (!fs.existsSync(this._snapshotPath)) {
            return { version: 1, snapshots: [] };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this._snapshotPath, 'utf-8'));
            if (parsed?.version === 1 && Array.isArray(parsed?.snapshots)) {
                return parsed as GuardrailsPreflightSnapshotEnvelope;
            }
        } catch {
            // fall through to default
        }
        return { version: 1, snapshots: [] };
    }
}

export const localGuardrailsPreflightSnapshotStore = new LocalGuardrailsPreflightSnapshotStore();

