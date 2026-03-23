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
 * - Fail loudly with structured errors: network/config/parse errors throw
 *   ExternalSearchProviderError with a phase tag so they are visible in logs
 *   and diagnostics. Silent 0-result returns only occur on valid empty responses.
 * - Stable providerId: 'external:<settingsProviderId>' e.g. 'external:brave'
 * - Source metadata preserved in NormalizedSearchResult.metadata.
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

// ─── Structured error type ────────────────────────────────────────────────────

export type ExternalSearchPhase = 'config' | 'request' | 'response' | 'parse' | 'normalize';

export class ExternalSearchProviderError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly phase: ExternalSearchPhase,
    message: string,
    public readonly statusCode?: number,
    public readonly responsePreview?: string,
    public readonly cause?: unknown,
  ) {
    super(`[${providerId}][${phase}] ${message}`);
    this.name = 'ExternalSearchProviderError';
  }
}

// ─── Phase 2 Hardening: Cache & Health Tracking ───────────────────────────────

class InMemorySearchCache {
  private cache = new Map<string, { results: NormalizedSearchResult[], expiry: number }>();
  
  get(providerId: string, query: string): NormalizedSearchResult[] | null {
    const key = `${providerId}:${query}`;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.results;
  }
  
  set(providerId: string, query: string, results: NormalizedSearchResult[]) {
    const key = `${providerId}:${query}`;
    this.cache.set(key, { results, expiry: Date.now() + 120000 }); // 120s TTL
  }

  clear() {
    this.cache.clear();
  }
}

export const providerCache = new InMemorySearchCache();

export class ProviderHealthTracker {
  private status = new Map<string, { successCount: number, failureCount: number, consecutiveFailures: number, lastFailureTimestamp: number }>();

  private getOrCreate(providerId: string) {
    if (!this.status.has(providerId)) {
      this.status.set(providerId, { successCount: 0, failureCount: 0, consecutiveFailures: 0, lastFailureTimestamp: 0 });
    }
    return this.status.get(providerId)!;
  }

  recordSuccess(providerId: string) {
    const stats = this.getOrCreate(providerId);
    stats.successCount++;
    stats.consecutiveFailures = 0;
  }

  recordFailure(providerId: string) {
    const stats = this.getOrCreate(providerId);
    stats.failureCount++;
    stats.consecutiveFailures++;
    stats.lastFailureTimestamp = Date.now();
  }

  isDegraded(providerId: string): boolean {
    return this.getOrCreate(providerId).consecutiveFailures >= 3;
  }

  getStats(providerId: string) {
    return this.getOrCreate(providerId);
  }

  resetAll() {
    this.status.clear();
  }
}

export const providerHealthTracker = new ProviderHealthTracker();

// ─── Phase 2 Hardening: Strict Validation ─────────────────────────────────────

