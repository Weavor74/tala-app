import type {
    StorageAddProviderRequest,
    StorageBridge,
    StorageIpcErrorPayload,
    StorageProviderValidationResult,
    StorageRegistrySnapshot,
    StorageRole,
} from './storageTypes';

export interface StorageScreenState {
    snapshot: StorageRegistrySnapshot | null;
    loading: boolean;
    actionMessage: string;
    lastError: StorageIpcErrorPayload | null;
    validationByProviderId: Record<string, StorageProviderValidationResult>;
}

function buildInitialState(): StorageScreenState {
    return {
        snapshot: null,
        loading: false,
        actionMessage: '',
        lastError: null,
        validationByProviderId: {},
    };
}

function createFallbackError(message: string): StorageIpcErrorPayload {
    return {
        code: 'persistence_load_failed',
        message,
    };
}

export class StorageScreenService {
    private readonly bridge: StorageBridge;
    private state: StorageScreenState;

    constructor(bridge: StorageBridge) {
        this.bridge = bridge;
        this.state = buildInitialState();
    }

    public getState(): StorageScreenState {
        return this.state;
    }

    public async loadSnapshot(): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        try {
            const snapshot = await this.bridge.getSnapshot();
            this.state = { ...this.state, snapshot, loading: false };
            return this.state;
        } catch (error) {
            this.state = {
                ...this.state,
                loading: false,
                lastError: createFallbackError(error instanceof Error ? error.message : String(error)),
            };
            return this.state;
        }
    }

    public async detectProviders(): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        try {
            const response = await this.bridge.detectProviders();
            this.state = {
                ...this.state,
                loading: false,
                snapshot: response.snapshot,
                actionMessage: `Detected ${response.detectedProviders.length} provider(s).`,
            };
            return this.state;
        } catch (error) {
            this.state = {
                ...this.state,
                loading: false,
                lastError: createFallbackError(error instanceof Error ? error.message : String(error)),
            };
            return this.state;
        }
    }

    public async validateProvider(providerId: string): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.validateProvider({ providerId });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = {
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Validated ${providerId}.`,
            validationByProviderId: {
                ...this.state.validationByProviderId,
                [providerId]: response.result,
            },
        };
        return this.state;
    }

    public async addProvider(request: StorageAddProviderRequest): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.addProvider(request);
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = {
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Added provider ${response.changed.name}.`,
        };
        return this.state;
    }

    public async removeProvider(providerId: string): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.removeProvider({ providerId });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = {
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Removed provider ${providerId}.`,
        };
        return this.state;
    }

    public async setProviderEnabled(providerId: string, enabled: boolean): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.setProviderEnabled({ providerId, enabled });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = {
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `${enabled ? 'Enabled' : 'Disabled'} provider ${providerId}.`,
        };
        return this.state;
    }

    public async assignRole(providerId: string, role: StorageRole): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.assignRole({ providerId, role });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = {
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Assigned ${role} to ${providerId}.`,
        };
        return this.state;
    }

    public async unassignRole(role: StorageRole): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.unassignRole({ role });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = {
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Unassigned ${role}.`,
        };
        return this.state;
    }

    public async updateProviderName(providerId: string, name: string): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.updateProvider({ id: providerId, patch: { name } });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = {
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Updated provider ${providerId}.`,
        };
        return this.state;
    }
}

export function createStorageScreenService(bridge: StorageBridge): StorageScreenService {
    return new StorageScreenService(bridge);
}
