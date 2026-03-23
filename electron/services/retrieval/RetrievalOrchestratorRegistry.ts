/**
 * RetrievalOrchestratorRegistry
 *
 * Singleton manager for the RetrievalOrchestrator instance used at runtime.
 */

import { RetrievalOrchestrator } from './RetrievalOrchestrator';
import { LocalSearchProvider } from './providers/LocalSearchProvider';
import {
  ExternalApiSearchProvider,
  resolveCuratedSearchProviderConfig,
  canonicalizeProviderId,
} from './providers/ExternalApiSearchProvider';
import { SemanticSearchProvider } from './providers/SemanticSearchProvider';
import { DuckDuckGoSearchProvider } from './providers/DuckDuckGoSearchProvider';
import { loadSettings } from '../SettingsManager';
import { RuntimeFlags } from '../RuntimeFlags';
import type { FileService } from '../FileService';
import type { ResearchRepository } from '../db/ResearchRepository';
import type { EmbeddingsRepository } from '../db/EmbeddingsRepository';
import type { SearchConfig } from '../../../shared/settings';

let _orchestrator: RetrievalOrchestrator | null = null;
let _externalProvider: ExternalApiSearchProvider | null = null;
let _settingsPath: string | null = null;

export interface InitRetrievalOrchestratorOptions {
  /** FileService instance for LocalSearchProvider. */
  fileService: FileService;
  /** Optional ResearchRepository for notebook scope resolution. */
  researchRepo?: ResearchRepository;
  /**
   * Optional EmbeddingsRepository for SemanticSearchProvider.
   */
  embeddingsRepo?: EmbeddingsRepository;
  /**
   * Path to the app_settings.json file, used by ExternalApiSearchProvider.
   */
  settingsPath: string;
}

/**
 * Initialize the singleton RetrievalOrchestrator.
 * Must be called exactly once during app startup.
 */
export function initRetrievalOrchestrator(
  options: InitRetrievalOrchestratorOptions,
): RetrievalOrchestrator {
  if (_orchestrator) return _orchestrator;

  const orchestrator = new RetrievalOrchestrator(options.researchRepo);
  _orchestrator = orchestrator;
  _settingsPath = options.settingsPath;

  // 1. Local search provider (always present)
  _orchestrator.registerProvider(new LocalSearchProvider(options.fileService));

  // 2. External API search provider (if configured and flag enabled)
  const settings = tryLoadSettings(options.settingsPath);
  const activeConfig = resolveCuratedSearchProviderConfig(settings?.search);

  _externalProvider = new ExternalApiSearchProvider(activeConfig);

  if (activeConfig && RuntimeFlags.ENABLE_LEGACY_REMOTE_SEARCH) {
    _orchestrator.registerProvider(_externalProvider);
    console.log(`[RetrievalOrchestratorRegistry] Registered external provider: ${_externalProvider.id}`);
  } else if (!activeConfig) {
    console.log('[RetrievalOrchestratorRegistry] External provider not registered: no configured provider in settings');
  } else {
    console.log('[RetrievalOrchestratorRegistry] External provider not registered: ENABLE_LEGACY_REMOTE_SEARCH=false');
  }

  // 3. Optional Semantic search provider (pgvector)
  if (options.embeddingsRepo) {
    _orchestrator.registerProvider(
      new SemanticSearchProvider(options.embeddingsRepo),
    );
    console.log('[RetrievalOrchestratorRegistry] Registered semantic provider.');
  }

  // 4. DuckDuckGo search provider (zero-config fallback)
  if (RuntimeFlags.ENABLE_DUCKDUCKGO_SEARCH) {
    _orchestrator.registerProvider(new DuckDuckGoSearchProvider());
    console.log('[RetrievalOrchestratorRegistry] Registered DuckDuckGo provider.');
  }

  return _orchestrator;
}

/**
 * Get the singleton RetrievalOrchestrator instance.
 */
