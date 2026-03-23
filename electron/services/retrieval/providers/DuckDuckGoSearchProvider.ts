/**
 * DuckDuckGoSearchProvider
 *
 * A lightweight search provider that scrapes results from DuckDuckGo Lite.
 * Ported from legacy IpcRouter implementation to unify the retrieval path.
 *
 * Characteristics:
 * - No API key required.
 * - Resilient to bot detection (uses the lite endpoint).
 * - Keyword only (no semantic support).
 * - Lower priority/fallback compared to explicit API providers.
 */

import https from 'https';
import type {
  SearchProvider,
  SearchProviderResult,
  NormalizedSearchResult,
  RetrievalScopeResolved,
  RetrievalProviderOptions,
  RetrievalMode,
} from '../../../../shared/retrieval/retrievalTypes';

export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly id = 'duckduckgo';
  readonly supportedModes: RetrievalMode[] = ['keyword', 'hybrid'];

  async search(
    query: string,
    _scope: RetrievalScopeResolved,
    options: RetrievalProviderOptions,
  ): Promise<SearchProviderResult> {
    const startMs = Date.now();
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    try {
      const html = await this._fetchDuckDuckGoLite(query, userAgent);
      const results = this._parseResults(html);

      const topK = options.topK ?? 10;
      const limited = results.slice(0, topK);

      const normalized: NormalizedSearchResult[] = limited.map((r, i) => ({
        // Use the URL as part of the itemKey for stability
        itemKey: `web:ddg:${r.url}`,
        title: r.title,
        uri: r.url,
        sourcePath: null,
        snippet: r.snippet,
        sourceType: 'web',
        providerId: this.id,
        externalId: String(i),
        score: null, // Scraper doesn't provide scores; fusion logic handles this
        metadata: { source: 'duckduckgo_lite' },
      }));

      return {
        providerId: this.id,
        results: normalized,
        durationMs: Date.now() - startMs,
      };
    } catch (err: any) {
      return {
        providerId: this.id,
        results: [],
        durationMs: Date.now() - startMs,
        error: `DuckDuckGoSearchProvider failed: ${err.message}`,
      };
    }
  }

  private _fetchDuckDuckGoLite(query: string, userAgent: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

      const options = {
        headers: {
          'User-Agent': userAgent,
          'Referer': 'https://lite.duckduckgo.com/',
        },
      };

      const req = https.get(url, options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(data);
        });
        res.on('error', (err) => {
          reject(err);
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.setTimeout(10000, () => {
        req.destroy(new Error('DuckDuckGo Lite request timed out (10000ms)'));
      });
    });
  }

  private _parseResults(data: string): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const linkRegex = /class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/;

    let match;
    while ((match = linkRegex.exec(data)) !== null) {
      const rawLink = match[1];
      const rawTitle = match[2];

      // Extract URL
      let link = rawLink;
      if (link.includes('uddg=')) {
        const parts = link.split('uddg=');
        if (parts.length > 1) {
          link = decodeURIComponent(parts[1].split('&')[0]);
        }
      }
      link = link.startsWith('http') ? link : `https:${link}`;

      // Extract Title
      const title = rawTitle.replace(/<[^>]*>/g, '').trim();

      // Attempt to find a snippet after this match
      const restOfData = data.substring(linkRegex.lastIndex);
      const snippetMatch = restOfData.substring(0, 1000).match(snippetRegex);
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]*>/g, '').trim()
        : 'No description available.';

      results.push({ title, url: link, snippet });
    }
    return results;
  }
}
