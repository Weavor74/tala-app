/**
 * RetrievalOrchestratorRegistry
 *
 * Singleton manager for the RetrievalOrchestrator instance used at runtime.
 *
 * Responsibilities:
 * - Hold the single RetrievalOrchestrator instance shared across IPC handlers.
 * - Wire LocalSearchProvider and ExternalApiSearchProvider on init.
 * - Provide a refreshExternalProvider() seam to re-register the external
 *   provider when settings change (e.g., after Settings apply-changes).
 *
 * Usage:
 *   import { initRetrievalOrchestrator, getRetrievalOrchestrator } from './RetrievalOrchestratorRegistry';
 *
 *   // During app startup (after file service and research repo are ready):
 *   await initRetrievalOrchestrator({ fileService, researchRepo, settingsPath });
 *
 *   // In IPC handlers:
 *   const orchestrator = getRetrievalOrchestrator();
 *   if (orchestrator) { ... }
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import { RetrievalOrchestrator } from './RetrievalOrchestrator';
import { LocalSearchProvider } from './providers/LocalSearchProvider';
import {
  ExternalApiSearchProvider,
  resolveActiveSearchProviderConfig,
} from './providers/ExternalApiSearchProvider';
import { SemanticSearchProvider } from './providers/SemanticSearchProvider';
import { loadSettings } from '../SettingsManager';
import type { FileService } from '../FileService';
import type { ResearchRepository } from '../db/ResearchRepository';
import type { EmbeddingsRepository } from '../db/EmbeddingsRepository';
import type { SearchConfig } from '../../../shared/settings';

let _orchestrator: RetrievalOrchestrator | null = null;
let _externalProvider: ExternalApiSearchProvider | null = null;

export interface InitRetrievalOrchestratorOptions {
  /** FileService instance for LocalSearchProvider. */
  fileService: FileService;
  /** Optional ResearchRepository for notebook scope resolution. */
  researchRepo?: ResearchRepository;
  /**
   * Optional EmbeddingsRepository for SemanticSearchProvider.
   * When provided, SemanticSearchProvider is registered with the orchestrator.
   */
  embeddingsRepo?: EmbeddingsRepository;
  /**
   * Path to the app_settings.json file.
   * Used to read the active external search provider configuration.
   */
  settingsPath: string;
}

/**
 * Initialize the singleton RetrievalOrchestrator and register all providers.
 * Safe to call multiple times — returns the existing instance if already initialized.
 */
export function initRetrievalOrchestrator(
  opts: InitRetrievalOrchestratorOptions,
): RetrievalOrchestrator {
  if (_orchestrator) {
    return _orchestrator;
  }

  const orchestrator = new RetrievalOrchestrator(opts.researchRepo);

  // Register local provider
  orchestrator.registerProvider(new LocalSearchProvider(opts.fileService));

  // Register semantic provider (if embeddings repository is available)
  if (opts.embeddingsRepo) {
    orchestrator.registerProvider(new SemanticSearchProvider(opts.embeddingsRepo));
    console.log('[RetrievalOrchestratorRegistry] Registered semantic provider.');
  } else {
    console.log(
      '[RetrievalOrchestratorRegistry] No EmbeddingsRepository provided; semantic provider not registered.',
    );
  }

  // Register external provider (if configured)
  const settings = tryLoadSettings(opts.settingsPath);
  const activeConfig = resolveActiveSearchProviderConfig(settings?.search);
  const externalProvider = new ExternalApiSearchProvider(activeConfig);
  _externalProvider = externalProvider;

  if (activeConfig) {
    orchestrator.registerProvider(externalProvider);
    console.log(
      `[RetrievalOrchestratorRegistry] Registered external provider: ${externalProvider.id}`,
    );
  } else {
    // Register with null config so it can be refreshed later without re-init
    // but don't actually wire it into the orchestrator until a provider is configured.
    console.log(
      '[RetrievalOrchestratorRegistry] No active external search provider configured; external provider not registered.',
    );
  }

  _orchestrator = orchestrator;
  console.log('[RetrievalOrchestratorRegistry] RetrievalOrchestrator initialized.');
  return orchestrator;
}

/**
 * Get the initialized RetrievalOrchestrator.
 * Returns null if initRetrievalOrchestrator() has not been called.
 */
export function getRetrievalOrchestrator(): RetrievalOrchestrator | null {
  return _orchestrator;
}

/**
 * Refresh the external search provider registration from current settings.
 *
 * Call this after the user applies settings changes that affect the Search tab.
 * The old external provider is unregistered and a new one registered if valid.
 */
export function refreshExternalProvider(settingsPath: string): void {
  if (!_orchestrator) return;

  const settings = tryLoadSettings(settingsPath);
  const activeConfig = resolveActiveSearchProviderConfig(settings?.search);

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

  if (activeConfig) {
    _orchestrator.registerProvider(_externalProvider);
    console.log(
      `[RetrievalOrchestratorRegistry] External provider refreshed: ${_externalProvider.id}`,
    );
  } else {
    console.log(
      '[RetrievalOrchestratorRegistry] No active external provider after refresh; external provider unregistered.',
    );
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
