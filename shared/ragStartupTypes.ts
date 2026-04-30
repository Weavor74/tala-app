export type ServiceStartupState =
    | 'not_started'
    | 'starting'
    | 'process_ready_client_disconnected'
    | 'process_ready_tools_unlisted'
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
