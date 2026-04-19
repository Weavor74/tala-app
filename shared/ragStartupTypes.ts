export type ServiceStartupState =
    | 'not_started'
    | 'starting'
    | 'slow_start'
    | 'ready'
    | 'degraded'
    | 'failed';

export interface RagStartupResult {
    state: ServiceStartupState;
    reason?: string;
    elapsedMs: number;
    processAlive?: boolean;
    readySignalObserved?: boolean;
}
