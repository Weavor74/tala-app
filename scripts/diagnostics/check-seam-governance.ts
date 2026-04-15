#!/usr/bin/env tsx
/// <reference types="node" />

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
    SEAM_CONTRACTS,
    SEAM_CONTRACT_DOC_PATHS,
    seamContractMetadataPath,
    type CriticalSeamId,
} from '../../shared/governance/SeamContracts';
import { buildSeamStabilityReport } from '../../shared/governance/SeamStability';

const ROOT = path.resolve(__dirname, '../..');

type GovernanceStatus =
    | 'PASS'
    | 'PASS_WITH_JUSTIFICATION'
    | 'FAIL_MISSING_CONTRACT_UPDATE'
    | 'FAIL_UNJUSTIFIED_PROTECTED_SEAM_CHANGE';

interface ParsedArgs {
    changedFiles: string[];
    changedFilesFile?: string;
    baseRef?: string;
    justification?: string;
    json: boolean;
}

interface GovernanceFinding {
    code:
        | 'protected_seam_touched'
        | 'contract_metadata_updated'
        | 'contract_docs_updated'
        | 'justification_used'
        | 'justification_empty'
        | 'missing_contract_update'
        | 'unjustified_protected_change';
    seamId?: CriticalSeamId;
    file?: string;
    message: string;
}

interface SeamGovernanceResult {
    status: GovernanceStatus;
    summary: string;
    findings: GovernanceFinding[];
    metadata: {
        changedFilesEvaluated: string[];
        protectedFilesTouched: string[];
        touchedSeamIds: CriticalSeamId[];
        contractMetadataUpdated: boolean;
        contractDocsUpdated: string[];
        justificationProvided: boolean;
    };
    stability: ReturnType<typeof buildSeamStabilityReport>;
}

function parseArgs(argv: string[]): ParsedArgs {
    const changedFiles: string[] = [];
    let changedFilesFile: string | undefined;
    let baseRef: string | undefined;
    let justification: string | undefined;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json') continue;
        if (arg.startsWith('--changed-file=')) {
            const value = arg.slice('--changed-file='.length).trim();
            if (value) changedFiles.push(value);
            continue;
        }
        if (arg.startsWith('--changed-files-file=')) {
            const value = arg.slice('--changed-files-file='.length).trim();
            if (value) changedFilesFile = value;
            continue;
        }
        if (arg.startsWith('--base-ref=')) {
            const value = arg.slice('--base-ref='.length).trim();
            if (value) baseRef = value;
            continue;
        }
        if (arg.startsWith('--justification=')) {
            const value = arg.slice('--justification='.length).trim();
            justification = value;
            continue;
        }
        if (arg === '--changed-file') {
            const value = argv[i + 1];
            if (value) {
                changedFiles.push(value);
                i += 1;
            }
            continue;
        }
        if (arg === '--changed-files-file') {
            const value = argv[i + 1];
            if (value) {
                changedFilesFile = value;
                i += 1;
            }
            continue;
        }
        if (arg === '--base-ref') {
            const value = argv[i + 1];
            if (value) {
                baseRef = value;
                i += 1;
            }
            continue;
        }
        if (arg === '--justification') {
            const value = argv[i + 1];
            if (value) {
                justification = value.trim();
                i += 1;
            }
            continue;
        }
        if (!arg.startsWith('--')) {
            changedFiles.push(arg);
        }
    }

    return {
        changedFiles,
        changedFilesFile,
        baseRef,
        justification,
        json: argv.includes('--json'),
    };
}

