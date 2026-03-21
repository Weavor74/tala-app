/**
 * ExternalApiSearchProvider
 *
 * Reads the active/enabled search provider configuration from the Settings
 * model (shared/settings.ts → SearchConfig) and performs external API search
 * via HTTP, normalizing results into NormalizedSearchResult.
 *
 * Design goals:
 * - Generic adapter: supports all SearchProvider.type values defined in settings
 *   (google, brave, serper, tavily, custom, rest) through a shared REST request
 *   shape, with per-type response mapping.
 * - Fail gracefully: network/config errors are captured and returned as
 *   SearchProviderResult.error; the orchestrator emits warnings, UI is unaffected.
 * - Stable providerId: 'external:<settingsProviderId>' e.g. 'external:google'
 * - Source metadata preserved in NormalizedSearchResult.metadata.
 *
 * TODO (refresh-on-settings-apply): Currently reads settings at construction
 * time. When the Settings apply-changes event is wired through a settings
 * reload bus, call refreshFromSettings() to pick up the new active provider
 * without restarting the application.
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import https from 'https';
import http from 'http';
import type {
  SearchProvider,
  SearchProviderResult,
  NormalizedSearchResult,
  RetrievalScopeResolved,
  RetrievalProviderOptions,
  RetrievalMode,
} from '../../../../shared/retrieval/retrievalTypes';
import type { SearchProvider as SettingsSearchProvider } from '../../../../shared/settings';

// ─── Generic external result shape ───────────────────────────────────────────

/**
 * Minimum shape that all per-type response adapters must produce before being
 * normalized into NormalizedSearchResult.
 */
interface AdaptedExternalResult {
  title: string;
  uri: string;
  snippet: string | null;
  externalId: string | null;
  metadata: Record<string, unknown>;
}

// ─── Provider response adapters ───────────────────────────────────────────────

/**
 * Adapt a raw JSON response from a Serper-compatible API (Google via serper.dev).
 * Response: { organic: [{title, link, snippet}] }
 */
function adaptSerperResponse(json: unknown): AdaptedExternalResult[] {
  const data = json as Record<string, unknown>;
  const organic = (data['organic'] as unknown[]) ?? [];
  return organic.map((item: unknown, i: number) => {
    const r = item as Record<string, unknown>;
    return {
      title: String(r['title'] ?? ''),
      uri: String(r['link'] ?? ''),
      snippet: r['snippet'] != null ? String(r['snippet']) : null,
      externalId: String(r['position'] ?? i),
      metadata: { source: 'serper', position: r['position'] ?? i },
    };
  });
}

/**
 * Adapt a raw JSON response from the Brave Search API.
 * Response: { web: { results: [{title, url, description}] } }
 */
function adaptBraveResponse(json: unknown): AdaptedExternalResult[] {
  const data = json as Record<string, unknown>;
  const web = data['web'] as Record<string, unknown> | undefined;
  const results = (web?.['results'] as unknown[]) ?? [];
  return results.map((item: unknown, i: number) => {
    const r = item as Record<string, unknown>;
    return {
      title: String(r['title'] ?? ''),
      uri: String(r['url'] ?? ''),
      snippet: r['description'] != null ? String(r['description']) : null,
      externalId: String(i),
      metadata: { source: 'brave' },
    };
  });
}

/**
 * Adapt a raw JSON response from the Tavily Search API.
 * Response: { results: [{title, url, content, score}] }
 */
function adaptTavilyResponse(json: unknown): AdaptedExternalResult[] {
  const data = json as Record<string, unknown>;
  const results = (data['results'] as unknown[]) ?? [];
  return results.map((item: unknown, i: number) => {
    const r = item as Record<string, unknown>;
    return {
      title: String(r['title'] ?? ''),
      uri: String(r['url'] ?? ''),
      snippet: r['content'] != null ? String(r['content']) : null,
      externalId: String(i),
      metadata: { source: 'tavily', score: r['score'] ?? null },
    };
  });
}

