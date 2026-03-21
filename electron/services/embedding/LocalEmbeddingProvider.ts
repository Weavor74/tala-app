/**
 * LocalEmbeddingProvider
 *
 * Generates text embeddings using a locally-running Ollama-compatible server.
 * Reads the endpoint from the active InferenceInstance so it stays consistent
 * with the rest of Tala's inference configuration.
 *
 * - Default model: embeddinggemma
 * - Uses Ollama's /api/embeddings endpoint
 * - Falls back to http://127.0.0.1:11434 when no active instance is found
 *
 * Node.js — lives in electron/. Not imported by renderer code.
 */

import https from 'https';
import http from 'http';
import type { InferenceInstance } from '../../../shared/settings';

export const LOCAL_EMBEDDING_PROVIDER_ID = 'local-embedding';
export const DEFAULT_EMBEDDING_MODEL = 'embeddinggemma';
export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function postJson(url: string, body: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`Ollama embeddings returned HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Embedding request timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class LocalEmbeddingProvider {
  readonly providerId = LOCAL_EMBEDDING_PROVIDER_ID;

  private readonly endpoint: string;
  private readonly model: string;

  /**
   * @param instance  Active InferenceInstance from app settings.
   *                  When null/undefined the provider falls back to default
   *                  Ollama endpoint and model.
   * @param modelOverride  Optional model name override (e.g. from embedding
   *                       config block in settings). When omitted, uses
   *                       DEFAULT_EMBEDDING_MODEL.
   */
  constructor(instance?: InferenceInstance | null, modelOverride?: string | null) {
    this.endpoint = resolveOllamaEndpoint(instance);
    this.model = modelOverride?.trim() || DEFAULT_EMBEDDING_MODEL;
  }

  /**
   * Embed a single text string.
   * Returns the embedding vector as number[].
   * Throws if the Ollama server is unreachable or returns an error.
   */
  async embedText(text: string): Promise<number[]> {
    const url = `${this.endpoint}/api/embeddings`;
    const body = JSON.stringify({ model: this.model, prompt: text });

    const raw = await postJson(url, body);
    const parsed = JSON.parse(raw) as { embedding?: number[] };

    if (!Array.isArray(parsed.embedding)) {
      throw new Error(
        `LocalEmbeddingProvider: unexpected response shape — "embedding" field missing or not an array. Raw: ${raw.slice(0, 200)}`,
      );
    }

    return parsed.embedding;
  }

  /** Convenience accessor — used for status/diagnostics. */
  getModel(): string {
    return this.model;
  }

  /** Convenience accessor — used for status/diagnostics. */
  getEndpoint(): string {
    return this.endpoint;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive the Ollama base endpoint from an InferenceInstance.
 *
 * Ollama uses http://host:port (no path). If the instance endpoint contains
 * a path suffix (e.g. /v1 added by users following OpenAI-compat paths),
 * we strip it back to the bare origin.
 *
 * Non-Ollama engines (llamacpp, vllm, cloud, …) are not the local embedding
 * path, so we still fall back to DEFAULT_OLLAMA_ENDPOINT; a future provider
 * variant can handle other transports.
 */
function resolveOllamaEndpoint(instance?: InferenceInstance | null): string {
  if (!instance) return DEFAULT_OLLAMA_ENDPOINT;

  const raw = instance.endpoint?.trim();
  if (!raw) return DEFAULT_OLLAMA_ENDPOINT;

  try {
    const parsed = new URL(raw);
    // Return bare origin (protocol + hostname + port, no path)
    return parsed.origin;
  } catch {
    return DEFAULT_OLLAMA_ENDPOINT;
  }
}
