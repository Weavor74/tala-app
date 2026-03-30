/**
 * HarmonizationDriftDetector.ts — Phase 5.6 P5.6C
 *
 * Deterministic, model-free drift scanner.
 *
 * Responsibilities:
 * - Accept a set of file paths + their string contents and a list of canon rules.
 * - For each rule, evaluate each detection hint against files in scope.
 * - Produce HarmonizationDriftRecord entries only when drift exceeds minDriftSeverity.
 * - Tag records that touch protected subsystems.
 * - Never make model calls.
 * - Never mutate files.
 *
 * Design:
 * - All I/O is caller-supplied (content map), so scanning is synchronous and testable.
 * - Each hint kind has a dedicated sub-check method.
 * - Severity is the weighted average of violated hints across scoped files.
 *
 * Protected subsystem list: planning, governance, execution, safety, preload.
 * Files under electron/services/reflection/, electron/services/governance/,
 * electron/services/execution/ are never flagged for harmonization campaigns.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    HarmonizationCanonRule,
    HarmonizationDriftRecord,
    HarmonizationHintResult,
    HarmonizationDetectionHint,
} from '../../../../shared/harmonizationTypes';
import { telemetry } from '../../TelemetryService';

// ─── Protected subsystem path segments ───────────────────────────────────────

export const PROTECTED_PATH_SEGMENTS: readonly string[] = [
    'electron/services/reflection/',
    'electron/services/governance/',
    'electron/services/execution/',
    'electron/services/safety',
    'electron/preload.ts',        // preload is read-only reference for detection only
];

// ─── HarmonizationDriftDetector ───────────────────────────────────────────────

export class HarmonizationDriftDetector {

    /**
     * Scans a file content map against a set of canon rules.
     *
     * @param rules   Active canon rules to evaluate.
     * @param files   Map of filePath → fileContent. Contents are caller-supplied strings.
     * @returns       Array of DriftRecords for all rules where drift exceeds minDriftSeverity.
     */
    scan(
        rules: HarmonizationCanonRule[],
        files: Map<string, string>,
    ): HarmonizationDriftRecord[] {
        const records: HarmonizationDriftRecord[] = [];
        const filePaths = [...files.keys()];

        for (const rule of rules) {
            if (rule.status !== 'active') continue;

            // Narrow to files that match this rule's scope
            const scopedFiles = filePaths.filter(fp =>
                this._fileInScope(fp, rule.scopePathIncludes),
            );
            if (scopedFiles.length === 0) continue;

            // Evaluate all hints against scoped files
            const allHintResults: HarmonizationHintResult[] = [];
            const affectedFiles = new Set<string>();

            for (const filePath of scopedFiles) {
                const content = files.get(filePath) ?? '';
                for (const hint of rule.detectionHints) {
                    const result = this._evaluateHint(hint, filePath, content);
                    allHintResults.push(result);
                    if (!result.passed) {
                        affectedFiles.add(filePath);
                    }
                }
            }

            // Severity = weighted violation score × file coverage factor
            const severity = this._computeSeverity(
                rule.detectionHints,
                allHintResults,
                scopedFiles.length,
                affectedFiles.size,
            );

            if (severity < rule.minDriftSeverity) continue;

            const affectedFilesArr = [...affectedFiles];
            const subsystems = this._inferSubsystems(affectedFilesArr);
            const touchesProtected = affectedFilesArr.some(f => this._isProtected(f));

            const record: HarmonizationDriftRecord = {
                driftId: `drift-${uuidv4()}`,
                ruleId: rule.ruleId,
                patternClass: rule.patternClass,
                detectedAt: new Date().toISOString(),
                affectedFiles: affectedFilesArr,
                affectedSubsystems: subsystems,
                driftSeverity: Math.round(severity),
                summary: this._buildSummary(rule, affectedFilesArr, severity),
                hintResults: allHintResults,
                touchesProtectedSubsystem: touchesProtected,
            };

            records.push(record);

            telemetry.operational(
                'autonomy',
                'harmonization_drift_detected',
                'info',
                'HarmonizationDriftDetector',
                `Drift detected: rule=${rule.ruleId} severity=${Math.round(severity)} ` +
                `files=${affectedFilesArr.length} protected=${touchesProtected}`,
            );
        }

        return records;
    }

    /**
     * Returns true if the given file path is in a protected subsystem.
     */
    isProtectedFile(filePath: string): boolean {
        return this._isProtected(filePath);
    }

    // ─── Hint evaluators ───────────────────────────────────────────────────────

    private _evaluateHint(
        hint: HarmonizationDetectionHint,
        filePath: string,
        content: string,
    ): HarmonizationHintResult {
        try {
            switch (hint.hintKind) {
                case 'regex_mismatch':
                    return this._evalRegexMismatch(hint, filePath, content);
                case 'ipc_naming_check':
                    return this._evalIpcNamingCheck(hint, filePath, content);
                case 'presence_absence':
                    return this._evalPresenceAbsence(hint, filePath, content);
                case 'symbol_naming_check':
                    return this._evalSymbolNamingCheck(hint, filePath, content);
                case 'telemetry_key_check':
                    return this._evalTelemetryKeyCheck(hint, filePath, content);
                default:
                    return { hintLabel: hint.label, filePath, passed: true, detail: 'unsupported_hint_kind' };
            }
        } catch {
            return { hintLabel: hint.label, filePath, passed: true, detail: 'eval_error' };
        }
    }

    /**
     * regex_mismatch: content should/should-not match a regex pattern.
     * Compliant when: new RegExp(hint.pattern).test(content) === hint.expectMatch
     */
    private _evalRegexMismatch(
        hint: HarmonizationDetectionHint,
        filePath: string,
        content: string,
    ): HarmonizationHintResult {
        let matches = false;
        try {
            matches = new RegExp(hint.pattern).test(content);
        } catch {
            return { hintLabel: hint.label, filePath, passed: true, detail: 'invalid_regex' };
        }
        const passed = matches === hint.expectMatch;
        return {
            hintLabel: hint.label,
            filePath,
            passed,
            detail: passed ? undefined : `regex '${hint.pattern}' ${hint.expectMatch ? 'not found' : 'unexpectedly found'}`,
        };
    }

    /**
     * ipc_naming_check: check whether ipcRenderer.invoke() call-sites
     * use the pattern string as a substring (e.g. presence of `ipcRenderer.invoke(`).
     * Compliant when the presence matches expectMatch.
     */
    private _evalIpcNamingCheck(
        hint: HarmonizationDetectionHint,
        filePath: string,
        content: string,
    ): HarmonizationHintResult {
        const found = content.includes(hint.pattern);
        const passed = found === hint.expectMatch;
        return {
            hintLabel: hint.label,
            filePath,
            passed,
            detail: passed ? undefined : `Expected '${hint.pattern}' ${hint.expectMatch ? 'present' : 'absent'}`,
        };
    }

    /**
     * presence_absence: content must/must-not contain hint.pattern as a literal substring.
     * Compliant when content.includes(pattern) === expectMatch.
     */
    private _evalPresenceAbsence(
        hint: HarmonizationDetectionHint,
        filePath: string,
        content: string,
    ): HarmonizationHintResult {
        const found = content.includes(hint.pattern);
        const passed = found === hint.expectMatch;
        return {
            hintLabel: hint.label,
            filePath,
            passed,
            detail: passed ? undefined : `'${hint.pattern}' ${hint.expectMatch ? 'missing' : 'should not be present'}`,
        };
    }

    /**
     * symbol_naming_check: exported class/function/const names should
     * include the pattern string as a suffix or match it as a regex.
     */
    private _evalSymbolNamingCheck(
        hint: HarmonizationDetectionHint,
        filePath: string,
        content: string,
    ): HarmonizationHintResult {
        // Extract export class/function/const names
        const exportPattern = /export\s+(?:class|function|const)\s+(\w+)/g;
        const names: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = exportPattern.exec(content)) !== null) {
            names.push(m[1]);
        }
        if (names.length === 0) {
            return { hintLabel: hint.label, filePath, passed: true, detail: 'no_exports_found' };
        }
        let regex: RegExp;
        try {
            regex = new RegExp(hint.pattern);
        } catch {
            return { hintLabel: hint.label, filePath, passed: true, detail: 'invalid_pattern' };
        }
        const allMatch = names.every(n => regex.test(n));
        const passed = allMatch === hint.expectMatch;
        return {
            hintLabel: hint.label,
            filePath,
            passed,
            detail: passed ? undefined : `Symbols [${names.join(', ')}] do not match pattern '${hint.pattern}'`,
        };
    }

    /**
     * telemetry_key_check: checks that telemetry.operational() calls are present
     * (or absent) based on expectMatch. This is a presence check on the call pattern.
     */
    private _evalTelemetryKeyCheck(
        hint: HarmonizationDetectionHint,
        filePath: string,
        content: string,
    ): HarmonizationHintResult {
        const found = content.includes(hint.pattern);
        const passed = found === hint.expectMatch;
        return {
            hintLabel: hint.label,
            filePath,
            passed,
            detail: passed ? undefined : `Telemetry pattern '${hint.pattern}' ${hint.expectMatch ? 'missing' : 'should not be present'}`,
        };
    }

    // ─── Severity computation ──────────────────────────────────────────────────

    /**
     * Computes severity 0–100.
     *
     * severity = violatedWeight × fileCoverageFactor × 100
     *
     * violatedWeight — sum of weights of hints that fired (absolute, not ratio)
     * fileCoverageFactor = affectedFiles / max(1, totalScopedFiles)
     * Clamped to [0, 100].
     *
     * Using absolute weight (not ratio) means low-weight hints produce proportionally
     * lower severity, preventing trivial single-hint violations from scoring at 100.
     */
    private _computeSeverity(
        hints: readonly HarmonizationDetectionHint[],
        results: HarmonizationHintResult[],
        totalScopedFiles: number,
        affectedFileCount: number,
    ): number {
        if (hints.length === 0 || totalScopedFiles === 0) return 0;

        let violatedWeight = 0;

        for (const hint of hints) {
            // Count violations: any result for this hint that did not pass
            const violations = results.filter(r => r.hintLabel === hint.label && !r.passed);
            if (violations.length > 0) {
                violatedWeight += hint.weight;
            }
        }

        // Absolute weight score (max = sum of all hint weights, capped at 1.0)
        const hintScore = Math.min(1.0, violatedWeight);
        const coverageFactor = affectedFileCount / Math.max(1, totalScopedFiles);
        // Blend: hint violations weighted 70%, file coverage 30%
        const raw = hintScore * 0.7 + coverageFactor * 0.3;
        return Math.min(100, Math.max(0, raw * 100));
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    private _fileInScope(filePath: string, scopePathIncludes: readonly string[]): boolean {
        if (scopePathIncludes.length === 0) return true;
        return scopePathIncludes.some(seg => filePath.includes(seg));
    }

    private _isProtected(filePath: string): boolean {
        return PROTECTED_PATH_SEGMENTS.some(seg => filePath.includes(seg));
    }

    private _inferSubsystems(filePaths: string[]): string[] {
        const subsystems = new Set<string>();
        for (const fp of filePaths) {
            if (fp.includes('campaigns')) subsystems.add('campaigns');
            else if (fp.includes('recovery')) subsystems.add('recovery');
            else if (fp.includes('adaptive')) subsystems.add('adaptive');
            else if (fp.includes('escalation')) subsystems.add('escalation');
            else if (fp.includes('harmonization')) subsystems.add('harmonization');
            else if (fp.includes('governance')) subsystems.add('governance');
            else if (fp.includes('execution')) subsystems.add('execution');
            else if (fp.includes('reflection')) subsystems.add('reflection');
            else if (fp.includes('renderer')) subsystems.add('renderer');
            else if (fp.includes('autonomy')) subsystems.add('autonomy');
            else subsystems.add('general');
        }
        return [...subsystems];
    }

    private _buildSummary(
        rule: HarmonizationCanonRule,
        affectedFiles: string[],
        severity: number,
    ): string {
        return (
            `Canon rule '${rule.label}' detected ${rule.patternClass} drift ` +
            `in ${affectedFiles.length} file(s) (severity=${Math.round(severity)}). ` +
            `Pattern: ${rule.complianceDescription.slice(0, 80)}...`
        );
    }
}
