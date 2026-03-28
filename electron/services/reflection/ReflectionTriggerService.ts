/**
 * ReflectionTriggerService.ts — Phase 2 P2B: Trigger Intake
 *
 * Provides a clean, single-responsibility entry point for all reflection
 * planning triggers.  All callers (scheduler, user IPC, goal service, etc.)
 * should go through this service rather than calling SafeChangePlanner
 * directly.
 *
 * Responsibilities (in execution order):
 *   1. Normalize the raw trigger input
 *   2. Generate a deterministic fingerprint
 *   3. Check deduplication (matching active/recent run)
 *   4. Check subsystem cooldown
 *   5. Check active-run lock
 *   6. Create the planning run if all gates pass
 *
 * Returns a TriggerIntakeResult describing the disposition of the trigger.
 *
 * Design principle: DETERMINISTIC FIRST. MODEL LAST.
 * No model calls, no file I/O in this service.  All guards are in-memory
 * and deterministic.
 */

import type {
    PlanTriggerInput,
    PlanningMode,
} from '../../../shared/reflectionPlanTypes';
import type {
    TriggerIntakeResult,
    ProposalOrigin,
} from '../../../shared/reflectionTypes';
import { PlanRunRegistry } from './PlanRunRegistry';
import { SafeChangePlanner } from './SafeChangePlanner';
import { telemetry } from '../TelemetryService';

// ─── Validation constants ─────────────────────────────────────────────────────

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const VALID_MODES: PlanningMode[] = ['light', 'standard', 'deep'];
const DEFAULT_MODE: PlanningMode = 'standard';

// ─── Raw trigger shape (from external callers) ────────────────────────────────

/**
 * Raw, unvalidated trigger input as received from external callers.
 *
 * All fields are optional at ingestion time; ReflectionTriggerService
 * normalizes them before passing to SafeChangePlanner.
 */
export interface RawTriggerInput {
    subsystemId?: string;
    issueType?: string;
    normalizedTarget?: string;
    severity?: string;
    description?: string;
    planningMode?: string;
    sourceGoalId?: string;
    sourceIssueId?: string;
    isManual?: boolean;
    origin?: ProposalOrigin;
}

/**
 * The result of validating a raw trigger input.
 * `valid === false` means the trigger was rejected at the normalization stage.
 */
export type NormalizationResult =
    | { valid: true; trigger: PlanTriggerInput }
    | { valid: false; reason: string };

// ─── ReflectionTriggerService ─────────────────────────────────────────────────

export class ReflectionTriggerService {
    constructor(
        private readonly registry: PlanRunRegistry,
        private readonly planner: SafeChangePlanner,
    ) {}

    // ── Public API ──────────────────────────────────────────────────────────────

    /**
     * Full trigger intake pipeline.
     *
     * Executes all gates in order and either starts a planning run or
     * returns a structured rejection result.
     *
     * @param raw  The raw trigger from any caller (IPC, scheduler, goal service).
     * @returns    TriggerIntakeResult with accepted/rejected status.
     */
    async intake(raw: RawTriggerInput): Promise<TriggerIntakeResult> {
        // Step 1: Normalize
        const normResult = this.normalizeTrigger(raw);
        if (!normResult.valid) {
            telemetry.operational(
                'planning',
                'planning.trigger.rejected.invalid',
                'warn',
                'ReflectionTriggerService',
                `Trigger rejected: ${normResult.reason}`,
            );
            return {
                accepted: false,
                runId: '',
                status: 'failed',
                message: `Invalid trigger: ${normResult.reason}`,
            };
        }

        const trigger = normResult.trigger;

        // Step 2: Generate fingerprint
        const fingerprint = this.registry.computeFingerprint(trigger);

        // Steps 3–5 are bypass-able for critical severity and manual triggers
        const bypassGates = trigger.severity === 'critical' || trigger.isManual === true;

        if (!bypassGates) {
            // Step 3: Deduplication check
            const dedup = this.registry.checkDuplicate(fingerprint);
            if (dedup.isDuplicate) {
                telemetry.operational(
                    'planning',
                    'planning.trigger.deduped',
                    'debug',
                    'ReflectionTriggerService',
                    `Trigger deduped — attached to run ${dedup.existingRunId}`,
                );
                return {
                    accepted: false,
                    runId: dedup.existingRunId!,
                    status: 'deduped',
                    message: `Trigger deduplicated — attached to existing run ${dedup.existingRunId} (${dedup.existingRunStatus})`,
                    attachedToRunId: dedup.existingRunId,
                };
            }

            // Step 4: Cooldown check
            if (this.registry.isInCooldown(trigger.subsystemId)) {
                const cooldown = this.registry.getCooldown(trigger.subsystemId);
                const remainingMs = cooldown ? Math.max(0, cooldown.expiresAt - Date.now()) : 0;
                const remainingMin = Math.ceil(remainingMs / 60_000);
                telemetry.operational(
                    'planning',
                    'planning.trigger.cooldown_blocked',
                    'debug',
                    'ReflectionTriggerService',
                    `Trigger blocked — ${trigger.subsystemId} in cooldown for ${remainingMin} more min`,
                );
                return {
                    accepted: false,
                    runId: '',
                    status: 'cooldown_blocked',
                    message: `Subsystem '${trigger.subsystemId}' is in cooldown for ${remainingMin} more minute(s)`,
                };
            }

            // Step 5: Active-run lock check
            if (this.registry.isSubsystemLocked(trigger.subsystemId)) {
                const activeRun = this.registry.getActiveRun(trigger.subsystemId);
                telemetry.operational(
                    'planning',
                    'planning.trigger.locked',
                    'debug',
                    'ReflectionTriggerService',
                    `Trigger blocked — ${trigger.subsystemId} already has active run ${activeRun?.runId}`,
                );
                return {
                    accepted: false,
                    runId: activeRun?.runId ?? '',
                    status: 'deduped',
                    message: `Subsystem '${trigger.subsystemId}' already has an active run in progress`,
                    attachedToRunId: activeRun?.runId,
                };
            }
        }

        // Step 6: Start the planning run
        telemetry.operational(
            'planning',
            'planning.trigger.accepted',
            'debug',
            'ReflectionTriggerService',
            `Trigger accepted for ${trigger.subsystemId} (${trigger.issueType}) — starting run`,
        );

        const response = await this.planner.plan(trigger);

        return {
            accepted: response.status !== 'deduped' && response.status !== 'cooldown_blocked',
            runId: response.runId,
            status: response.status === 'completed' ? 'accepted' : response.status,
            message: response.message,
            attachedToRunId: response.attachedToRunId,
        };
    }

