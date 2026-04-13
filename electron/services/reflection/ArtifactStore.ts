import fs from 'fs';
import path from 'path';
import { ReflectionEvent, ChangeProposal, OutcomeRecord } from './types';
import { appStorageRootPath, validatePathWithinAppRoot } from '../PathResolver';
import { AutoFixOutcome, AutoFixProposal, AutoFixProposalStatus } from './AutoFixTypes';

/**
 * Handles persistent storage of reflection artifacts in the local filesystem.
 * Adheres to local-first and auditability policies.
 */
export class ArtifactStore {
    private baseDir: string;

    constructor(rootPath: string) {
        const dataRoot = path.basename(rootPath) === 'data'
            ? rootPath
            : path.join(rootPath, 'data');
        this.baseDir = path.join(dataRoot, 'reflection', 'artifacts');
        if (!validatePathWithinAppRoot(this.baseDir) && !path.resolve(this.baseDir).toLowerCase().startsWith(path.resolve(appStorageRootPath).toLowerCase())) {
            console.warn(`[PathGuard] write escaped app root path=${this.baseDir}`);
        }
        this.ensureDirectories();
    }

    private ensureDirectories() {
        const dirs = [
            'reflections',
            'proposals',
            'outcomes',
            'backups/reflection_changes',
            'auto_fix/proposals',
            'auto_fix/outcomes',
            'auto_fix/patch_plans',
        ];
        dirs.forEach(d => {
            const fullPath = path.join(this.baseDir, d);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        });
    }

    async saveReflection(event: ReflectionEvent): Promise<void> {
        const filePath = path.join(this.baseDir, 'reflections', `${event.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(event, null, 2));
        this.updateIndex('reflections', event.id, event.timestamp);
    }

    async saveProposal(proposal: ChangeProposal): Promise<void> {
        const filePath = path.join(this.baseDir, 'proposals', `${proposal.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2));
        this.updateIndex('proposals', proposal.id, new Date().toISOString());
    }

    async saveOutcome(outcome: OutcomeRecord): Promise<void> {
        const filePath = path.join(this.baseDir, 'outcomes', `${outcome.proposalId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(outcome, null, 2));
    }

    async saveAutoFixProposal(proposal: AutoFixProposal): Promise<void> {
        const filePath = path.join(this.baseDir, 'auto_fix', 'proposals', `${proposal.proposalId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2));
    }

    async updateAutoFixProposal(proposal: AutoFixProposal): Promise<void> {
        await this.saveAutoFixProposal({
            ...proposal,
            updatedAt: proposal.updatedAt || new Date().toISOString(),
        });
    }

    async updateAutoFixProposalStatus(proposalId: string, status: AutoFixProposalStatus): Promise<AutoFixProposal | null> {
        const existing = await this.getAutoFixProposal(proposalId);
        if (!existing) return null;
        const updated: AutoFixProposal = { ...existing, status, updatedAt: new Date().toISOString() };
        await this.saveAutoFixProposal(updated);
        return updated;
    }

