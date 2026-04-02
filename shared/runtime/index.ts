/**
 * shared/runtime/index.ts — Barrel re-export for shared runtime execution contracts.
 *
 * Consumers can import from 'shared/runtime' instead of specifying the
 * individual module file.
 *
 * Example:
 *   import type { RuntimeExecutionType, ExecutionState } from '../../../shared/runtime';
 *   import { createInitialExecutionState } from '../../../shared/runtime';
 */
export type {
    RuntimeExecutionType,
    RuntimeExecutionOrigin,
    RuntimeExecutionMode,
    RuntimeExecutionStatus,
    ExecutionRequest,
    ExecutionState,
} from './executionTypes';

export {
    createExecutionRequest,
    createInitialExecutionState,
    advanceExecutionState,
    finalizeExecutionState,
} from './executionHelpers';
