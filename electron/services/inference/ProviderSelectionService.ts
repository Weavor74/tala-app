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
                return this._buildSuccess(preferred, `User-selected provider '${preferredProviderId}' is ready`, false, attempted);
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
        const localResult = this._selectLocalOrEmbedded(attempted, true, turnId, agentMode, requiredCapability);
        if (localResult.success) return localResult;

        return this._selectCloud(attempted, fallbackAllowed, turnId, agentMode, requiredCapability);
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
    ): InferenceSelectionResult {
        // Local providers (scope = 'local'), sorted by priority
        const localProviders = Array.from(
            this._getAll()
                .filter(d => d.scope === 'local' && d.ready && this._capOk(d, requiredCapability))
        ).sort((a, b) => a.priority - b.priority);

        if (localProviders.length > 0) {
            const chosen = localProviders[0];
            return this._buildSuccess(chosen, `Best available local provider '${chosen.providerId}'`, attempted.length > 0, attempted);
        }
        for (const d of this._getAll().filter(s => s.scope === 'local')) attempted.push(d.providerId);

        // Embedded llama.cpp fallback
        const embedded = this.registry.getProvider('embedded_llamacpp');
        if (embedded && embedded.ready && this._capOk(embedded, requiredCapability)) {
            return this._buildSuccess(embedded, 'Fallback to embedded llama.cpp', attempted.length > 0, attempted);
        }
        if (embedded) attempted.push('embedded_llamacpp');

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
    ): InferenceSelectionResult {
        const cloud = this.registry.getProvider('cloud');
        if (cloud && cloud.ready && this._capOk(cloud, requiredCapability)) {
            return this._buildSuccess(cloud, 'Fallback to cloud provider', attempted.length > 0, attempted);
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
}
