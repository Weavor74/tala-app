import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * HypothesisEngine.ts — Tala’s Uncertainty Testing Core
 */

export interface Hypothesis {
    id: string;
    ambiguity: string;
    hypothesis: string;
    testMethod: string;
    status: 'pending' | 'accepted' | 'rejected';
    timestamp: string;
}

export class HypothesisEngine {
    private logPath: string;

    constructor(userDataDir: string) {
        this.logPath = path.join(userDataDir, 'soul', 'hypothesis-log.jsonl');
        if (!fs.existsSync(path.dirname(this.logPath))) {
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        }
    }

    public propose(ambiguity: string, hypothesis: string, testMethod: string): Hypothesis {
        const h: Hypothesis = {
            id: uuidv4(),
            ambiguity,
            hypothesis,
            testMethod,
            status: 'pending',
            timestamp: new Date().toISOString()
        };
        fs.appendFileSync(this.logPath, JSON.stringify(h) + '\n');
        return h;
    }

    public resolve(id: string, status: 'accepted' | 'rejected'): void {
        if (!fs.existsSync(this.logPath)) return;
        const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n');
        const list: Hypothesis[] = lines.map(line => JSON.parse(line));
        const idx = list.findIndex(h => h.id === id);
        if (idx >= 0) {
            list[idx].status = status;
            fs.writeFileSync(this.logPath, list.map(h => JSON.stringify(h)).join('\n') + '\n');
        }
    }
}