    async getAutoFixProposal(proposalId: string): Promise<AutoFixProposal | null> {
        const filePath = path.join(this.baseDir, 'auto_fix', 'proposals', `${proposalId}.json`);
        if (!fs.existsSync(filePath)) return null;
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as AutoFixProposal;
        } catch (err) {
            console.error(`[ArtifactStore] Failed to load auto-fix proposal ${proposalId}:`, err);
            return null;
        }
    }

    async listAutoFixProposals(): Promise<AutoFixProposal[]> {
        const dir = path.join(this.baseDir, 'auto_fix', 'proposals');
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const proposals: AutoFixProposal[] = [];
        for (const file of files) {
            try {
                const proposal = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as AutoFixProposal;
                proposals.push({
                    duplicateCount: 0,
                    observationCount: proposal.observationCount ?? proposal.duplicateCount ?? 1,
                    ...proposal,
                });
            } catch (err) {
                console.error(`[ArtifactStore] Failed to parse auto-fix proposal ${file}:`, err);
            }
        }
        return proposals.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    async findLatestAutoFixProposalByDedupeKey(dedupeKey: string): Promise<AutoFixProposal | null> {
        if (!dedupeKey) return null;
        const proposals = await this.listAutoFixProposals();
        const match = proposals.find(p => p.dedupeKey === dedupeKey);
        return match ?? null;
    }

    async saveAutoFixOutcome(outcome: AutoFixOutcome): Promise<void> {
        const filePath = path.join(this.baseDir, 'auto_fix', 'outcomes', `${outcome.proposalId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(outcome, null, 2));
    }

    async listAutoFixOutcomes(): Promise<AutoFixOutcome[]> {
        const dir = path.join(this.baseDir, 'auto_fix', 'outcomes');
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const outcomes: AutoFixOutcome[] = [];
        for (const file of files) {
            try {
                outcomes.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as AutoFixOutcome);
            } catch (err) {
                console.error(`[ArtifactStore] Failed to parse auto-fix outcome ${file}:`, err);
            }
        }
        return outcomes.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    async savePatchPlanArtifact(proposalId: string, payload: unknown): Promise<string> {
        const filePath = path.join(this.baseDir, 'auto_fix', 'patch_plans', `${proposalId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
        return filePath;
    }

    async getProposals(status?: string): Promise<ChangeProposal[]> {
        const dir = path.join(this.baseDir, 'proposals');
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const results: ChangeProposal[] = [];
        for (const f of files) {
            try {
                const content = fs.readFileSync(path.join(dir, f), 'utf-8');
                results.push(JSON.parse(content) as ChangeProposal);
            } catch (err) {
                console.error(`[ArtifactStore] Failed to load proposal ${f}:`, err);
            }
        }
        return results.filter(p => !status || p.status === status);
    }

    async getReflections(): Promise<ReflectionEvent[]> {
        const dir = path.join(this.baseDir, 'reflections');
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const results: ReflectionEvent[] = [];
        for (const f of files) {
            try {
                const content = fs.readFileSync(path.join(dir, f), 'utf-8');
                results.push(JSON.parse(content) as ReflectionEvent);
            } catch (err) {
                console.error(`[ArtifactStore] Failed to load reflection ${f}:`, err);
            }
        }
        return results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    private updateIndex(type: string, id: string, timestamp: string) {
        const indexPath = path.join(this.baseDir, 'reflection_index.json');
        let index: any = { reflections: [], proposals: [] };
        if (fs.existsSync(indexPath)) {
            index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        }
        index[type].push({ id, timestamp });
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    }

    /**
     * Purges records older than the retention limit.
     */
    async purgeOldRecords(retentionDays: number): Promise<void> {
        const limit = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
        console.log(`[ArtifactStore] Purging records older than ${retentionDays} days...`);

        const dirs = ['reflections', 'proposals', 'outcomes'];
        let totalPurged = 0;

        for (const subDir of dirs) {
            const dir = path.join(this.baseDir, subDir);
            if (!fs.existsSync(dir)) continue;

            const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const filePath = path.join(dir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.mtimeMs < limit) {
                        fs.unlinkSync(filePath);
                        totalPurged++;
                    }
                } catch (e) {
                    console.error(`[ArtifactStore] Failed to purge ${filePath}:`, e);
                }
            }
        }

        // Rebuild index after purge
        if (totalPurged > 0) {
            this.rebuildIndex();
        }

        console.log(`[ArtifactStore] Purged ${totalPurged} records.`);
    }

    /** Rebuilds the reflection index from disk files. */
    private rebuildIndex() {
        const indexPath = path.join(this.baseDir, 'reflection_index.json');
        const index: any = { reflections: [], proposals: [] };

        for (const type of ['reflections', 'proposals'] as const) {
            const dir = path.join(this.baseDir, type);
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                    index[type].push({ id: data.id, timestamp: data.timestamp || new Date().toISOString() });
                } catch { }
            }
        }

        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    }

    /** Returns count of reflection event files on disk. */
    getReflectionCount(): number {
        try {
            return fs.readdirSync(path.join(this.baseDir, 'reflections')).filter(f => f.endsWith('.json')).length;
        } catch { return 0; }
    }

    /** Returns count of proposal files on disk. */
    getProposalCount(): number {
        try {
            return fs.readdirSync(path.join(this.baseDir, 'proposals')).filter(f => f.endsWith('.json')).length;
        } catch { return 0; }
    }

    /** Returns all outcome records from disk. */
    getOutcomes(): OutcomeRecord[] {
        try {
            const dir = path.join(this.baseDir, 'outcomes');
            return fs.readdirSync(dir)
                .filter(f => f.endsWith('.json'))
                .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as OutcomeRecord);
        } catch { return []; }
    }

    /**
     * Deletes proposal files based on their status.
     * @returns Number of files deleted.
     */
    async deleteProposalsByStatus(status: 'applied' | 'rejected' | 'failed'): Promise<number> {
        const dir = path.join(this.baseDir, 'proposals');
        if (!fs.existsSync(dir)) return 0;

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        let deletedCount = 0;

        for (const file of files) {
            const filePath = path.join(dir, file);
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const proposal = JSON.parse(content) as ChangeProposal;
                if (proposal.status === status) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            } catch (err) {
                console.error(`[ArtifactStore] Failed to process proposal ${file} during cleanup:`, err);
            }
        }

        if (deletedCount > 0) {
            this.rebuildIndex();
        }

        return deletedCount;
    }
}


