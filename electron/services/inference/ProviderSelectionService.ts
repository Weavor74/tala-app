/**
 * ProviderSelectionService
 *
 * Implements the deterministic provider selection and fallback policy.
 *
 * Selection order:
 *   1. User-selected provider if explicitly set and ready
 *   2. If selected provider is unavailable → apply fallback (emit telemetry)
 *   3. If no selection → best available local provider (by priority)
 *   4. If no local provider → embedded llama.cpp if available
 *   5. If embedded unavailable → configured cloud provider
 *   6. If nothing viable → explicit InferenceFailureResult
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

    /**
     * Selects the best available provider according to the deterministic policy.
     * Always returns a result — success=false when no provider is viable.
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

        // ── Step 1: cloud-only mode ─────────────────────────────────────────
        if (mode === 'cloud-only') {
            return this._selectCloud(attempted, fallbackAllowed, turnId, agentMode, requiredCapability);
        }

        // ── Step 2: explicit user selection ────────────────────────────────
        if (preferredProviderId) {
            attempted.push(preferredProviderId);
            const preferred = this.registry.getProvider(preferredProviderId);
            if (preferred && preferred.ready && this._capOk(preferred, requiredCapability)) {
                const resolvedModel = this._reconcileModel(preferred, req.preferredModelId);
                return this._buildSuccess(preferred, `User-selected provider '${preferredProviderId}' is ready`, false, attempted, resolvedModel);
            }

            if (!fallbackAllowed) {
                return this._buildFailure(
                    attempted,
                    `Selected provider '${preferredProviderId}' is unavailable and fallback is disabled`,
                    turnId,
                    agentMode,
                );
            }

            // Emit fallback telemetry
            const reason = preferred
                ? `Provider '${preferredProviderId}' not ready (status: ${preferred.status})`
                : `Provider '${preferredProviderId}' not found in registry`;

            telemetry.audit(
                'local_inference',
                'provider_fallback_applied',
                'InferenceProviderSelectionService',
                `Fallback triggered: ${reason}`,
                'partial',
                { turnId, mode: agentMode, payload: { preferredProviderId, reason, attempted } }
            );
        }

        // ── Step 3: local-only mode ─────────────────────────────────────────
        if (mode === 'local-only') {
            return this._selectLocalOrEmbedded(attempted, fallbackAllowed, turnId, agentMode, requiredCapability);
        }

        // ── Step 4: auto — prefer local/embedded before cloud ───────────────
        const localResult = this._selectLocalOrEmbedded(attempted, true, turnId, agentMode, requiredCapability, req.preferredModelId);
        if (localResult.success) return localResult;

        return this._selectCloud(attempted, fallbackAllowed, turnId, agentMode, requiredCapability, req.preferredModelId);
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    private _selectLocalOrEmbedded(
        attempted: string[],
        fallbackAllowed: boolean,
        turnId: string,
        agentMode: string,
        requiredCapability?: keyof import('../../../shared/inferenceProviderTypes').InferenceProviderCapabilities,
        requestedModel?: string,
    ): InferenceSelectionResult {
        // Local providers (scope = 'local'), sorted by priority
        const localProviders = Array.from(
            this._getAll()
                .filter(d => d.scope === 'local' && d.ready && this._capOk(d, requiredCapability))
        ).sort((a, b) => a.priority - b.priority);

        if (localProviders.length > 0) {
            const chosen = localProviders[0];
            const resolvedModel = this._reconcileModel(chosen, requestedModel);
            return this._buildSuccess(chosen, `Best available local provider '${chosen.providerId}'`, attempted.length > 0, attempted, resolvedModel);
        }
        for (const d of this._getAll().filter(s => s.scope === 'local')) attempted.push(d.providerId);

        // Embedded providers (scope = 'embedded'), sorted by priority.
        // Includes embedded_vllm (priority 28) and embedded_llamacpp (priority 30).
        const embeddedProviders = Array.from(
            this._getAll()
                .filter(d => d.scope === 'embedded' && d.ready && this._capOk(d, requiredCapability))
        ).sort((a, b) => a.priority - b.priority);

        if (embeddedProviders.length > 0) {
            const chosen = embeddedProviders[0];
            const resolvedModel = this._reconcileModel(chosen, requestedModel);
            return this._buildSuccess(chosen, `Fallback to embedded provider '${chosen.providerId}'`, attempted.length > 0, attempted, resolvedModel);
        }
        for (const d of this._getAll().filter(s => s.scope === 'embedded')) attempted.push(d.providerId);

        if (!fallbackAllowed) {
            return this._buildFailure(attempted, 'No local or embedded provider available and fallback disabled', turnId, agentMode);
        }

        return this._buildFailure(attempted, 'No local or embedded provider available', turnId, agentMode);
    }

    private _selectCloud(
        attempted: string[],
        _fallbackAllowed: boolean,
        turnId: string,
        agentMode: string,
        requiredCapability?: keyof import('../../../shared/inferenceProviderTypes').InferenceProviderCapabilities,
        requestedModel?: string,
    ): InferenceSelectionResult {
        const cloud = this.registry.getProvider('cloud');
        if (cloud && cloud.ready && this._capOk(cloud, requiredCapability)) {
            const resolvedModel = this._reconcileModel(cloud, requestedModel);
            return this._buildSuccess(cloud, 'Fallback to cloud provider', attempted.length > 0, attempted, resolvedModel);
        }
        if (cloud) attempted.push('cloud');

        return this._buildFailure(attempted, 'No viable inference provider available', turnId, agentMode);
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
            `Provider selected: ${provider.displayName} — ${reason}`,
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
        if (!requestedModel && provider.preferredModel) return provider.preferredModel;
        if (!requestedModel) return provider.models[0];

        // 1. Exact match
        if (provider.models.includes(requestedModel)) return requestedModel;

        // 2. Tag fuzzy match (requested 'llama3' -> match 'llama3:latest')
        const tagMatch = provider.models.find(m => m === `${requestedModel}:latest`);
        if (tagMatch) return tagMatch;

        // 3. Prefix match (requested 'llama3' -> match 'llama3.1:latest')
        const prefixMatch = provider.models.find(m => m.startsWith(`${requestedModel}:`) || m.startsWith(`${requestedModel}.`));
        if (prefixMatch) return prefixMatch;

        // 4. Default to first available if inventory exists
        if (provider.models.length > 0) return provider.models[0];

        // 5. Fallback to selection request or descriptor preference
        return requestedModel || provider.preferredModel;
    }
}
