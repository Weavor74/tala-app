/**
 * ProviderSelectionService
 *
 * Implements the deterministic provider selection and fallback policy.
 *
 * Selection order:
 *   1. Preferred provider (request-level or registry-selected) if ready
 *   2. Deterministic waterfall over remaining providers
 *   3. Local + embedded providers before cloud in auto mode
 *   4. Explicit failure when no provider is viable
 *
 * Design principles:
 *   - Selection is deterministic and fully auditable.
 *   - Every decision (including fallback) emits structured telemetry.
 *   - The result carries the full decision chain for diagnostics.
 *   - cloud-only / local-only mode policies are respected.
 */

import type {
    InferenceProviderDescriptor,
    InferenceSelectionRequest,
    InferenceSelectionResult,
    InferenceFailureResult,
} from '../../../shared/inferenceProviderTypes';
import { InferenceProviderRegistry } from './InferenceProviderRegistry';
import { telemetry } from '../TelemetryService';

export class ProviderSelectionService {
    constructor(private registry: InferenceProviderRegistry) { }

    private static readonly WATERFALL_ORDER: ReadonlyArray<string> = [
        'ollama',
        'embedded_vllm',
        'vllm',
        'koboldcpp',
        'cloud',
    ];

    /**
     * Selects the best available provider according to the deterministic policy.
     * Always returns a result; success=false when no provider is viable.
     */
    public select(req: InferenceSelectionRequest = {}): InferenceSelectionResult {
        const {
            preferredProviderId,
            requiredCapability,
            mode = 'auto',
            fallbackAllowed = true,
            turnId = 'global',
            agentMode = 'unknown',
        } = req;

        const attempted: string[] = [];
        const storedSelectedProviderId = this.registry.getSelectedProviderId();
        const effectivePreferredProviderId = preferredProviderId ?? storedSelectedProviderId;

        if (mode === 'cloud-only') {
            return this._selectCloud(
                attempted,
                fallbackAllowed,
                turnId,
                agentMode,
                requiredCapability,
                req.preferredModelId,
                effectivePreferredProviderId,
            );
        }

        const candidates = this._buildWaterfallCandidates(mode, requiredCapability, effectivePreferredProviderId);
        if (candidates.length === 0) {
            return this._buildFailure(attempted, 'No providers available for current routing policy', turnId, agentMode);
        }

        if (effectivePreferredProviderId) {
            const preferred = candidates.find((c) => c.providerId === effectivePreferredProviderId);
            if (preferred && preferred.ready) {
                const resolvedModel = this._reconcileModel(preferred, req.preferredModelId);
                return this._buildSuccess(
                    preferred,
                    preferredProviderId
                        ? `Request-selected provider '${effectivePreferredProviderId}' is ready`
                        : `Stored selected provider '${effectivePreferredProviderId}' is ready`,
                    false,
                    attempted,
                    resolvedModel,
                );
            }

            attempted.push(effectivePreferredProviderId);

            if (!fallbackAllowed) {
                return this._buildFailure(
                    attempted,
                    `Selected provider '${effectivePreferredProviderId}' is unavailable and fallback is disabled`,
                    turnId,
                    agentMode,
                );
            }

            const reason = preferred
                ? `Provider '${effectivePreferredProviderId}' not ready (status: ${preferred.status})`
                : `Provider '${effectivePreferredProviderId}' not found or filtered by routing policy`;

            telemetry.audit(
                'local_inference',
                'provider_fallback_applied',
                'InferenceProviderSelectionService',
                `Fallback triggered: ${reason}`,
                'partial',
                {
                    turnId,
                    mode: agentMode,
                    payload: { preferredProviderId: effectivePreferredProviderId, reason, attempted },
                },
            );
        }

        for (const candidate of candidates) {
            if (effectivePreferredProviderId && candidate.providerId === effectivePreferredProviderId) {
                continue;
            }
            if (!candidate.ready) {
                attempted.push(candidate.providerId);
                continue;
            }
            const resolvedModel = this._reconcileModel(candidate, req.preferredModelId);
            return this._buildSuccess(
                candidate,
                `Waterfall selected ready provider '${candidate.providerId}'`,
                attempted.length > 0,
                attempted,
                resolvedModel,
            );
        }

        return this._buildFailure(attempted, 'No viable inference provider available', turnId, agentMode);
    }

    private _selectCloud(
        attempted: string[],
        _fallbackAllowed: boolean,
        turnId: string,
        agentMode: string,
        requiredCapability?: keyof import('../../../shared/inferenceProviderTypes').InferenceProviderCapabilities,
        requestedModel?: string,
        preferredProviderId?: string,
    ): InferenceSelectionResult {
        const candidates = this._buildWaterfallCandidates('cloud-only', requiredCapability, preferredProviderId);
        const cloud = candidates.find((c) => c.providerId === 'cloud');
        if (cloud && cloud.ready) {
            const resolvedModel = this._reconcileModel(cloud, requestedModel);
            return this._buildSuccess(cloud, 'Fallback to cloud provider', attempted.length > 0, attempted, resolvedModel);
        }
        if (cloud) attempted.push('cloud');

        return this._buildFailure(attempted, 'No viable inference provider available', turnId, agentMode);
    }