export function getRetrievalOrchestrator(): RetrievalOrchestrator | null {
  return _orchestrator;
}

/**
 * Re-registers the ExternalApiSearchProvider with updated settings.
 * Uses curatedSearchProviderId from settings to select the canonical provider.
 */
export function refreshExternalProvider(settings?: SearchConfig): void {
  if (!_orchestrator) return;

  const effectiveSettings = settings ?? (loadSettings(_settingsPath || '').search as SearchConfig);
  const activeConfig = resolveCuratedSearchProviderConfig(effectiveSettings);

  // Unregister all previously registered external providers
  const providers = _orchestrator.listProviders();
  for (const p of providers) {
    if (p.id.startsWith('external:')) {
      _orchestrator.unregisterProvider(p.id);
    }
  }

  if (_externalProvider) {
    _externalProvider.refreshFromSettings(activeConfig);
  } else {
    _externalProvider = new ExternalApiSearchProvider(activeConfig);
  }

  if (activeConfig && RuntimeFlags.ENABLE_LEGACY_REMOTE_SEARCH) {
    _orchestrator.registerProvider(_externalProvider);
    console.log(`[RetrievalOrchestratorRegistry] External provider refreshed: ${_externalProvider.id}`);
  } else if (!activeConfig) {
    console.log('[RetrievalOrchestratorRegistry] External provider refresh: no configured provider — external search disabled');
  }
}

/**
 * Get the currently selected curated search provider ID from settings.
 * Returns 'duckduckgo' as the fallback if nothing is configured.
 */
export function getCuratedSearchProviderId(settingsPath?: string): string {
  const path = settingsPath ?? _settingsPath ?? '';
  if (!path) return 'duckduckgo';
  try {
    const s = loadSettings(path);
    const search = s.search as SearchConfig | undefined;
    if (!search) return 'duckduckgo';

    const curatedId = search.curatedSearchProviderId || search.activeProviderId || '';
    return canonicalizeProviderId(curatedId) || 'duckduckgo';
  } catch {
    return 'duckduckgo';
  }
}

/**
 * Returns metadata about available curated search providers for the UI dropdown.
 * Includes configured and unconfigured providers with availability status.
 */
export function getAvailableCuratedProviders(settingsPath?: string): Array<{
  providerId: string;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  reasonUnavailable?: string;
}> {
  const path = settingsPath ?? _settingsPath ?? '';
  const result: ReturnType<typeof getAvailableCuratedProviders> = [
    // DuckDuckGo is always available (no API key needed)
    { providerId: 'duckduckgo', displayName: 'DuckDuckGo (no API key)', configured: true, enabled: true },
  ];

  if (!path) return result;

  try {
    const s = loadSettings(path);
    const providers = (s.search?.providers ?? []) as Array<{
      id: string; name: string; type: string; enabled: boolean; apiKey?: string; endpoint?: string;
    }>;

    for (const p of providers) {
      const canonicalId = canonicalizeProviderId(p.id);
      const hasKey = !!(p.apiKey && p.apiKey.trim().length > 0);
      const needsKey = p.type !== 'custom' || !p.endpoint;
      const configured = hasKey || (p.type === 'rest' && !!p.endpoint);

      result.push({
        providerId: canonicalId,
        displayName: p.name,
        configured,
        enabled: p.enabled && configured,
        reasonUnavailable: !p.enabled
          ? 'Provider disabled in settings'
          : !configured && needsKey
          ? 'API key not configured'
          : undefined,
      });
    }
  } catch {
    // Return at minimum DuckDuckGo
  }

  return result;
}

/**
 * Reset the singleton (used in tests).
 */
export function resetRetrievalOrchestrator(): void {
  _orchestrator = null;
  _externalProvider = null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryLoadSettings(settingsPath: string): { search?: SearchConfig } | null {
  try {
    return loadSettings(settingsPath) as { search?: SearchConfig };
  } catch {
    return null;
  }
}
