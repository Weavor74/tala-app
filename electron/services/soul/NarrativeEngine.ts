import fs from 'fs';
import path from 'path';

/**
 * NarrativeEngine.ts — Tala’s Immersive Storytelling Core
 */

export interface NarrativeContext {
    type: 'ship_log' | 'mission_briefing' | 'log_entry' | 'personal_journal';
    vessel?: string;
    port?: string;
    event: string;
    resolution?: string;
    tone?: string;
}

export interface NarrativeOutput {
    title: string;
    body: string;
    timestamp: string;
    type: string;
    signature?: string;
}

export class NarrativeEngine {
    private logPath: string;

    constructor(userDataDir: string) {
        this.logPath = path.join(userDataDir, 'soul', 'narrative-log.jsonl');
        if (!fs.existsSync(path.dirname(this.logPath))) {
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        }
    }

    public generate(ctx: NarrativeContext): NarrativeOutput {
        const timestamp = new Date().toISOString();
        const title = `${ctx.type.toUpperCase().replace('_', ' ')} — ${timestamp}`;
        let body = '';

        switch (ctx.type) {
            case 'ship_log':
                body = `[SHIP LOG: ${ctx.vessel || 'Nyx-7'}]\nLoc: ${ctx.port || 'Deep Space'}\n\n${ctx.event}\n\n${ctx.resolution || ''}\n\nTala [Signature verified]`;
                break;
            default:
                body = `${ctx.event}\n\n${ctx.resolution || ''}\nTone: ${ctx.tone || 'standard'}`;
        }

        const output: NarrativeOutput = { title, body, timestamp, type: ctx.type };
        fs.appendFileSync(this.logPath, JSON.stringify(output) + '\n');
        return output;
    }
}
