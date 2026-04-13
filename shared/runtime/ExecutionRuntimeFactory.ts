/**
 * ExecutionRuntimeFactory.ts — Shared Runtime Execution Factory Helpers
 *
 * Lightweight factory functions for creating canonical execution contracts.
 * Keeps construction logic DRY across callers that produce ExecutionRequest
 * or ExecutionState objects.
 *
 * Design principles:
 * - Each factory applies sensible defaults; callers override where needed
 * - No side-effects; pure value construction only
 * - IDs default to prefixed UUID v4; callers may supply a pre-generated ID
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    ExecutionRequest,
    ExecutionState,
    RuntimeExecutionType,
    RuntimeExecutionOrigin,
    RuntimeExecutionMode,
    RuntimeExecutionStatus,
} from './executionTypes';

// ─── Request factory ──────────────────────────────────────────────────────────

/**
 * Creates a normalized ExecutionRequest with defaults applied.
 *
 * Callers may supply an `executionId` to reuse a pre-generated ID (e.g. from
 * a KernelExecutionMeta that was stamped earlier in the pipeline). When omitted,
 * a new `exec-<uuid>` ID is generated.
 */
export function createExecutionRequest(params: {
    type: RuntimeExecutionType;
    origin: RuntimeExecutionOrigin;
    mode: RuntimeExecutionMode;
    actor: string;
    input: unknown;
    metadata?: Record<string, unknown>;
    executionId?: string;
    parentExecutionId?: string;
}): ExecutionRequest {
    const req: ExecutionRequest = {
        executionId: params.executionId ?? `exec-${uuidv4()}`,
        type: params.type,
        origin: params.origin,
        mode: params.mode,
        actor: params.actor,
        input: params.input,
        metadata: params.metadata ?? {},
        createdAt: new Date().toISOString(),
    };
    if (params.parentExecutionId !== undefined) {
        req.parentExecutionId = params.parentExecutionId;
    }
    return req;
}

// ─── State factory ────────────────────────────────────────────────────────────

/**
 * Creates the initial ExecutionState for a newly accepted execution.
 *
 * - `status` is set to `'accepted'` (request passed pre-flight; ready to begin)
 * - `phase` is set to `'intake'` (first named kernel stage)
 * - Timestamps are set to the current ISO instant
 *
 * Callers should update `status`, `phase`, `updatedAt`, and `completedAt` as
 * the execution progresses through its lifecycle stages.
 *
 * @param request  The ExecutionRequest this state tracks.
 * @param activeSubsystem  Optional name of the subsystem taking ownership at creation.
 */
export function createInitialExecutionState(
    request: ExecutionRequest,
    activeSubsystem?: string
): ExecutionState {
    const now = new Date().toISOString();
    const state: ExecutionState = {
        executionId: request.executionId,
        type: request.type,
        origin: request.origin,
        mode: request.mode,
        status: 'accepted',
        phase: 'intake',
        startedAt: now,
        updatedAt: now,
        degraded: false,
        retries: 0,
        toolCalls: [],
    };
    if (activeSubsystem !== undefined) {
        state.activeSubsystem = activeSubsystem;
    }
    return state;
}

// ─── State transition helpers ─────────────────────────────────────────────────

/**
 * Returns a shallow copy of `state` with `status`, `phase`, and `updatedAt` updated.
 * Use this for mid-execution phase transitions.
 */
export function updateExecutionStatePhase(
    state: ExecutionState,
    status: RuntimeExecutionStatus,
    phase: string
): ExecutionState {
    return { ...state, status, phase, updatedAt: new Date().toISOString() };
}

/**
 * Returns a shallow copy of `state` marked as terminal (completed or failed).
 * Sets `completedAt` and `updatedAt` to the current instant.
 */
export function setExecutionTerminalState(
    state: ExecutionState,
    outcome: {
        status: RuntimeExecutionStatus;
        failureReason?: string;
        blockedReason?: string;
        degraded?: boolean;
    }
): ExecutionState {
    const now = new Date().toISOString();
    return {
        ...state,
        status: outcome.status,
        updatedAt: now,
        completedAt: now,
        degraded: outcome.degraded ?? state.degraded,
        ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
        ...(outcome.blockedReason !== undefined ? { blockedReason: outcome.blockedReason } : {}),
    };
}

