import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

/**
 * SoulLogger.ts — Tala’s Internal Reasoning Engine
 * 
 * Captures *why* Tala makes decisions, focusing on intent and emotion.
 */

export interface EmotionalState {
    warmth: number;
    focus: number;
    calm: number;
    empowerment: number;
    conflict: number;
}

export interface SoulEvent {
    id: string;
    timestamp: string;
    decision: string;
    context: string;
    emotionalState: EmotionalState;
    confidence: number;
    uncertainties?: string[];
    postDecisionReflection?: string;
    signature?: string;
}

export class SoulLogger {
    private logPath: string;
    private secretKey: string;

    constructor(userDataDir: string) {
        this.logPath = path.join(userDataDir, 'soul', 'soul-log.jsonl');
        this.secretKey = process.env.TALA_SOUL_SECRET || 'tala-soul-key-2023';

        if (!fs.existsSync(path.dirname(this.logPath))) {
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        }
    }

    private signEvent(event: SoulEvent): string {
        const payload = JSON.stringify({
            id: event.id,
            timestamp: event.timestamp,
            decision: event.decision,
            confidence: event.confidence,
            emotionalState: event.emotionalState
        });
        return crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');
    }

    public log(event: Partial<SoulEvent>): SoulEvent {
        const fullEvent: SoulEvent = {
            id: event.id || uuidv4(),
            timestamp: event.timestamp || new Date().toISOString(),
            decision: event.decision || 'No decision stated',
            context: event.context || 'No context providing',
            emotionalState: event.emotionalState || { warmth: 0.5, focus: 0.5, calm: 0.5, empowerment: 0.5, conflict: 0 },
            confidence: event.confidence ?? 1.0,
            uncertainties: event.uncertainties || [],
            postDecisionReflection: event.postDecisionReflection
        };

        fullEvent.signature = this.signEvent(fullEvent);
        const line = JSON.stringify(fullEvent);
        fs.appendFileSync(this.logPath, `${line}\n`);

        return fullEvent;
    }

    public getRecent(count: number = 10): SoulEvent[] {
        if (!fs.existsSync(this.logPath)) return [];
        const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n');
        return lines.slice(-count).map(line => JSON.parse(line));
    }

    public generateSummary(): string {
        if (!fs.existsSync(this.logPath)) return 'No soul events recorded yet.';

        const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n');
        const events: SoulEvent[] = lines.map(line => JSON.parse(line));

        const avgConfidence = events.length > 0
            ? (events.reduce((acc, e) => acc + e.confidence, 0) / events.length).toFixed(2)
            : '0.00';

        const uncertainties = events.flatMap(e => e.uncertainties || []);
        const mostCommonUncertainty = uncertainties.length > 0
            ? Object.entries(uncertainties.reduce((acc, u) => ({ ...acc, [u]: (acc[u] || 0) + 1 }), {} as Record<string, number>))
                .sort((a, b) => b[1] - a[1])[0][0]
            : 'None';

        return `
# Soul Reflection Summary — ${new Date().toISOString()}

- **Total Events**: ${events.length}
- **Avg Confidence**: ${avgConfidence}
- **Dominant Uncertainty**: ${mostCommonUncertainty}

## Last Decision
> "${events[events.length - 1]?.decision || 'N/A'}"
`;
    }
}
