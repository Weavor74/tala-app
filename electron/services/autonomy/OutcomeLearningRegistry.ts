/**
 * OutcomeLearningRegistry.ts — Phase 4 P4F
 *
 * Local operational memory for autonomous improvement attempts.
 *
 * Purpose:
 * - Record prior autonomous attempts and their outcomes.
 * - Adjust confidence modifiers for future goal scoring.
 * - Suppress repeated low-value retries on failing patterns.
 * - Route patterns to human review after maxAttemptsPerPattern failures.
 *
 * This is NOT model training. It is operational memory only.
 * Records are stored locally and never sent to any external service.
 *
 * Storage: <dataDir>/autonomy/learning/<patternKey>.json
 * One file per unique pattern (source + subsystemId + title hash).
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
    LearningRecord,
    AutonomousGoal,
    AutonomousRun,
    AttemptOutcome,
    GoalSource,
} from '../../../shared/autonomyTypes';
import { telemetry } from '../TelemetryService';

// ─── Confidence adjustments ───────────────────────────────────────────────────

const CONFIDENCE_DELTA: Record<AttemptOutcome, number> = {
    succeeded: +0.1,
    failed: -0.15,
    policy_blocked: 0,
    governance_blocked: -0.05,
    rolled_back: -0.25,
    aborted: -0.1,
};

const INITIAL_CONFIDENCE = 0.7;
const CONFIDENCE_MIN = 0.0;
const CONFIDENCE_MAX = 1.0;

// ─── OutcomeLearningRegistry ──────────────────────────────────────────────────

export class OutcomeLearningRegistry {
    private readonly learningDir: string;
    private cache: Map<string, LearningRecord> = new Map();

    constructor(dataDir: string) {
        const autonomyDir = path.join(dataDir, 'autonomy');
        this.learningDir = path.join(autonomyDir, 'learning');
        try {
            if (!fs.existsSync(this.learningDir)) {
                fs.mkdirSync(this.learningDir, { recursive: true });
            }
        } catch {
            // Non-fatal
        }
    }

    // ── Record outcome ──────────────────────────────────────────────────────────

    /**
     * Records an autonomous run outcome for the given goal.
     * Creates or updates the LearningRecord for the goal's pattern.
     * Returns the updated LearningRecord.
     */
    record(
        goal: AutonomousGoal,
        run: AutonomousRun,
        outcome: AttemptOutcome,
    ): LearningRecord {
        const patternKey = goal.dedupFingerprint;
        let existing = this._load(patternKey);

        if (!existing) {
            existing = {
                recordId: uuidv4(),
                goalId: goal.goalId,
                subsystemId: goal.subsystemId,
                source: goal.source,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                successCount: 0,
                failureCount: 0,
                rollbackCount: 0,
                governanceBlockCount: 0,
                lastOutcome: outcome,
                lastAttemptAt: new Date().toISOString(),
                confidenceModifier: INITIAL_CONFIDENCE,
                patternKey,
            };
        }

        // Update counters
        switch (outcome) {
            case 'succeeded':
                existing.successCount += 1;
                break;
            case 'failed':
            case 'aborted':
                existing.failureCount += 1;
                break;
            case 'rolled_back':
                existing.rollbackCount += 1;
                break;
            case 'governance_blocked':
                existing.governanceBlockCount += 1;
                break;
            // policy_blocked does not update counters — not an execution attempt
        }

        // Adjust confidence modifier
        const delta = CONFIDENCE_DELTA[outcome] ?? 0;
        existing.confidenceModifier = Math.min(
            CONFIDENCE_MAX,
            Math.max(CONFIDENCE_MIN, existing.confidenceModifier + delta),
        );

        existing.lastOutcome = outcome;
        existing.lastAttemptAt = new Date().toISOString();
        existing.updatedAt = new Date().toISOString();
        // Track the most recent goal ID for this pattern
        existing.goalId = goal.goalId;

        this._save(patternKey, existing);
        this.cache.set(patternKey, existing);

        telemetry.operational(
            'autonomy',
            'autonomy_learning_recorded',
            'info',
            'OutcomeLearningRegistry',
            `Outcome '${outcome}' recorded for pattern ${patternKey} (confidence: ${existing.confidenceModifier.toFixed(2)})`,
        );

        return existing;
    }

    // ── Query ───────────────────────────────────────────────────────────────────

    /**
     * Returns the LearningRecord for a given pattern, or null if none exists.
     */
    get(patternKey: string): LearningRecord | null {
        if (this.cache.has(patternKey)) return this.cache.get(patternKey)!;
        const record = this._load(patternKey);
        if (record) this.cache.set(patternKey, record);
        return record;
    }

    /**
     * Returns true if the pattern has exceeded maxAttemptsPerPattern
     * (totalFailures + rollbacks) and should be routed to human review.
     */
    shouldRouteToHumanReview(patternKey: string, maxAttempts: number): boolean {
        const record = this.get(patternKey);
        if (!record) return false;
        return (record.failureCount + record.rollbackCount) >= maxAttempts;
    }

    /**
     * Returns the confidence modifier for a pattern (0.0–1.0).
     * Defaults to INITIAL_CONFIDENCE if no record exists.
     */
    getConfidenceModifier(patternKey: string): number {
        const record = this.get(patternKey);
        return record ? record.confidenceModifier : INITIAL_CONFIDENCE;
    }

    /**
     * Returns all learning records (for dashboard display).
     */
    listAll(): LearningRecord[] {
        const records: LearningRecord[] = [];
        try {
            if (!fs.existsSync(this.learningDir)) return [];
            const files = fs.readdirSync(this.learningDir).filter(f => f.endsWith('.json'));
            for (const f of files) {
                try {
                    const r = JSON.parse(
                        fs.readFileSync(path.join(this.learningDir, f), 'utf-8'),
                    );
                    records.push(r);
                } catch {
                    // Skip corrupt
                }
            }
        } catch {
            // Non-fatal
        }
        return records.sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private _filename(patternKey: string): string {
        // Sanitize patternKey for use as a filename
        const safe = patternKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
        return path.join(this.learningDir, `${safe}.json`);
    }

    private _load(patternKey: string): LearningRecord | null {
        const file = this._filename(patternKey);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch {
            return null;
        }
    }

    private _save(patternKey: string, record: LearningRecord): void {
        const file = this._filename(patternKey);
        try {
            fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
        } catch (err: any) {
            telemetry.operational(
                'autonomy',
                'operational',
                'warn',
                'OutcomeLearningRegistry',
                `Failed to save learning record for pattern ${patternKey}: ${err.message}`,
            );
        }
    }
}
