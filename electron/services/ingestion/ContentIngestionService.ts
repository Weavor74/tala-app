/**
 * ContentIngestionService
 *
 * Responsible for fetching full content for notebook_items, normalizing it,
 * chunking it deterministically, and persisting it into source_documents and
 * document_chunks in PostgreSQL.
 *
 * Architecture contract:
 *   - notebook_items stay unchanged (curated references)
 *   - source_documents store canonical content + citation metadata
 *   - document_chunks store retrieval units with char offsets
 *   - ingestion is always explicit — never triggered automatically
 *   - partial failure is acceptable; one bad source does not abort the batch
 *
 * Future: pgvector embeddings will attach to document_chunks rows.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ResearchRepository } from '../db/ResearchRepository';
import type { ContentRepository, InsertChunkInput } from '../db/ContentRepository';
import type {
  IngestionRequest,
  IngestionResult,
  ChunkingOptions,
  UpsertSourceDocumentInput,
} from '../../../shared/ingestion/ingestionTypes';
import { normalizeNotebookSourceRecord, type NotebookItemRecord } from '../../../shared/researchTypes';

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  maxTokensPerChunk: 512,
  overlapTokens: 64,
  strategy: 'hybrid',
};

// ─── Service ─────────────────────────────────────────────────────────────────

export class ContentIngestionService {
  constructor(
    private research: ResearchRepository,
    private content: ContentRepository
  ) {}

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Ingest all notebook items belonging to the given notebook.
   * Returns aggregated stats and any non-fatal warnings.
   */
  async ingestNotebook(
    notebookId: string,
    options?: Partial<ChunkingOptions>,
    refetch = false
  ): Promise<IngestionResult> {
    const items = await this.research.listNotebookItems(notebookId);
    if (items.length === 0) {
      return { documentsCreated: 0, documentsSkipped: 0, chunksCreated: 0, warnings: [] };
    }
    return this.ingestItems(
      items.map(i => i.item_key),
      notebookId,
      options,
      refetch
    );
  }

  /**
   * Ingest a list of notebook items by their item_keys.
   * Items that cannot be found or fetched produce a warning but do not abort
   * the rest of the batch.
   */
  async ingestItems(
    itemKeys: string[],
    notebookId?: string,
    options?: Partial<ChunkingOptions>,
    refetch = false
  ): Promise<IngestionResult> {
    const chunkingOpts: ChunkingOptions = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
    const result: IngestionResult = {
      documentsCreated: 0,
      documentsSkipped: 0,
      chunksCreated: 0,
      warnings: [],
    };

    // Collect notebook items across all requested keys.
    // We need the full record for metadata; look them up per key.
    let items: NotebookItemRecord[] = [];
    if (notebookId) {
      const all = await this.research.listNotebookItems(notebookId);
      items = all.filter(i => itemKeys.includes(i.item_key));
      // Warn about keys that were not found in this notebook.
      const foundKeys = new Set(items.map(i => i.item_key));
      for (const key of itemKeys) {
        if (!foundKeys.has(key)) {
          result.warnings!.push(`item_key not found in notebook ${notebookId}: ${key}`);
        }
      }
    } else {
      // No notebook context — attempt to look up items from any notebook.
      for (const key of itemKeys) {
        const item = await this._findItemByKey(key);
        if (item) {
          items.push(item);
        } else {
          result.warnings!.push(`item_key not found in any notebook: ${key}`);
        }
      }
    }

    for (const item of items) {
      try {
        await this._ingestSingleItem(item, notebookId, chunkingOpts, refetch, result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings!.push(`Failed to ingest ${item.item_key}: ${msg}`);
      }
    }

    return result;
  }

  /**
   * Fetch raw content and extract citation metadata for a single notebook item.
   * Returns null content with a warning string if the item cannot be fetched.
   */
  async fetchContentForItem(item: NotebookItemRecord): Promise<{
    content: string | null;
    metadata?: Partial<UpsertSourceDocumentInput>;
    warning?: string;
  }> {
    const normalizedSource = normalizeNotebookSourceRecord(item);
    if (normalizedSource.contentText) {
      return {
        content: this._normalizeWhitespace(normalizedSource.contentText),
        metadata: {
          uri: normalizedSource.uri,
          source_path: normalizedSource.sourcePath,
          source_type: normalizedSource.sourceType,
          mime_type: normalizedSource.mimeType,
          citation_label: normalizedSource.title,
          fetched_at: new Date().toISOString(),
        },
      };
    }

    // Prefer local file if source_path is set.
    if (normalizedSource.sourcePath) {
      try {
        const raw = fs.readFileSync(normalizedSource.sourcePath, 'utf-8');
        const content = this._normalizeWhitespace(raw);
        return {
          content,
          metadata: {
            source_path: normalizedSource.sourcePath,
            source_type: normalizedSource.sourceType,
            mime_type: normalizedSource.mimeType ?? this._guessMimeType(normalizedSource.sourcePath),
            fetched_at: new Date().toISOString(),
            citation_label: normalizedSource.title,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: null, warning: `Could not read file ${normalizedSource.sourcePath}: ${msg}` };
      }
    }

    // Fall back to HTTP fetch for web URIs.
    if (normalizedSource.uri) {
      try {
        const { content, mimeType } = await this._fetchHttp(normalizedSource.uri);
        const normalized = this._normalizeWhitespace(content);
        const displayDomain = this._extractDomain(normalizedSource.uri);
        return {
          content: normalized,
          metadata: {
            uri: normalizedSource.uri,
            source_type: normalizedSource.sourceType,
            mime_type: normalizedSource.mimeType ?? mimeType,
            display_domain: displayDomain,
            citation_label: normalizedSource.title ?? displayDomain ?? normalizedSource.uri,
            fetched_at: new Date().toISOString(),
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: null, warning: `Could not fetch URI ${normalizedSource.uri}: ${msg}` };
      }
    }

    return { content: null, warning: `item_key ${item.item_key} has no source_path or uri` };
  }

  /**
   * Chunk a normalized text string into deterministic retrieval units.
   * Returns an array of chunk descriptors with content, token estimate, and char offsets.
   */
  chunkContent(
    content: string,
    options: ChunkingOptions
  ): Array<{
    content: string;
    tokenEstimate: number;
    charStart: number;
    charEnd: number;
    sectionLabel: string | null;
  }> {
    if (!content || content.trim().length === 0) return [];

    switch (options.strategy) {
      case 'fixed':
        return this._chunkFixed(content, options);
      case 'paragraph':
        return this._chunkParagraph(content, options);
      case 'hybrid':
      default:
        return this._chunkHybrid(content, options);
    }
  }

  // ─── Private: Single-item ingestion ──────────────────────────────────────

  private async _ingestSingleItem(
    item: NotebookItemRecord,
    notebookId: string | undefined,
    chunkingOpts: ChunkingOptions,
    refetch: boolean,
    result: IngestionResult
  ): Promise<void> {
    const { content, metadata, warning } = await this.fetchContentForItem(item);

    if (!content) {
      result.warnings!.push(warning ?? `No content for ${item.item_key}`);
      return;
    }

    const contentHash = this._sha256(content);

    // Deduplication check.
    if (!refetch) {
      const exists = await this.content.documentExists(item.item_key, contentHash);
      if (exists) {
        result.documentsSkipped++;
        return;
      }
    }

    const upsertInput: UpsertSourceDocumentInput = {
      item_key: item.item_key,
      notebook_id: notebookId ?? item.notebook_id ?? null,
      title: item.title ?? null,
      uri: item.uri ?? null,
      source_path: item.source_path ?? null,
      provider_id: item.source_id ?? null,
      source_type: item.item_type ?? null,
      content,
      content_hash: contentHash,
      ...metadata,
    };

    const doc = await this.content.upsertSourceDocument(upsertInput);
    result.documentsCreated++;

    // Chunk and store.
    const rawChunks = this.chunkContent(content, chunkingOpts);
    const chunkInputs: InsertChunkInput[] = rawChunks.map((c, idx) => ({
      item_key: item.item_key,
      chunk_index: idx,
      content: c.content,
      token_estimate: c.tokenEstimate,
      content_hash: this._sha256(c.content),
      char_start: c.charStart,
      char_end: c.charEnd,
      section_label: c.sectionLabel ?? null,
    }));

    const insertedChunks = await this.content.insertChunks(doc.id, item.item_key, chunkInputs);
    result.chunksCreated += insertedChunks.length;
  }

  // ─── Private: Item lookup ─────────────────────────────────────────────────

  private async _findItemByKey(itemKey: string): Promise<NotebookItemRecord | null> {
    // List all notebooks and search for the item key.
    const notebooks = await this.research.listNotebooks();
    for (const nb of notebooks) {
      const items = await this.research.listNotebookItems(nb.id);
      const match = items.find(i => i.item_key === itemKey);
      if (match) return match;
    }
    return null;
  }

  // ─── Private: Content fetching ────────────────────────────────────────────

  private async _fetchHttp(uri: string): Promise<{ content: string; mimeType: string | null }> {
    // Use dynamic import so this compiles cleanly in browser TypeScript contexts.
    const https = await import('https');
    const http = await import('http');
    const { URL } = await import('url');

    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(uri);
      } catch {
        return reject(new Error(`Invalid URI: ${uri}`));
      }

      const transport = url.protocol === 'https:' ? https : http;
      const req = (transport as typeof https).get(uri, { timeout: 15_000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Simple single-hop redirect follow.
          this._fetchHttp(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} for ${uri}`));
        }

        const mimeType = (res.headers['content-type'] ?? null) as string | null;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const isHtml = mimeType?.includes('html') || raw.trimStart().startsWith('<!');
          const content = isHtml ? this._extractTextFromHtml(raw) : raw;
          resolve({ content, mimeType });
        });
        res.on('error', reject);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`HTTP request timed out for ${uri}`));
      });
      req.on('error', reject);
    });
  }

  /**
   * Very simple, dependency-free HTML text extraction.
   * Removes script/style/head blocks, strips tags, and decodes common entities.
   */
  private _extractTextFromHtml(html: string): string {
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
    return this._normalizeWhitespace(text);
  }

  // ─── Private: Normalisation ───────────────────────────────────────────────

  private _normalizeWhitespace(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private _guessMimeType(filePath: string): string | null {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      txt: 'text/plain',
      md: 'text/markdown',
      html: 'text/html',
      htm: 'text/html',
      pdf: 'application/pdf',
      json: 'application/json',
    };
    return ext ? (map[ext] ?? null) : null;
  }

  private _extractDomain(uri: string): string | null {
    try {
      return new URL(uri).hostname;
    } catch {
      return null;
    }
  }

  // ─── Private: Hashing ─────────────────────────────────────────────────────

  private _sha256(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
  }

  // ─── Private: Chunking strategies ────────────────────────────────────────

  /** Estimate tokens as ~4 characters per token (simple approximation). */
  private _estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Fixed-size chunking: split purely by token count with overlap.
   * Operates on character level (1 token ≈ 4 chars).
   */
  private _chunkFixed(
    content: string,
    opts: ChunkingOptions
  ): Array<{ content: string; tokenEstimate: number; charStart: number; charEnd: number; sectionLabel: string | null }> {
    const maxChars = opts.maxTokensPerChunk * 4;
    const overlapChars = opts.overlapTokens * 4;
    const results: Array<{ content: string; tokenEstimate: number; charStart: number; charEnd: number; sectionLabel: string | null }> = [];

    let start = 0;
    while (start < content.length) {
      const end = Math.min(start + maxChars, content.length);
      const chunk = content.slice(start, end).trim();
      if (chunk.length > 0) {
        results.push({
          content: chunk,
          tokenEstimate: this._estimateTokens(chunk),
          charStart: start,
          charEnd: end,
          sectionLabel: null,
        });
      }
      if (end >= content.length) break;
      start = end - overlapChars;
      if (start <= 0 || start >= end) start = end; // Safety guard.
    }
    return results;
  }

  /**
   * Paragraph-aware chunking: split on blank lines, then merge or split
   * paragraphs to stay within maxTokensPerChunk.
   */
  private _chunkParagraph(
    content: string,
    opts: ChunkingOptions
  ): Array<{ content: string; tokenEstimate: number; charStart: number; charEnd: number; sectionLabel: string | null }> {
    const paragraphs = content.split(/\n\n+/);
    const results: Array<{ content: string; tokenEstimate: number; charStart: number; charEnd: number; sectionLabel: string | null }> = [];
    let currentChunkParts: string[] = [];
    let currentTokens = 0;
    let charCursor = 0;
    let chunkStart = 0;

    const flush = () => {
      if (currentChunkParts.length === 0) return;
      const chunk = currentChunkParts.join('\n\n').trim();
      if (chunk.length > 0) {
        results.push({
          content: chunk,
          tokenEstimate: this._estimateTokens(chunk),
          charStart: chunkStart,
          charEnd: chunkStart + chunk.length,
          sectionLabel: null,
        });
      }
      currentChunkParts = [];
      currentTokens = 0;
    };

    for (const para of paragraphs) {
      const paraTokens = this._estimateTokens(para);

      // If this paragraph alone exceeds the limit, flush current buffer and
      // fall back to fixed-size for this paragraph.
      if (paraTokens > opts.maxTokensPerChunk) {
        flush();
        chunkStart = charCursor;
        const subChunks = this._chunkFixed(para, opts);
        let offset = charCursor;
        for (const sc of subChunks) {
          results.push({
            ...sc,
            charStart: offset + sc.charStart,
            charEnd: offset + sc.charEnd,
          });
        }
        charCursor += para.length + 2; // +2 for "\n\n"
        chunkStart = charCursor;
        continue;
      }

      if (currentTokens + paraTokens > opts.maxTokensPerChunk && currentChunkParts.length > 0) {
        flush();
        chunkStart = charCursor;
      }

      currentChunkParts.push(para);
      currentTokens += paraTokens;
      charCursor += para.length + 2;
    }

    flush();
    return results;
  }

  /**
   * Hybrid chunking: paragraph-aware with fixed-size fallback for oversized paragraphs.
   * Adds overlap between successive chunks by prepending tail of previous chunk.
   */
  private _chunkHybrid(
    content: string,
    opts: ChunkingOptions
  ): Array<{ content: string; tokenEstimate: number; charStart: number; charEnd: number; sectionLabel: string | null }> {
    const base = this._chunkParagraph(content, opts);
    if (opts.overlapTokens <= 0 || base.length <= 1) return base;

    const overlapChars = opts.overlapTokens * 4;
    const result = [base[0]];

    for (let i = 1; i < base.length; i++) {
      const prev = base[i - 1];
      const curr = base[i];
      // Prepend the tail of the previous chunk as overlap context.
      const tail = prev.content.slice(-overlapChars);
      const overlapped = (tail + '\n\n' + curr.content).trim();
      result.push({
        content: overlapped,
        tokenEstimate: this._estimateTokens(overlapped),
        charStart: curr.charStart,
        charEnd: curr.charEnd,
        sectionLabel: curr.sectionLabel,
      });
    }

    return result;
  }
}
