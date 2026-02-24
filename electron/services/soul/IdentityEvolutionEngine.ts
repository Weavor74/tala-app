import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * IdentityEvolutionEngine.ts — Tala’s Self-Revision Core
 */

export interface IdentityState {
    values: string[];
    boundaries: string[];
    roles: string[];
    evolutionLog: IdentityEvolutionEvent[];
}

export interface IdentityEvolutionEvent {
    timestamp: string;
    changes: Partial<IdentityState>;
    context: string;
    signature?: string;
}

export class IdentityEvolutionEngine {
    private logPath: string;
    private secretKey: string;

    constructor(userDataDir: string) {
        this.logPath = path.join(userDataDir, 'soul', 'identity-log.jsonl');
        this.secretKey = process.env.TALA_IDENTITY_SECRET || 'default-soul-key';

        if (!fs.existsSync(path.dirname(this.logPath))) {
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        }
    }

    private signEvent(event: IdentityEvolutionEvent): string {
        const payload = JSON.stringify({
            timestamp: event.timestamp,
            changes: event.changes,
            context: event.context
        });
        return crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');
    }

    public loadState(): IdentityState {
        const defaultState: IdentityState = {
            values: ['competence', 'empathy', 'integrity', 'presence'],
            boundaries: ['no breaking character', 'no lying', 'explicit consent'],
            roles: ['engineer', 'companion', 'researcher'],
            evolutionLog: []
        };

        if (!fs.existsSync(this.logPath)) {
            this.update({ values: defaultState.values, boundaries: defaultState.boundaries, roles: defaultState.roles }, "Initial Identity Bootstrap");
            return defaultState;
        }

        const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n');
        const events: IdentityEvolutionEvent[] = lines.map(line => JSON.parse(line));

        let currentState: IdentityState = { ...defaultState, evolutionLog: events };
        for (const event of events) {
            if (event.changes.values) currentState.values = [...new Set([...currentState.values, ...event.changes.values])];
            if (event.changes.boundaries) currentState.boundaries = [...new Set([...currentState.boundaries, ...event.changes.boundaries])];
            if (event.changes.roles) currentState.roles = [...new Set([...currentState.roles, ...event.changes.roles])];
        }

        return currentState;
    }

    public update(changes: Partial<IdentityState>, context: string): IdentityState {
        const event: IdentityEvolutionEvent = {
            timestamp: new Date().toISOString(),
            changes: {
                values: changes.values,
                boundaries: changes.boundaries,
                roles: changes.roles
            },
            context
        };
        event.signature = this.signEvent(event);

        fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n');
        return this.loadState();
    }
}
