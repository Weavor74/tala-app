import { EventEmitter } from 'events';

export interface HeartbeatOptions {
    intervalMinutes: number;
    jitterPercent: number;
    quietHours?: { start: string; end: string };
}

/**
 * The HeartbeatEngine provides the rhythmic pulse for the reflection system.
 */
export class HeartbeatEngine extends EventEmitter {
    private timer: NodeJS.Timeout | null = null;
    private options: HeartbeatOptions;
    private isQuiet: boolean = false;

    constructor(options: HeartbeatOptions) {
        super();
        this.options = options;
    }

    start() {
        console.log(`[Heartbeat] Starting engine with ${this.options.intervalMinutes}m interval.`);
        this.scheduleNext();
    }

    stop() {
        if (this.timer) clearTimeout(this.timer);
    }

    private scheduleNext() {
        const intervalMs = this.options.intervalMinutes * 60 * 1000;
        const jitterMs = (Math.random() * 2 - 1) * (this.options.jitterPercent / 100) * intervalMs;
        const nextTick = intervalMs + jitterMs;

        this.timer = setTimeout(() => this.tick(), nextTick);
    }

    private tick() {
        if (this.isInQuietHours()) {
            console.log('[Heartbeat] Skipping tick during quiet hours.');
            this.scheduleNext();
            return;
        }

        console.log('[Heartbeat] Ticking...');
        this.emit('tick');
        this.scheduleNext();
    }

    private isInQuietHours(): boolean {
        if (!this.options.quietHours) return false;
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        const { start, end } = this.options.quietHours;

        if (start <= end) {
            return currentTime >= start && currentTime <= end;
        } else {
            // Overlays midnight (e.g., 22:00 - 06:00)
            return currentTime >= start || currentTime <= end;
        }
    }

    /**
     * Manual trigger for debugging/testing.
     */
    forceTick() {
        this.tick();
    }
}