function toPosix(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function parseFileList(raw: string): string[] {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(toPosix);
}

function runGit(args: string[]): string {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function resolveChangedFiles(parsedArgs: ParsedArgs): string[] {
    const files = new Set<string>();
    for (const file of parsedArgs.changedFiles) {
        if (file.trim()) files.add(toPosix(file.trim()));
    }

    if (parsedArgs.changedFilesFile) {
        const absolute = path.resolve(parsedArgs.changedFilesFile);
        if (fs.existsSync(absolute)) {
            const raw = fs.readFileSync(absolute, 'utf8');
            for (const file of parseFileList(raw)) files.add(file);
        }
    }

    if (files.size > 0) return Array.from(files).sort();

    const envBaseRef = process.env.GITHUB_BASE_REF?.trim();
    const baseRef = parsedArgs.baseRef ?? (envBaseRef ? `origin/${envBaseRef}` : undefined);

    if (baseRef) {
        try {
            const diff = runGit(['diff', '--name-only', `${baseRef}...HEAD`]);
            for (const file of parseFileList(diff)) files.add(file);
        } catch {
            // continue to fallbacks
        }
    }

    if (files.size === 0) {
        try {
            const diff = runGit(['diff', '--name-only', 'HEAD~1..HEAD']);
            for (const file of parseFileList(diff)) files.add(file);
        } catch {
            // continue to fallbacks
        }
    }

    if (files.size === 0) {
        try {
            const status = runGit(['status', '--porcelain']);
            for (const line of parseFileList(status)) {
                const trimmed = line.trim();
                const file = trimmed.length > 3 ? trimmed.slice(3).trim() : '';
                if (file) files.add(toPosix(file));
            }
        } catch {
            // leave empty set
        }
    }

    return Array.from(files).sort();
}

function evaluateSeamGovernance(changedFiles: string[], parsedArgs: ParsedArgs): SeamGovernanceResult {
    const findings: GovernanceFinding[] = [];
    const touchedSeamIds = new Set<CriticalSeamId>();
    const protectedFilesTouched: string[] = [];
    const touchedFileSet = new Set(changedFiles);

    for (const seam of SEAM_CONTRACTS) {
        const matchers = seam.protectedPathPatterns.map((pattern) => new RegExp(pattern));
        for (const file of changedFiles) {
            if (!matchers.some((rx) => rx.test(file))) continue;
            touchedSeamIds.add(seam.id);
            protectedFilesTouched.push(file);
            findings.push({
                code: 'protected_seam_touched',
                seamId: seam.id,
                file,
                message: `Protected seam "${seam.id}" touched by file "${file}".`,
            });
        }
    }

    const contractMetadataUpdated = touchedFileSet.has(seamContractMetadataPath);
    if (contractMetadataUpdated) {
        findings.push({
            code: 'contract_metadata_updated',
            file: seamContractMetadataPath,
            message: 'Seam contract metadata updated.',
        });
    }

    const updatedContractDocs = SEAM_CONTRACT_DOC_PATHS.filter((docPath) => touchedFileSet.has(docPath));
    for (const docPath of updatedContractDocs) {
        findings.push({
            code: 'contract_docs_updated',
            file: docPath,
            message: `Seam contract documentation updated: ${docPath}.`,
        });
    }

    const justificationRaw = parsedArgs.justification?.trim() ?? '';
    const justificationProvided = justificationRaw.length > 0;
    if (justificationProvided) {
        findings.push({
            code: 'justification_used',
            message: 'Explicit seam-change justification provided.',
        });
    }

    let status: GovernanceStatus = 'PASS';
    let summary = 'No protected seam changes detected.';

    const protectedChangeDetected = touchedSeamIds.size > 0;
    const contractUpdateDetected = contractMetadataUpdated || updatedContractDocs.length > 0;

    if (protectedChangeDetected && contractUpdateDetected) {
        status = 'PASS';
        summary = 'Protected seam changes include contract metadata/docs updates.';
    } else if (protectedChangeDetected && !contractUpdateDetected && justificationProvided) {
        status = 'PASS_WITH_JUSTIFICATION';
        summary = 'Protected seam changes accepted with explicit justification.';
    } else if (protectedChangeDetected && !contractUpdateDetected && parsedArgs.justification !== undefined && !justificationProvided) {
        status = 'FAIL_MISSING_CONTRACT_UPDATE';
        summary = 'Protected seam change provided empty justification and no contract updates.';
        findings.push({
            code: 'justification_empty',
            message: 'Justification flag provided but empty.',
        });
        findings.push({
            code: 'missing_contract_update',
            message: 'Update seam contract metadata/docs or provide non-empty explicit justification.',
        });
    } else if (protectedChangeDetected && !contractUpdateDetected) {
        status = 'FAIL_UNJUSTIFIED_PROTECTED_SEAM_CHANGE';
        summary = 'Protected seam changes require contract metadata/docs update or explicit justification.';
        findings.push({
            code: 'unjustified_protected_change',
            message: 'No contract update or explicit justification for protected seam changes.',
        });
    }

    const stability = buildSeamStabilityReport({
        seams: SEAM_CONTRACTS,
        touchedSeamIds,
        contractUpdatePresent: contractUpdateDetected,
        justificationUsed: status === 'PASS_WITH_JUSTIFICATION',
        governanceFailed: status.startsWith('FAIL_'),
    });

    return {
        status,
        summary,
        findings,
        metadata: {
            changedFilesEvaluated: changedFiles,
            protectedFilesTouched: Array.from(new Set(protectedFilesTouched)).sort(),
            touchedSeamIds: Array.from(touchedSeamIds).sort(),
            contractMetadataUpdated,
            contractDocsUpdated: updatedContractDocs.sort(),
            justificationProvided,
        },
        stability,
    };
}

function printHumanReadable(result: SeamGovernanceResult): void {
    console.log(`[SEAM_GOVERNANCE] status=${result.status}`);
    console.log(`[SEAM_GOVERNANCE] ${result.summary}`);
    console.log('');
    console.log('Touched seams:');
    if (result.metadata.touchedSeamIds.length === 0) {
        console.log('  - none');
    } else {
        for (const seamId of result.metadata.touchedSeamIds) {
            console.log(`  - ${seamId}`);
        }
    }
    console.log('');
    console.log('Stability classification:');
    for (const seam of result.stability.statuses) {
        console.log(`  - ${seam.seamId}: ${seam.stabilityClassification} [${seam.reasonCodes.join(',')}]`);
    }
    if (result.findings.length > 0) {
        console.log('');
        console.log('Findings:');
        for (const finding of result.findings) {
            const seamPart = finding.seamId ? ` seam=${finding.seamId}` : '';
            const filePart = finding.file ? ` file=${finding.file}` : '';
            console.log(`  - code=${finding.code}${seamPart}${filePart} message="${finding.message}"`);
        }
    }
}

function main(): void {
    const parsedArgs = parseArgs(process.argv.slice(2));
    const changedFiles = resolveChangedFiles(parsedArgs);
    const result = evaluateSeamGovernance(changedFiles, parsedArgs);

    if (parsedArgs.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        printHumanReadable(result);
    }

    if (result.status.startsWith('FAIL_')) {
        process.exit(1);
    }
}

main();
