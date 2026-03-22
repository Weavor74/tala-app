/**
 * RetrievalOrchestratorRegistry
 *
 * Singleton manager for the RetrievalOrchestrator instance used at runtime.
 */

import { RetrievalOrchestrator } from './RetrievalOrchestrator';
import { LocalSearchProvider } from './providers/LocalSearchProvider';
import {
  ExternalApiSearchProvider,
  resolveActiveSearchProviderConfig,
} from './providers/ExternalApiSearchProvider';
import { SemanticSearchProvider } from './providers/SemanticSearchProvider';
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

  // 2. External API search provider (if enabled by flags)
  const settings = tryLoadSettings(options.settingsPath);
  const activeConfig = resolveActiveSearchProviderConfig(settings?.search);
  
  _externalProvider = new ExternalApiSearchProvider(activeConfig);
  
  // We only wire it into the orchestrator if a provider is actually configured
  // AND the legacy search flag is enabled.
  if (activeConfig && RuntimeFlags.ENABLE_LEGACY_REMOTE_SEARCH) {
    _orchestrator.registerProvider(_externalProvider);
    console.log(`[RetrievalOrchestratorRegistry] Registered external provider: ${_externalProvider.id}`);
  } else {
    console.log('[RetrievalOrchestratorRegistry] External provider not registered (no config or flag disabled)');
  }

  // 3. Optional Semantic search provider (pgvector)
  if (options.embeddingsRepo) {
    _orchestrator.registerProvider(
      new SemanticSearchProvider(options.embeddingsRepo),
    );
    console.log('[RetrievalOrchestratorRegistry] Registered semantic provider.');
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
 * P7E enhancement: uses loadSettings() to ensure we have the latest config state.
 */
export function refreshExternalProvider(settings?: SearchConfig): void {
  if (!_orchestrator) return;

  const effectiveSettings = settings ?? (loadSettings(_settingsPath || '').search as SearchConfig);
  const activeConfig = resolveActiveSearchProviderConfig(effectiveSettings);

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
  }
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