/**
 * Adapt a generic REST/custom API response.
 * Expected shape: an array of objects with at least title + url/uri fields.
 * Also handles a { results: [...] } wrapper.
 */
function adaptGenericResponse(json: unknown): AdaptedExternalResult[] {
  let items: unknown[] = [];
  if (Array.isArray(json)) {
    items = json;
  } else if (json && typeof json === 'object') {
    const data = json as Record<string, unknown>;
    if (Array.isArray(data['results'])) items = data['results'] as unknown[];
    else if (Array.isArray(data['items'])) items = data['items'] as unknown[];
    else if (Array.isArray(data['data'])) items = data['data'] as unknown[];
  }
  return items.map((item: unknown, i: number) => {
    const r = (item ?? {}) as Record<string, unknown>;
    return {
      title: String(r['title'] ?? r['name'] ?? ''),
      uri: String(r['url'] ?? r['uri'] ?? r['link'] ?? ''),
      snippet:
        r['snippet'] != null
          ? String(r['snippet'])
          : r['description'] != null
          ? String(r['description'])
          : r['content'] != null
          ? String(r['content'])
          : null,
      externalId: r['id'] != null ? String(r['id']) : String(i),
      metadata: { source: 'custom', raw: r },
    };
  });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

interface HttpRequestOptions {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

function doHttpRequest(opts: HttpRequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(opts.url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      method: opts.method,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: opts.headers,
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });

    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(new Error(`External search request timed out after ${opts.timeoutMs}ms`));
      });
    }

    req.on('error', reject);

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

// ─── Main provider ────────────────────────────────────────────────────────────

export class ExternalApiSearchProvider implements SearchProvider {
  readonly supportedModes: RetrievalMode[] = ['keyword', 'hybrid'];

  private _id: string;
  private _config: SettingsSearchProvider | null;

  constructor(config: SettingsSearchProvider | null) {
    this._config = config;
    this._id = config ? `external:${config.id}` : 'external:unconfigured';
  }

  get id(): string {
    return this._id;
  }

  /**
   * Refresh the provider configuration at runtime (e.g., after settings apply).
   * Caller should unregister + re-register with the orchestrator when the
   * active provider changes.
   */
  refreshFromSettings(config: SettingsSearchProvider | null): void {
    this._config = config;
    this._id = config ? `external:${config.id}` : 'external:unconfigured';
  }

  async search(
    query: string,
    _scope: RetrievalScopeResolved,
    options: RetrievalProviderOptions,
  ): Promise<SearchProviderResult> {
    const startMs = Date.now();

    if (!this._config) {
      return {
        providerId: this._id,
        results: [],
        durationMs: 0,
        error: 'ExternalApiSearchProvider: no search provider configured in Settings.',
      };
    }

    if (!this._config.enabled) {
      return {
        providerId: this._id,
        results: [],
        durationMs: 0,
        error: `ExternalApiSearchProvider: provider "${this._config.id}" is disabled.`,
      };
    }

    try {
      const adapted = await this._executeSearch(query, this._config);
      const topK = options.topK;
      const limited = topK != null ? adapted.slice(0, topK) : adapted;

      const results: NormalizedSearchResult[] = limited.map((r, i) => ({
        // Prefer stable URI-based key; fall back to externalId; use title-hash as last resort
        // to avoid position-based keys that change across searches for the same result.
        itemKey: `${this._id}:${r.uri || (r.externalId ? `id:${r.externalId}` : `title:${r.title.toLowerCase().replace(/\s+/g, '-').slice(0, 64)}`) || String(i)}`,
        title: r.title,
        uri: r.uri || null,
        sourcePath: null,
        snippet: r.snippet,
        sourceType: 'web',
        providerId: this._id,
        externalId: r.externalId,
        contentHash: null,
        score: null,
        metadata: {
          ...r.metadata,
          providerType: this._config?.type,
          providerName: this._config?.name,
          endpoint: this._config?.endpoint,
        },
      }));

      return {
        providerId: this._id,
        results,
        durationMs: Date.now() - startMs,
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        providerId: this._id,
        results: [],
        durationMs: Date.now() - startMs,
        error: `ExternalApiSearchProvider (${this._config.id}): ${msg}`,
      };
    }
  }

