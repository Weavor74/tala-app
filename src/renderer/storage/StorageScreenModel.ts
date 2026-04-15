import type {
    StorageAddProviderRequest,
    StorageBridge,
    StorageIpcErrorPayload,
    StorageProviderValidationResult,
    StorageRegistrySnapshot,
    StorageRole,
} from './storageTypes';
import {
    buildAssignmentFailureExplanation,
    buildAssignmentSuccessExplanation,
    buildProviderVisibilityModels,
    buildRoleVisibilityModels,
    buildStorageAuthoritySummary,
    type StorageAssignmentExplanationViewModel,
    type StorageAuthoritySummaryViewModel,
    type StorageProviderVisibilityViewModel,
    type StorageRoleVisibilityViewModel,
} from './StorageViewModels';

export interface StorageScreenState {
    snapshot: StorageRegistrySnapshot | null;
    loading: boolean;
    actionMessage: string;
    lastError: StorageIpcErrorPayload | null;
    validationByProviderId: Record<string, StorageProviderValidationResult>;
    authoritySummary: StorageAuthoritySummaryViewModel | null;
    providerVisibilityById: Record<string, StorageProviderVisibilityViewModel>;
    roleVisibility: StorageRoleVisibilityViewModel[];
    lastAssignmentExplanation: StorageAssignmentExplanationViewModel | null;
}

function buildInitialState(): StorageScreenState {
    return {
        snapshot: null,
        loading: false,
        actionMessage: '',
        lastError: null,
        validationByProviderId: {},
        authoritySummary: null,
        providerVisibilityById: {},
        roleVisibility: [],
        lastAssignmentExplanation: null,
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
            this.state = this.hydrateState({
                ...this.state,
                snapshot,
                loading: false,
            });
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
            this.state = this.hydrateState({
                ...this.state,
                loading: false,
                snapshot: response.snapshot,
                actionMessage: `Hydration detected ${response.detectedProviders.length} Provider(s).`,
            });
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

        this.state = this.hydrateState({
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Validation completed for Provider ${providerId}.`,
            validationByProviderId: {
                ...this.state.validationByProviderId,
                [providerId]: response.result,
            },
        });
        return this.state;
    }

    public async addProvider(request: StorageAddProviderRequest): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.addProvider(request);
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = this.hydrateState({
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Registered Provider ${response.changed.name}.`,
        });
        return this.state;
    }

    public async removeProvider(providerId: string): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.removeProvider({ providerId });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = this.hydrateState({
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Removed Provider ${providerId} from the Storage Registry.`,
        });
        return this.state;
    }

    public async setProviderEnabled(providerId: string, enabled: boolean): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.setProviderEnabled({ providerId, enabled });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = this.hydrateState({
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `${enabled ? 'Enabled' : 'Disabled'} Provider ${providerId}.`,
        });
        return this.state;
    }

    public async assignRole(providerId: string, role: StorageRole): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.assignRole({ providerId, role });
        if (!response.ok) {
            const explanation = this.state.snapshot
                ? buildAssignmentFailureExplanation(this.state.snapshot, providerId, role, response.error)
                : null;
            this.state = {
                ...this.state,
                loading: false,
                lastError: response.error,
                lastAssignmentExplanation: explanation,
            };
            return this.state;
        }

        this.state = this.hydrateState({
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Assigned Role ${role} to Provider ${providerId}.`,
            lastAssignmentExplanation: buildAssignmentSuccessExplanation(
                response.snapshot,
                providerId,
                role,
                response.changed.assignmentReasonCode ?? 'explicit_assignment_preserved',
            ),
        });
        return this.state;
    }

    public async unassignRole(role: StorageRole): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.unassignRole({ role });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = this.hydrateState({
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Unassigned Role ${role}.`,
        });
        return this.state;
    }

    public async updateProviderName(providerId: string, name: string): Promise<StorageScreenState> {
        this.state = { ...this.state, loading: true, actionMessage: '', lastError: null };
        const response = await this.bridge.updateProvider({ id: providerId, patch: { name } });
        if (!response.ok) {
            this.state = { ...this.state, loading: false, lastError: response.error };
            return this.state;
        }

        this.state = this.hydrateState({
            ...this.state,
            loading: false,
            snapshot: response.snapshot,
            actionMessage: `Updated Provider ${providerId}.`,
        });
        return this.state;
    }

    private hydrateState(next: StorageScreenState): StorageScreenState {
        if (!next.snapshot) {
            return {
                ...next,
                authoritySummary: null,
                providerVisibilityById: {},
                roleVisibility: [],
            };
        }

        return {
            ...next,
            authoritySummary: buildStorageAuthoritySummary(next.snapshot),
            providerVisibilityById: buildProviderVisibilityModels(next.snapshot, next.validationByProviderId),
            roleVisibility: buildRoleVisibilityModels(next.snapshot),
        };
    }
}

export function createStorageScreenService(bridge: StorageBridge): StorageScreenService {
    return new StorageScreenService(bridge);
}
