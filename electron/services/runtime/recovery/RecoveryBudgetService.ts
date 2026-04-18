import type {
    RecoveryBudgetInput,
    RecoveryBudgetSnapshot,
    RecoveryDecisionType,
    RecoveryLoopSignal,
    RecoveryScope,
} from './RecoveryTypes';

interface RecoveryBudgetState {
    retryCount: number;
    replanCount: number;
    maxRetries: number;
    maxReplans: number;
    loopDetected: boolean;
    loopReasonCode?: string;
    decisionHistory: RecoveryDecisionType[];
    lastReasonCode?: string;
    repeatedReasonCount: number;
}

export class RecoveryBudgetService {
    private readonly _stateByScopeKey = new Map<string, RecoveryBudgetState>();

    constructor(
        private readonly _defaultMaxRetries = 2,
        private readonly _defaultMaxReplans = 2,
        private readonly _maxTransitionHistory = 6,
        private readonly _repeatedReasonThreshold = 3,
    ) {}

    getBudget(input: RecoveryBudgetInput): RecoveryBudgetSnapshot {
        const key = this._toScopeKey(input);
        const state = this._getOrCreateState(key);
        return this._toSnapshot(state, this._resolveScope(input));
    }

    incrementRetry(input: RecoveryBudgetInput): RecoveryBudgetSnapshot {
        const key = this._toScopeKey(input);
        const state = this._getOrCreateState(key);
        state.retryCount += 1;
        return this._toSnapshot(state, this._resolveScope(input));
    }

    incrementReplan(input: RecoveryBudgetInput): RecoveryBudgetSnapshot {
        const key = this._toScopeKey(input);
        const state = this._getOrCreateState(key);
        state.replanCount += 1;
        return this._toSnapshot(state, this._resolveScope(input));
    }

    markLoopDetected(input: RecoveryBudgetInput, reasonCode = 'recovery.loop.detected'): void {
        const key = this._toScopeKey(input);
        const state = this._getOrCreateState(key);
        state.loopDetected = true;
        state.loopReasonCode = reasonCode;
    }

    recordDecision(
        input: RecoveryBudgetInput,
        decisionType: RecoveryDecisionType,
        reasonCode: string,
    ): RecoveryLoopSignal {
        const key = this._toScopeKey(input);
        const state = this._getOrCreateState(key);

        state.decisionHistory.push(decisionType);
        if (state.decisionHistory.length > this._maxTransitionHistory) {
            state.decisionHistory.shift();
        }

        if (state.lastReasonCode === reasonCode) {
            state.repeatedReasonCount += 1;
        } else {
            state.lastReasonCode = reasonCode;
            state.repeatedReasonCount = 1;
        }

        const alternatingLoop = this._detectAlternatingLoop(state.decisionHistory);
        const repeatedReasonLoop = state.repeatedReasonCount >= this._repeatedReasonThreshold;

        if (alternatingLoop) {
            state.loopDetected = true;
            state.loopReasonCode = 'recovery.loop.alternating_cycle';
        } else if (repeatedReasonLoop) {
            state.loopDetected = true;
            state.loopReasonCode = 'recovery.loop.repeated_reason';
        }

        return {
            loopDetected: state.loopDetected,
            reasonCode: state.loopReasonCode,
        };
    }

    isExhausted(input: RecoveryBudgetInput): { retryExhausted: boolean; replanExhausted: boolean; anyExhausted: boolean } {
        const budget = this.getBudget(input);
        const retryExhausted = budget.remainingRetries <= 0;
        const replanExhausted = budget.remainingReplans <= 0;
        return {
            retryExhausted,
            replanExhausted,
            anyExhausted: retryExhausted && replanExhausted,
        };
    }

    reset(input: RecoveryBudgetInput): void {
        const key = this._toScopeKey(input);
        this._stateByScopeKey.delete(key);
    }

    private _toScopeKey(input: RecoveryBudgetInput): string {
        const scope = this._resolveScope(input);
        if (scope === 'execution_boundary' && input.executionBoundaryId) {
            return `execution_boundary:${input.executionBoundaryId}`;
        }
        if (scope === 'plan') {
            return `plan:${input.executionId}`;
        }
        return `execution:${input.executionId}`;
    }

    private _resolveScope(input: RecoveryBudgetInput): RecoveryScope {
        if (input.scope) return input.scope;
        return input.executionBoundaryId ? 'execution_boundary' : 'execution';
    }

    private _getOrCreateState(scopeKey: string): RecoveryBudgetState {
        const existing = this._stateByScopeKey.get(scopeKey);
        if (existing) return existing;
        const state: RecoveryBudgetState = {
            retryCount: 0,
            replanCount: 0,
            maxRetries: this._defaultMaxRetries,
            maxReplans: this._defaultMaxReplans,
            loopDetected: false,
            decisionHistory: [],
            repeatedReasonCount: 0,
        };
        this._stateByScopeKey.set(scopeKey, state);
        return state;
    }

    private _toSnapshot(state: RecoveryBudgetState, scope: RecoveryScope): RecoveryBudgetSnapshot {
        return {
            retryCount: state.retryCount,
            maxRetries: state.maxRetries,
            replanCount: state.replanCount,
            maxReplans: state.maxReplans,
            remainingRetries: Math.max(0, state.maxRetries - state.retryCount),
            remainingReplans: Math.max(0, state.maxReplans - state.replanCount),
            scope,
            loopDetected: state.loopDetected,
        };
    }

    private _detectAlternatingLoop(history: RecoveryDecisionType[]): boolean {
        if (history.length < this._maxTransitionHistory) return false;
        const recent = history.slice(-this._maxTransitionHistory);
        if (!recent.every((d) => d === 'retry' || d === 'replan')) {
            return false;
        }
        const unique = new Set(recent);
        return unique.has('retry') && unique.has('replan');
    }
}