  // ─── Per-type execution ─────────────────────────────────────────────────────

  private async _executeSearch(
    query: string,
    cfg: SettingsSearchProvider,
  ): Promise<AdaptedExternalResult[]> {
    switch (cfg.type) {
      case 'serper':
      case 'google':
        return this._searchSerper(query, cfg);

      case 'brave':
        return this._searchBrave(query, cfg);

      case 'tavily':
        return this._searchTavily(query, cfg);

      case 'custom':
      case 'rest':
      default:
        return this._searchGenericRest(query, cfg);
    }
  }

  /** Serper / Google-via-Serper: POST https://google.serper.dev/search */
  private async _searchSerper(
    query: string,
    cfg: SettingsSearchProvider,
  ): Promise<AdaptedExternalResult[]> {
    const endpoint = cfg.endpoint ?? 'https://google.serper.dev/search';
    const body = JSON.stringify({ q: query });
    const raw = await doHttpRequest({
      method: 'POST',
      url: endpoint,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': cfg.apiKey ?? '',
      },
      body,
      timeoutMs: 10000,
    });
    return adaptSerperResponse(JSON.parse(raw));
  }

  /** Brave Search API: GET https://api.search.brave.com/res/v1/web/search */
  private async _searchBrave(
    query: string,
    cfg: SettingsSearchProvider,
  ): Promise<AdaptedExternalResult[]> {
    const base = cfg.endpoint ?? 'https://api.search.brave.com/res/v1/web/search';
    const url = `${base}?q=${encodeURIComponent(query)}`;
    const raw = await doHttpRequest({
      method: 'GET',
      url,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'X-Subscription-Token': cfg.apiKey ?? '',
      },
      timeoutMs: 10000,
    });
    return adaptBraveResponse(JSON.parse(raw));
  }

  /** Tavily Search API: POST https://api.tavily.com/search */
  private async _searchTavily(
    query: string,
    cfg: SettingsSearchProvider,
  ): Promise<AdaptedExternalResult[]> {
    const endpoint = cfg.endpoint ?? 'https://api.tavily.com/search';
    const body = JSON.stringify({ api_key: cfg.apiKey ?? '', query });
    const raw = await doHttpRequest({
      method: 'POST',
      url: endpoint,
      headers: { 'Content-Type': 'application/json' },
      body,
      timeoutMs: 10000,
    });
    return adaptTavilyResponse(JSON.parse(raw));
  }

  /**
   * Generic REST / custom provider.
   * Attempts GET first with query as ?q= parameter.
   * If the provider requires POST, the endpoint should be configured
   * to accept GET or the adapter extended.
   */
  private async _searchGenericRest(
    query: string,
    cfg: SettingsSearchProvider,
  ): Promise<AdaptedExternalResult[]> {
    if (!cfg.endpoint) {
      throw new Error(`Custom/REST search provider "${cfg.id}" has no endpoint configured.`);
    }
    const sep = cfg.endpoint.includes('?') ? '&' : '?';
    const url = `${cfg.endpoint}${sep}q=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    const raw = await doHttpRequest({
      method: 'GET',
      url,
      headers,
      timeoutMs: 10000,
    });
    return adaptGenericResponse(JSON.parse(raw));
  }
}

// ─── Factory helper ───────────────────────────────────────────────────────────

/**
 * Resolve the active, enabled SearchProvider from the settings search config.
 * Returns null if no active/enabled provider is found.
 */
export function resolveActiveSearchProviderConfig(
  searchConfig: { activeProviderId: string; providers: SettingsSearchProvider[] } | undefined,
): SettingsSearchProvider | null {
  if (!searchConfig?.providers?.length) return null;
  const active = searchConfig.providers.find(
    p => p.id === searchConfig.activeProviderId && p.enabled,
  );
  return active ?? null;
}