    private _buildWaterfallCandidates(
        mode: 'auto' | 'local-only' | 'cloud-only',
        requiredCapability?: keyof import('../../../shared/inferenceProviderTypes').InferenceProviderCapabilities,
        preferredProviderId?: string,
    ): InferenceProviderDescriptor[] {
        const allowedScopes = mode === 'cloud-only'
            ? new Set(['cloud'])
            : mode === 'local-only'
                ? new Set(['local', 'embedded'])
                : new Set(['local', 'embedded', 'cloud']);

        const all = this._getAll().filter((d) => {
            if (!allowedScopes.has(d.scope)) return false;
            return this._capOk(d, requiredCapability);
        });

        const rank = (providerId: string): number => {
            const idx = ProviderSelectionService.WATERFALL_ORDER.indexOf(providerId);
            return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
        };

        all.sort((a, b) => {
            const ra = rank(a.providerId);
            const rb = rank(b.providerId);
            if (ra !== rb) return ra - rb;
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.providerId.localeCompare(b.providerId);
        });

        if (!preferredProviderId) return all;

        const preferred = all.find((d) => d.providerId === preferredProviderId);
        if (!preferred) return all;
        return [preferred, ...all.filter((d) => d.providerId !== preferredProviderId)];
    }

    private _getAll(): InferenceProviderDescriptor[] {
        return this.registry.getInventory().providers;
    }

    private _capOk(
        desc: InferenceProviderDescriptor,
        cap?: keyof InferenceProviderDescriptor['capabilities'],
    ): boolean {
        if (!cap) return true;
        return !!desc.capabilities[cap];
    }

    private _buildSuccess(
        provider: InferenceProviderDescriptor,
        reason: string,
        fallbackApplied: boolean,
        attempted: string[],
        resolvedModel?: string,
    ): InferenceSelectionResult {
        telemetry.operational(
            'local_inference',
            'provider_selected',
            'info',
            'InferenceProviderSelectionService',
            `Provider selected: ${provider.displayName} - ${reason}`,
            'success',
            { payload: { providerId: provider.providerId, providerType: provider.providerType, fallbackApplied, reason, attemptedProviders: attempted } }
        );

        return {
            success: true,
            selectedProvider: provider,
            resolvedModel,
            reason,
            fallbackApplied,
            attemptedProviders: attempted,
            executionPath: `${provider.scope}/${provider.providerType}/${provider.endpoint}`,
        };
    }

    private _buildFailure(
        attempted: string[],
        message: string,
        turnId: string,
        agentMode: string,
    ): InferenceSelectionResult {
        const failure: InferenceFailureResult = {
            code: 'no_provider',
            message,
            attemptedProviders: attempted,
            fallbackExhausted: true,
        };

        telemetry.audit(
            'local_inference',
            'provider_unavailable',
            'InferenceProviderSelectionService',
            `Provider selection failed: ${message}`,
            'failure',
            { turnId, mode: agentMode, payload: { attempted, message } }
        );

        return {
            success: false,
            reason: message,
            fallbackApplied: attempted.length > 0,
            attemptedProviders: attempted,
            executionPath: 'none',
            failure,
        };
    }

    /**
     * Reconciles a requested model name against the live provider inventory.
     * Logic:
     * 1. If requestedModel exactly matches one in inventory -> use it.
     * 2. If requestedModel (e.g. 'llama3') matches if ':latest' is appended -> use that.
     * 3. Else if provider has models -> use first one.
     * 4. Else use provider's own preferredModel if it exists.
     * 5. Else return requestedModel as-is (best effort).
     */
    private _reconcileModel(provider: InferenceProviderDescriptor, requestedModel?: string): string | undefined {
        const availableModels = Array.isArray(provider.models) ? provider.models : [];
        const hasLiveInventory = availableModels.length > 0;

        if (!requestedModel) {
            if (!hasLiveInventory) return provider.preferredModel;
            if (provider.preferredModel && availableModels.includes(provider.preferredModel)) {
                return provider.preferredModel;
            }
            return availableModels[0];
        }

        if (availableModels.includes(requestedModel)) return requestedModel;

        const tagMatch = availableModels.find(m => m === `${requestedModel}:latest`);
        if (tagMatch) return tagMatch;

        const prefixMatch = availableModels.find(m => m.startsWith(`${requestedModel}:`) || m.startsWith(`${requestedModel}.`));
        if (prefixMatch) return prefixMatch;

        if (hasLiveInventory) {
            console.log(
                `[ModelSelection] preferred=${requestedModel} valid=false provider=${provider.providerId}`
            );
            return availableModels[0];
        }

        // No live inventory to validate against (e.g. provider does not enumerate models).
        return requestedModel || provider.preferredModel;
    }
}