export function validateNormalizedResults(providerId: string, results: NormalizedSearchResult[]): NormalizedSearchResult[] {
  if (results.length === 0) return results;
  const valid: NormalizedSearchResult[] = [];
  let invalidCount = 0;

  for (const r of results) {
    if (!r.title || typeof r.title !== 'string' || r.title.trim() === '') {
      invalidCount++;
      continue;
    }
    if (!r.uri || typeof r.uri !== 'string' || !r.uri.startsWith('http')) {
      invalidCount++;
      continue;
    }
    if (r.snippet && typeof r.snippet !== 'string') {
      invalidCount++;
      continue;
    }
    valid.push(r);
  }

  if (invalidCount > 0) {
    console.log(`[ExternalSearch][${providerId}] Dropped ${invalidCount} invalid results during normalization`);
  }

  if (results.length > 0 && invalidCount / results.length > 0.5) {
    throw new ExternalSearchProviderError(
      providerId,
      'normalize',
      `More than 50% of results (${invalidCount}/${results.length}) were invalid (missing title or valid URI).`
    );
  }

  return valid;
}

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
function adaptSerperResponse(providerId: string, json: unknown): AdaptedExternalResult[] {
  if (!json || typeof json !== 'object') {
    throw new ExternalSearchProviderError(providerId, 'parse', 'Serper response is not an object');
  }
  const data = json as Record<string, unknown>;
  const organic = data['organic'];
  if (!Array.isArray(organic)) {
    throw new ExternalSearchProviderError(
      providerId,
      'normalize',
      `Serper response missing "organic" array; got keys: ${Object.keys(data).join(', ')}`,
      undefined,
      JSON.stringify(data).slice(0, 200),
    );
  }
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
function adaptBraveResponse(providerId: string, json: unknown): AdaptedExternalResult[] {
  if (!json || typeof json !== 'object') {
    throw new ExternalSearchProviderError(providerId, 'parse', 'Brave response is not an object');
  }
  const data = json as Record<string, unknown>;
  const web = data['web'] as Record<string, unknown> | undefined;

  if (!web || typeof web !== 'object') {
    throw new ExternalSearchProviderError(
      providerId,
      'normalize',
      `Brave response missing "web" object; got top-level keys: ${Object.keys(data).join(', ')}`,
      undefined,
      JSON.stringify(data).slice(0, 300),
    );
  }

  const results = web['results'];
  if (!Array.isArray(results)) {
    // web.results being absent/empty is a valid "no results" case only if
    // the web object itself is present. Log it but don't error.
    console.warn(`[ExternalApiSearchProvider][${providerId}] Brave web.results is not an array — returning 0 results (valid empty response)`);
    return [];
  }

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
function adaptTavilyResponse(providerId: string, json: unknown): AdaptedExternalResult[] {
  if (!json || typeof json !== 'object') {
    throw new ExternalSearchProviderError(providerId, 'parse', 'Tavily response is not an object');
  }
  const data = json as Record<string, unknown>;
  const results = data['results'];
  if (!Array.isArray(results)) {
    throw new ExternalSearchProviderError(
      providerId,
      'normalize',
      `Tavily response missing "results" array; got keys: ${Object.keys(data).join(', ')}`,
      undefined,
      JSON.stringify(data).slice(0, 200),
    );
  }
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
function adaptGenericResponse(providerId: string, json: unknown): AdaptedExternalResult[] {
  let items: unknown[] = [];
  if (Array.isArray(json)) {
    items = json;
  } else if (json && typeof json === 'object') {
    const data = json as Record<string, unknown>;
    if (Array.isArray(data['results'])) items = data['results'] as unknown[];
    else if (Array.isArray(data['items'])) items = data['items'] as unknown[];
    else if (Array.isArray(data['data'])) items = data['data'] as unknown[];
    else {
      throw new ExternalSearchProviderError(
        providerId,
        'normalize',
        `Generic REST response has no recognizable results array; keys: ${Object.keys(data).join(', ')}`,
        undefined,
        JSON.stringify(data).slice(0, 200),
      );
    }
  } else {
    throw new ExternalSearchProviderError(providerId, 'parse', 'Generic REST response is not an object or array');
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
  signal?: AbortSignal;
}

interface HttpResponse {
  statusCode: number;
  body: string;
}

export async function doHttpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
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
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
    });

    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy();
        return reject(new Error('AbortError'));
      }
      opts.signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('AbortError'));
      });
    }

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
      console.warn(`[ExternalSearch][${this._id}] FAIL phase=config (not configured)`);
      return {
        providerId: this._id,
        results: [],
        durationMs: 0,
        error: '[config] ExternalApiSearchProvider: no search provider configured in Settings.',
      };
    }

    if (!this._config.enabled) {
      console.warn(`[ExternalSearch][${this._id}] FAIL phase=config (disabled)`);
      return {
        providerId: this._id,
        results: [],
        durationMs: 0,
        error: `[config] ExternalApiSearchProvider: provider "${this._config.id}" is disabled.`,
      };
    }

    // Phase 2: Check Caching
    const cached = providerCache.get(this._id, query);
    if (cached) {
      const limited = options.topK != null ? cached.slice(0, options.topK) : cached;
      console.log(`[ExternalSearch][${this._id}] OK ${limited.length} results in 0ms (cached)`);
      return {
        providerId: this._id,
        results: limited,
        durationMs: 0,
        error: null,
      };
    }

    // Phase 2: AbortController with 8s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const adapted = await this._executeSearch(query, this._config, controller.signal);
      clearTimeout(timeoutId);

      const topK = options.topK;
      const limited = topK != null ? adapted.slice(0, topK) : adapted;

      let results: NormalizedSearchResult[] = limited.map((r, i) => ({
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

      // Phase 2: Strict Result Validation
      results = validateNormalizedResults(this._id, results);

      const durationMs = Date.now() - startMs;
      
      if (results.length > 0) {
        console.log(`[ExternalSearch][${this._id}] OK ${results.length} results in ${durationMs}ms`);
        providerCache.set(this._id, query, results);
      } else {
        console.log(`[ExternalSearch][${this._id}] EMPTY 0 results in ${durationMs}ms`);
      }

      providerHealthTracker.recordSuccess(this._id);

      return {
        providerId: this._id,
        results,
        durationMs,
        error: null,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startMs;
      providerHealthTracker.recordFailure(this._id);

      // Phase 2: Normalize timeout errors
      if (err instanceof Error && err.message === 'AbortError') {
        const timeoutErr = new ExternalSearchProviderError(this._id, 'request', 'External search request timed out after 8000ms');
        console.error(`[ExternalSearch][${this._id}] TIMEOUT after ${durationMs}ms`);
        return {
          providerId: this._id,
          results: [],
          durationMs,
          error: timeoutErr.message,
        };
      }

      if (err instanceof ExternalSearchProviderError) {
        console.error(
          `[ExternalSearch][${this._id}] FAIL phase=${err.phase}` +
          (err.statusCode ? ` status=${err.statusCode}` : '') +
          ` message="${err.message}"` +
          (err.responsePreview ? ` preview="${err.responsePreview}"` : ''),
        );
        return {
          providerId: this._id,
          results: [],
          durationMs,
          error: err.message,
        };
      }
      
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExternalSearch][${this._id}] FAIL phase=request message="${msg}"`);
      return {
        providerId: this._id,
        results: [],
        durationMs,
        error: `[request] ${this._config.id}: ${msg}`,
      };
    }
  }

  // ─── Per-type execution ─────────────────────────────────────────────────────

  private async _executeSearch(
    query: string,
    cfg: SettingsSearchProvider,
    signal?: AbortSignal,
  ): Promise<AdaptedExternalResult[]> {
    switch (cfg.type) {
      case 'serper':
      case 'google':
        return this._searchSerper(query, cfg, signal);

      case 'brave':
        return this._searchBrave(query, cfg, signal);

      case 'tavily':
        return this._searchTavily(query, cfg, signal);

      case 'custom':
      case 'rest':
      default:
        return this._searchGenericRest(query, cfg, signal);
    }
  }

  /** Serper / Google-via-Serper: POST https://google.serper.dev/search */
  private async _searchSerper(
    query: string,
    cfg: SettingsSearchProvider,
    signal?: AbortSignal,
  ): Promise<AdaptedExternalResult[]> {
    const providerId = this._id;
    if (!cfg.apiKey) {
      throw new ExternalSearchProviderError(providerId, 'config', 'Serper API key is not configured');
    }
    const endpoint = cfg.endpoint ?? 'https://google.serper.dev/search';
    const body = JSON.stringify({ q: query });
    const res = await doHttpRequest({
      method: 'POST',
      url: endpoint,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': cfg.apiKey,
      },
      body,
      timeoutMs: 10000,
      signal,
    });

    if (!isOk(res.statusCode)) {
      throw new ExternalSearchProviderError(
        providerId,
        'response',
        `Serper returned HTTP ${res.statusCode}`,
        res.statusCode,
        res.body.slice(0, 300),
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      throw new ExternalSearchProviderError(
        providerId,
        'parse',
        `Failed to parse Serper response as JSON: ${(e as Error).message}`,
        res.statusCode,
        res.body.slice(0, 300),
      );
    }
    return adaptSerperResponse(providerId, json);
  }

  /** Brave Search API: GET https://api.search.brave.com/res/v1/web/search */
  private async _searchBrave(
    query: string,
    cfg: SettingsSearchProvider,
    signal?: AbortSignal,
  ): Promise<AdaptedExternalResult[]> {
    const providerId = this._id;

    if (!cfg.apiKey) {
      throw new ExternalSearchProviderError(
        providerId,
        'config',
        'Brave Search API key (X-Subscription-Token) is not configured. Add your Brave API key in Settings → Search.',
      );
    }

    const base = cfg.endpoint ?? 'https://api.search.brave.com/res/v1/web/search';
    const urlObj = new URL(base);
    urlObj.searchParams.set('q', query);
    const url = urlObj.toString();

    // Log URL without the API key for diagnostics
    console.log(`[ExternalApiSearchProvider][${providerId}] GET ${url}`);

    const res = await doHttpRequest({
      method: 'GET',
      url,
      headers: {
        // Do NOT include Accept-Encoding — Node.js native https does not
        // auto-decompress, and gzip responses cannot be parsed as JSON.
        'Accept': 'application/json',
        'X-Subscription-Token': cfg.apiKey,
      },
      timeoutMs: 10000,
      signal,
    });

    if (!isOk(res.statusCode)) {
      throw new ExternalSearchProviderError(
        providerId,
        'response',
        `Brave Search returned HTTP ${res.statusCode}`,
        res.statusCode,
        res.body.slice(0, 300),
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      throw new ExternalSearchProviderError(
        providerId,
        'parse',
        `Failed to parse Brave response as JSON: ${(e as Error).message}`,
        res.statusCode,
        res.body.slice(0, 300),
      );
    }
    return adaptBraveResponse(providerId, json);
  }

  /** Tavily Search API: POST https://api.tavily.com/search */
  private async _searchTavily(
    query: string,
    cfg: SettingsSearchProvider,
    signal?: AbortSignal,
  ): Promise<AdaptedExternalResult[]> {
    const providerId = this._id;
    if (!cfg.apiKey) {
      throw new ExternalSearchProviderError(providerId, 'config', 'Tavily API key is not configured');
    }
    const endpoint = cfg.endpoint ?? 'https://api.tavily.com/search';
    const body = JSON.stringify({ api_key: cfg.apiKey, query });
    const res = await doHttpRequest({
      method: 'POST',
      url: endpoint,
      headers: { 'Content-Type': 'application/json' },
      body,
      timeoutMs: 10000,
      signal,
    });

    if (!isOk(res.statusCode)) {
      throw new ExternalSearchProviderError(
        providerId,
        'response',
        `Tavily returned HTTP ${res.statusCode}`,
        res.statusCode,
        res.body.slice(0, 300),
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      throw new ExternalSearchProviderError(
        providerId,
        'parse',
        `Failed to parse Tavily response as JSON: ${(e as Error).message}`,
        res.statusCode,
        res.body.slice(0, 300),
      );
    }
    return adaptTavilyResponse(providerId, json);
  }

  /**
   * Generic REST / custom provider.
   * Attempts GET first with query as ?q= parameter.
   */
  private async _searchGenericRest(
    query: string,
    cfg: SettingsSearchProvider,
    signal?: AbortSignal,
  ): Promise<AdaptedExternalResult[]> {
    const providerId = this._id;
    if (!cfg.endpoint) {
      throw new ExternalSearchProviderError(
        providerId,
        'config',
        `Custom/REST search provider "${cfg.id}" has no endpoint configured.`,
      );
    }
    const urlObj = new URL(cfg.endpoint);
    urlObj.searchParams.set('q', query);
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }
    const res = await doHttpRequest({
      method: 'GET',
      url: urlObj.toString(),
      headers,
      timeoutMs: 10000,
      signal,
    });

    if (!isOk(res.statusCode)) {
      throw new ExternalSearchProviderError(
        providerId,
        'response',
        `Custom REST provider returned HTTP ${res.statusCode}`,
        res.statusCode,
        res.body.slice(0, 300),
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      throw new ExternalSearchProviderError(
        providerId,
        'parse',
        `Failed to parse custom REST response as JSON: ${(e as Error).message}`,
        res.statusCode,
        res.body.slice(0, 300),
      );
    }
    return adaptGenericResponse(providerId, json);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isOk(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

// ─── Legacy ID aliases ────────────────────────────────────────────────────────

/**
 * Maps legacy provider IDs stored in older settings to canonical IDs.
 * e.g., "default-brave" → "brave"
 */
const LEGACY_PROVIDER_ID_MAP: Record<string, string> = {
  'default-brave': 'brave',
  'default-google': 'google',
  'default-serper': 'serper',
  'default-tavily': 'tavily',
};

/**
 * Normalize a provider ID from settings to its canonical form.
 * Returns the canonical ID, or the original if no mapping is found.
 */
export function canonicalizeProviderId(id: string): string {
  return LEGACY_PROVIDER_ID_MAP[id] ?? id;
}

// ─── Factory helper ───────────────────────────────────────────────────────────

/**
 * Resolve the active, enabled SearchProvider from the settings search config.
 * Returns null if no active/enabled provider is found.
 * Applies legacy ID migration transparently.
 */
export function resolveActiveSearchProviderConfig(
  searchConfig: { activeProviderId: string; providers: SettingsSearchProvider[] } | undefined,
): SettingsSearchProvider | null {
  if (!searchConfig?.providers?.length) return null;

  const canonicalActiveId = canonicalizeProviderId(searchConfig.activeProviderId);

  const active = searchConfig.providers.find(p => {
    const canonicalId = canonicalizeProviderId(p.id);
    return (canonicalId === canonicalActiveId || p.id === searchConfig.activeProviderId) && p.enabled;
  });

  return active ?? null;
}

/**
 * Resolve the curated search provider config from settings.
 * Uses curatedSearchProviderId if present, otherwise falls back to activeProviderId.
 * Returns null if no configured+enabled provider found.
 */
export function resolveCuratedSearchProviderConfig(
  searchConfig: { activeProviderId: string; curatedSearchProviderId?: string; providers: SettingsSearchProvider[] } | undefined,
): SettingsSearchProvider | null {
  if (!searchConfig?.providers?.length) return null;

  const targetId = searchConfig.curatedSearchProviderId || searchConfig.activeProviderId;
  const canonicalTarget = canonicalizeProviderId(targetId);

  // Try curated first
  const curated = searchConfig.providers.find(p => {
    const canonicalId = canonicalizeProviderId(p.id);
    return (canonicalId === canonicalTarget || p.id === targetId) && p.enabled;
  });
  if (curated) return curated;

  // Fall back to any enabled provider
  const fallback = searchConfig.providers.find(p => p.enabled);
  if (fallback) {
    console.log(`[ExternalApiSearchProvider] Curated provider "${targetId}" not found/enabled; falling back to "${fallback.id}"`);
    return fallback;
  }

  return null;
}

// ─── Phase 2: Provider Self Test ──────────────────────────────────────────────

/**
 * Runs a standalone execution test of a provider by its ID.
 * Returns structured success/latency/error results for the Settings UI.
 */
export async function testProvider(searchConfig: { activeProviderId: string; providers: SettingsSearchProvider[] } | undefined, providerId: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const pId = providerId.replace(/^external:/, '');
  const cfg = searchConfig?.providers?.find(p => p.id === pId);
  if (!cfg) {
    return { success: false, latencyMs: 0, error: 'Provider not configured' };
  }

  const provider = new ExternalApiSearchProvider(cfg);
  try {
    const res = await provider.search('test query', { scopeType: 'global', uris: [], itemKeys: [], sourcePaths: [] }, { topK: 1 });
    if (res.error) {
      return { success: false, latencyMs: res.durationMs, error: res.error };
    }
    return { success: true, latencyMs: res.durationMs };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, latencyMs: 0, error: msg };
  }
}