    /**
     * Validates and normalizes a raw trigger input.
     *
     * Returns { valid: true, trigger } or { valid: false, reason } without
     * throwing.  All callers can rely on this method being pure and
     * side-effect-free.
     *
     * @param raw  Raw input from any caller.
     */
    normalizeTrigger(raw: RawTriggerInput): NormalizationResult {
        // Required field: subsystemId
        const subsystemId = (raw.subsystemId ?? '').trim();
        if (!subsystemId) {
            return { valid: false, reason: 'subsystemId is required and must not be empty' };
        }

        // Required field: issueType
        const issueType = (raw.issueType ?? '').trim();
        if (!issueType) {
            return { valid: false, reason: 'issueType is required and must not be empty' };
        }

        // normalizedTarget: optional but normalized if present
        const normalizedTarget = (raw.normalizedTarget ?? '').trim().toLowerCase();

        // severity: default to 'medium' if missing or invalid
        const rawSeverity = (raw.severity ?? 'medium').toLowerCase();
        const severity = (VALID_SEVERITIES as readonly string[]).includes(rawSeverity)
            ? (rawSeverity as PlanTriggerInput['severity'])
            : 'medium';

        // planningMode: default to standard if missing or invalid
        const rawMode = (raw.planningMode ?? DEFAULT_MODE) as string;
        const planningMode: PlanningMode = VALID_MODES.includes(rawMode as PlanningMode)
            ? (rawMode as PlanningMode)
            : DEFAULT_MODE;

        const trigger: PlanTriggerInput = {
            subsystemId,
            issueType,
            normalizedTarget,
            severity,
            description: (raw.description ?? '').trim() || undefined,
            planningMode,
            sourceGoalId: raw.sourceGoalId,
            sourceIssueId: raw.sourceIssueId,
            isManual: raw.isManual ?? false,
        };

        return { valid: true, trigger };
    }

    /**
     * Convenience: generate a fingerprint without running the full intake.
     *
     * Useful for pre-flight checks and deduplication previews.
     */
    fingerprintTrigger(raw: RawTriggerInput): import('../../../shared/reflectionPlanTypes').TriggerFingerprint | null {
        const result = this.normalizeTrigger(raw);
        if (!result.valid) return null;
        return this.registry.computeFingerprint(result.trigger);
    }

    /**
     * Checks all gates without actually starting a run.
     *
     * Returns a structured preview of what would happen if intake() were called.
     * Useful for UI pre-flight checks and testing.
     */
    precheck(raw: RawTriggerInput): {
        wouldAccept: boolean;
        reason:
            | 'invalid_trigger'
            | 'deduped'
            | 'cooldown_blocked'
            | 'active_run_locked'
            | 'would_accept';
        details: string;
        existingRunId?: string;
    } {
        const normResult = this.normalizeTrigger(raw);
        if (!normResult.valid) {
            return { wouldAccept: false, reason: 'invalid_trigger', details: normResult.reason };
        }

        const trigger = normResult.trigger;
        const bypassGates = trigger.severity === 'critical' || trigger.isManual === true;

        if (!bypassGates) {
            const fingerprint = this.registry.computeFingerprint(trigger);
            const dedup = this.registry.checkDuplicate(fingerprint);
            if (dedup.isDuplicate) {
                return { wouldAccept: false, reason: 'deduped', details: `Would attach to run ${dedup.existingRunId}`, existingRunId: dedup.existingRunId };
            }

            if (this.registry.isInCooldown(trigger.subsystemId)) {
                const cd = this.registry.getCooldown(trigger.subsystemId);
                const minLeft = cd ? Math.ceil((cd.expiresAt - Date.now()) / 60_000) : 0;
                return { wouldAccept: false, reason: 'cooldown_blocked', details: `Cooldown: ${minLeft} min remaining` };
            }

            if (this.registry.isSubsystemLocked(trigger.subsystemId)) {
                const active = this.registry.getActiveRun(trigger.subsystemId);
                return { wouldAccept: false, reason: 'active_run_locked', details: 'Subsystem has active run', existingRunId: active?.runId };
            }
        }

        return { wouldAccept: true, reason: 'would_accept', details: `Ready to start ${trigger.planningMode} run for ${trigger.subsystemId}` };
    }
}
