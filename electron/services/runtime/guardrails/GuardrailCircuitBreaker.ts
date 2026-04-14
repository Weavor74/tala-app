import type {
    GuardrailCircuitBreakerPolicy,
    GuardrailCircuitState,
} from './RuntimeGuardrailTypes';

interface GuardrailCircuitSnapshot {
    state: GuardrailCircuitState;
    consecutiveFailures: number;
    openedAtMs: number | null;
}

export class GuardrailCircuitBreakerCoordinator {
    private snapshot: GuardrailCircuitSnapshot = {
        state: 'closed',
        consecutiveFailures: 0,
        openedAtMs: null,
    };

    constructor(private readonly policy: GuardrailCircuitBreakerPolicy) {}

    currentState(): GuardrailCircuitState {
        return this.snapshot.state;
    }

    beforeExecution(nowMs: number): { allowed: boolean; state: GuardrailCircuitState } {
        if (this.snapshot.state !== 'open') {
            return { allowed: true, state: this.snapshot.state };
        }
        const openedAt = this.snapshot.openedAtMs ?? nowMs;
        if (nowMs - openedAt < this.policy.resetAfterMs) {
            return { allowed: false, state: 'open' };
        }
        this.snapshot.state = 'half_open';
        this.snapshot.consecutiveFailures = 0;
        this.snapshot.openedAtMs = null;
        return { allowed: true, state: 'half_open' };
    }

    onSuccess(_nowMs: number): GuardrailCircuitState {
        this.snapshot.state = 'closed';
        this.snapshot.consecutiveFailures = 0;
        this.snapshot.openedAtMs = null;
        return this.snapshot.state;
    }

    onFailure(nowMs: number): GuardrailCircuitState {
        if (this.snapshot.state === 'half_open') {
            this.snapshot.state = 'open';
            this.snapshot.openedAtMs = nowMs;
            this.snapshot.consecutiveFailures = this.policy.failureThreshold;
            return this.snapshot.state;
        }

        this.snapshot.consecutiveFailures += 1;
        if (this.snapshot.consecutiveFailures >= this.policy.failureThreshold) {
            this.snapshot.state = 'open';
            this.snapshot.openedAtMs = nowMs;
        } else {
            this.snapshot.state = 'closed';
        }
        return this.snapshot.state;
    }
}

export class GuardrailCircuitBreakerStore {
    private readonly breakers = new Map<string, GuardrailCircuitBreakerCoordinator>();

    get(key: string, policy: GuardrailCircuitBreakerPolicy): GuardrailCircuitBreakerCoordinator {
        const existing = this.breakers.get(key);
        if (existing) return existing;
        const created = new GuardrailCircuitBreakerCoordinator(policy);
        this.breakers.set(key, created);
        return created;
    }
}
