import type { WorkspaceDocument } from '../types';

type SurfaceStateMap = Record<string, Record<string, unknown>>;

function readSurfaceStateMap(document: WorkspaceDocument): SurfaceStateMap {
    const metadata = document.metadata || {};
    const raw = metadata.surfaceState;
    if (!raw || typeof raw !== 'object') return {};
    return raw as SurfaceStateMap;
}

export function getSurfaceState<T extends object>(
    document: WorkspaceDocument,
    surfaceKey: string
): T | undefined {
    const stateMap = readSurfaceStateMap(document);
    const state = stateMap[surfaceKey];
    if (!state || typeof state !== 'object') return undefined;
    return state as T;
}

export function buildSurfaceStateMetadata(
    document: WorkspaceDocument,
    surfaceKey: string,
    state: Record<string, unknown>
): Record<string, unknown> {
    const existing = readSurfaceStateMap(document);
    return {
        surfaceState: {
            ...existing,
            [surfaceKey]: state,
        }
    };
}
