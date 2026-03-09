import * as fs from 'fs';
import * as path from 'path';
import { CandidatePatch, ReflectionIssue } from './reflectionEcosystemTypes';
import { ReflectionDataDirectories } from './DataDirectoryPaths';
import { ProtectedFileRegistry } from './ProtectedFileRegistry';

export class PatchStagingService {
    private directories: ReflectionDataDirectories;
    private protectedRegistry: ProtectedFileRegistry;

    constructor(directories: ReflectionDataDirectories, protectedRegistry: ProtectedFileRegistry) {
        this.directories = directories;
        this.protectedRegistry = protectedRegistry;
    }

    /**
     * PHASE 3: PATCH
     * Creates a staged patch folder and synthesizes candidate files based on a specific hypothesis.
     * This service NEVER directly overwrites live files.
     */
    public async createCandidatePatch(issue: ReflectionIssue, generatedFiles: { relativePath: string, content: string }[]): Promise<CandidatePatch> {
        console.log(`[PatchStagingService] Creating candidate patch for issue ${issue.issueId}...`);

        const patchId = `patch_${Date.now()}`;
        const stagingPath = path.join(this.directories.stagedDir, patchId);

        fs.mkdirSync(stagingPath, { recursive: true });

        const filesCreated: string[] = [];
        const filesModified: string[] = [];
        const filesProtectedTouched: string[] = [];

        // Write candidate files into the staging folder
        // The structure inside staging matches the target struct relative to repo root
        for (const file of generatedFiles) {
            const destPath = path.join(stagingPath, file.relativePath);

            // Ensure necessary subdirectories exist in staging
            fs.mkdirSync(path.dirname(destPath), { recursive: true });

            // Write the staged file
            fs.writeFileSync(destPath, file.content, 'utf8');

            const protectedRule = this.protectedRegistry.getFileProtection(file.relativePath);
            if (protectedRule) {
                if (!protectedRule.allowStagedEdit) {
                    throw new Error(`File ${file.relativePath} is marked as strictly immutable and cannot even be staged. Rule: ${protectedRule.ruleId}`);
                }
                filesProtectedTouched.push(file.relativePath);
            }

            // In a real system, diff against live to determine created vs modified
            // For now assume modified for simulation.
            filesModified.push(file.relativePath);
        }

        // Generate a mock diff artifact (In real env, use git diff or jsdiff)
        const diffPath = path.join(this.directories.diffsDir, `${patchId}.diff`);
        fs.writeFileSync(diffPath, `--- a/live\n+++ b/staged\n+ // Auto-generated diff content for ${patchId}`, 'utf8');

        const candidate: CandidatePatch = {
            patchId,
            createdAt: new Date().toISOString(),
            issueId: issue.issueId,
            title: `Fix for ${issue.title}`,
            summary: `Staged ${generatedFiles.length} file(s) for validation.`,
            filesCreated,
            filesModified,
            filesProtectedTouched,
            stagingPath,
            diffPath,
            author: 'Tala Engineering',
            status: 'staged',
            riskLevel: filesProtectedTouched.length > 0 ? 'high' : 'medium',
            rollbackPlan: 'Requires restoring from archive',
            notes: 'Staged automatically.'
        };

        // Save patch metadata side-by-side
        fs.writeFileSync(
            path.join(stagingPath, 'patch-metadata.json'),
            JSON.stringify(candidate, null, 2),
            'utf8'
        );

        return candidate;
    }
}
