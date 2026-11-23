/**
 * HTTP client for Wauldo REST API (OpenAI-compatible)
 *
 * Uses Node 18+ built-in fetch — zero external dependencies.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Conversation } from './conversation.js';
import { ServerError, ValidationError } from './errors.js';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingResponse,
  FactCheckOptions,
  GuardMode,
  GuardResponse,
  HttpClientConfig,
  ModelList,
  OrchestratorResponse,
  RagQueryResponse,
  RagUploadOptions,
  RagUploadResponse,
  RequestOptions,
  SourceChunk,
  UploadFileOptions,
  UploadFileResponse,
  VerifyCitationResponse,
} from './http_types.js';
import { fetchWithRetry, type RetryConfig } from './retry_fetch.js';
import { parseSSEStream } from './sse_parser.js';

/** Validate that a parsed response is non-null before returning it. */
function validateResponse<T>(data: unknown, typeName: string): T {
  if (data === null || data === undefined) {
    throw new ServerError(`Invalid ${typeName}: response is null`, 0);
  }
  return data as T;
}

/**
 * Largest upload the server reads: 10 MB. The limit counts the whole request
 * (the file, its name and the form fields), so the file itself must be a few
 * hundred bytes smaller; `uploadFile` refuses a larger request before sending.
 */
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024;

/** `piiPolicy` as sent: `undefined` when unset, a ValidationError when unknown. */
function checkPiiPolicy(policy: unknown): 'redact' | 'keep' | undefined {
  if (policy === undefined) return undefined;
  if (policy !== 'redact' && policy !== 'keep') {
    throw new ValidationError(`piiPolicy must be "redact" or "keep", got "${String(policy)}"`, 'piiPolicy');
  }
  return policy;
}

/**
 * The file of an upload as a Blob, and its name. An empty file, or one over
 * 10 MB, is refused before it is read or sent.
 */
async function readUploadSource(
  file: string | Blob | Uint8Array | ArrayBuffer, filename?: string,
): Promise<{ data: Blob; name: string }> {
  let data: Blob;
  if (typeof file === 'string') {
    checkUploadSize((await stat(file)).size);
    data = new Blob([await readFile(file)]);
  } else {
    data = file instanceof Blob ? file : new Blob([file]);
  }
  checkUploadSize(data.size);
  const name = filename ?? (typeof file === 'string' ? basename(file) : 'upload');
  return { data, name };
}

/**
 * Refuse a form whose encoded body is over the server's limit. Measured with
 * the runtime's own encoder, the one `fetch` uses to send it.
 */
async function checkUploadBodySize(form: FormData): Promise<void> {
  const size = (await new Response(form).arrayBuffer()).byteLength;
  if (size > MAX_UPLOAD_FILE_BYTES) {
    throw new ValidationError(
      `Upload exceeds the 10 MB limit (${size} > ${MAX_UPLOAD_FILE_BYTES} bytes, file name and form fields included)`,
      'file',
    );
  }
}

/**
 * Refuse a text upload whose JSON body is over the server's limit. The limit
 * counts bytes as sent (UTF-8), not characters: an accented letter takes two
 * bytes, most CJK characters three, an emoji four.
 */
function checkTextUploadSize(body: Record<string, unknown>): void {
  const size = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (size > MAX_UPLOAD_FILE_BYTES) {
    throw new ValidationError(
      `Content exceeds the 10 MB limit once encoded (${size} > ${MAX_UPLOAD_FILE_BYTES} bytes as UTF-8)`,
      'content',
    );
  }
}

function checkUploadSize(size: number): void {
  if (size === 0) throw new ValidationError('The file is empty', 'file');
  if (size > MAX_UPLOAD_FILE_BYTES) {
    throw new ValidationError(`File exceeds the 10 MB limit (${size} > ${MAX_UPLOAD_FILE_BYTES} bytes)`, 'file');
  }
}

export class HttpClient {
  private retryConfig: RetryConfig;

  constructor(config: HttpClientConfig = {}) {
    const baseUrl = (config.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (config.headers) {
      Object.assign(headers, config.headers);
    }
    this.retryConfig = {
      baseUrl,
      headers,
      timeoutMs: config.timeoutMs ?? 120_000,
      maxRetries: config.maxRetries ?? 3,
      retryBackoffMs: config.retryBackoffMs ?? 1_000,
      onLog: config.onLog,
      onRequest: config.onRequest,
      onResponse: config.onResponse,
      onError: config.onError,
    };
  }

  // ── OpenAI-compatible endpoints ──────────────────────────────────────

  /** GET /v1/models — List available LLM models */
  async listModels(): Promise<ModelList> {
    const data = await fetchWithRetry<ModelList>(this.retryConfig, 'GET', '/v1/models');
    return validateResponse<ModelList>(data, 'ModelList');
  }

  /**
   * POST /v1/chat/completions — Chat completion (non-streaming).
   *
   * @param request - The chat request (model, messages, temperature, etc.)
   * @param options - Optional per-request overrides (e.g. timeoutMs)
   * @returns The full chat completion response
   *
   * @example
   * ```typescript
   * const resp = await client.chat({
   *   model: 'qwen2.5:7b',
   *   messages: [{ role: 'user', content: 'Hello' }],
   * });
   * console.log(resp.choices[0]?.message?.content);
   * ```
   */
  async chat(request: ChatRequest, options?: RequestOptions): Promise<ChatResponse> {
    const data = await fetchWithRetry<ChatResponse>(
      this.retryConfig,
      'POST',
      '/v1/chat/completions',
      { ...request, stream: false },
      options?.timeoutMs,
    );
    return validateResponse<ChatResponse>(data, 'ChatResponse');
  }

  /** Convenience: single message chat, returns content string */
  async chatSimple(model: string, message: string): Promise<string> {
    const resp = await this.chat({
      model,
      messages: [{ role: 'user', content: message }],
    });
    return resp.choices[0]?.message?.content ?? '';
  }

  /** POST /v1/chat/completions — SSE streaming, yields content chunks */
  async *chatStream(request: ChatRequest, options?: RequestOptions): AsyncGenerator<string> {
    const cfg = this.retryConfig;
    const effectiveTimeout = options?.timeoutMs ?? cfg.timeoutMs;
    cfg.onRequest?.('POST', '/v1/chat/completions');
    const start = Date.now();
    let resp: Response;
    try {
      resp = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...cfg.headers },
        body: JSON.stringify({ ...request, stream: true }),
        signal: AbortSignal.timeout(effectiveTimeout),
      });
    } catch (err) {
      if (err instanceof Error) cfg.onError?.(err);
      throw err;
    }
    if (!resp.ok) {
      const body = await resp.text();
      let message = body;
      try { const j = JSON.parse(body); if (j?.error?.message) message = j.error.message; } catch { /* not JSON: keep the raw body */ }
      const err = new ServerError(`HTTP ${resp.status}: ${message}`, resp.status);
      cfg.onError?.(err);
      throw err;
    }
    cfg.onResponse?.(resp.status, Date.now() - start);
    if (!resp.body) throw new ServerError('No response body for streaming', 0);
    yield* parseSSEStream(resp.body);
  }

  /** POST /v1/embeddings — Generate text embeddings */
  async embeddings(input: string | string[], model: string): Promise<EmbeddingResponse> {
    const data = await fetchWithRetry<EmbeddingResponse>(
      this.retryConfig, 'POST', '/v1/embeddings', { input, model },
    );
    return validateResponse<EmbeddingResponse>(data, 'EmbeddingResponse');
  }

  // ── RAG endpoints ────────────────────────────────────────────────────

  /**
   * POST /v1/upload — Upload document for RAG indexing.
   *
   * @param content - The document text to index. The 10 MB limit counts the
   *   request as sent (UTF-8 bytes, file name included): a larger one is
   *   refused with `ValidationError` before sending.
   * @param filename - Optional filename for the document
   * @param options - Optional per-request overrides (e.g. timeoutMs) and
   *   `piiPolicy` (`redact` — the server default — or `keep`)
   * @returns Upload confirmation with document_id and chunks_count
   */
  async ragUpload(
    content: string, filename?: string, options?: RagUploadOptions,
  ): Promise<RagUploadResponse> {
    const body: Record<string, unknown> = { content };
    if (filename) body['filename'] = filename;
    const piiPolicy = checkPiiPolicy(options?.piiPolicy);
    if (piiPolicy !== undefined) body['pii_policy'] = piiPolicy;
    checkTextUploadSize(body);
    const data = await fetchWithRetry<RagUploadResponse>(
      this.retryConfig, 'POST', '/v1/upload', body, options?.timeoutMs,
    );
    return validateResponse<RagUploadResponse>(data, 'RagUploadResponse');
  }

  /**
   * POST /v1/upload-file — Upload a file (PDF, DOCX, image, text) for RAG
   * indexing; the server extracts its text. 10 MB at most for the whole
   * request (file, name and fields): a larger one is refused before sending.
   *
   * @param file - A path to read (Node), or the file's bytes
   * @param options - `title`, `piiPolicy` (`redact` — the server default — or
   *   `keep`), `filename` (the server reads the type from its extension) and
   *   `timeoutMs`
   * @returns document_id, chunks_count, content_type and the extraction quality
   */
  async uploadFile(
    file: string | Blob | Uint8Array | ArrayBuffer, options?: UploadFileOptions,
  ): Promise<UploadFileResponse> {
    const piiPolicy = checkPiiPolicy(options?.piiPolicy);
    const { data, name } = await readUploadSource(file, options?.filename);
    const form = new FormData();
    form.append('file', data, name);
    if (options?.title) form.append('title', options.title);
    if (piiPolicy !== undefined) form.append('pii_policy', piiPolicy);
    await checkUploadBodySize(form);
    const resp = await fetchWithRetry<UploadFileResponse>(
      this.retryConfig, 'POST', '/v1/upload-file', form, options?.timeoutMs,
    );
    return validateResponse<UploadFileResponse>(resp, 'UploadFileResponse');
  }

  /** POST /v1/query — Query RAG knowledge base */
  async ragQuery(
    query: string,
    topK = 5,
    options?: { debug?: boolean; qualityMode?: string },
  ): Promise<RagQueryResponse> {
    const body: Record<string, unknown> = { query, top_k: topK };
    if (options?.debug) body.debug = true;
    if (options?.qualityMode) body.quality_mode = options.qualityMode;
    const data = await fetchWithRetry<RagQueryResponse>(
      this.retryConfig, 'POST', '/v1/query', body,
    );
    return validateResponse<RagQueryResponse>(data, 'RagQueryResponse');
  }

  // ── Conversation & RAG helpers ────────────────────────────────────────

  /**
   * Create a stateful conversation that tracks message history automatically.
   *
   * @param options - Optional system prompt and model name
   * @returns A Conversation instance bound to this client
   *
   * @example
   * ```typescript
   * const conv = client.conversation({ system: 'You are a TypeScript expert' });
   * const reply = await conv.say('What are generics?');
   * ```
   */
  conversation(options?: { system?: string; model?: string }): Conversation {
    return new Conversation(this, options);
  }

  /**
   * Upload text to RAG, then query it — one-shot Q&A over a document.
   *
   * @param question - The question to ask about the document
   * @param text - The document text to index and query
   * @param source - Optional source name (defaults to 'document')
   * @returns The answer string
   */
  async ragAsk(question: string, text: string, source = 'document'): Promise<string> {
    await this.ragUpload(text, source);
    const result = await this.ragQuery(question, 3);
    return result.answer ?? JSON.stringify(result.sources);
  }

  // ── Guard (Fact-Check) ─────────────────────────────────────────────

  /**
   * POST /v1/fact-check — Verify text claims against source context.
   *
   * Guard is a hallucination firewall: checks whether LLM output is supported
   * by source documents. Blocks wrong answers before they reach users.
   *
   * @param text - The LLM-generated text to verify
   * @param sourceContext - The ground-truth source document(s)
   * @param mode - "lexical" (<1ms), "hybrid" (~50ms), or "semantic" (~500ms)
   * @param options - Optional per-request overrides
   *
   * @example
   * ```typescript
   * const result = await client.guard(
   *   'Returns accepted within 60 days',
   *   'Our return policy: 14 days.',
   * );
   * if (result.action === 'block') {
   *   console.log('Hallucination caught:', result.claims[0]?.reason);
   * }
   * ```
   */
  async factCheck(
    text: string,
    sourceContext: string,
    mode: GuardMode = 'lexical',
    options?: FactCheckOptions,
  ): Promise<GuardResponse> {
    if (!text) throw new ValidationError('text cannot be empty', 'text');
    if (!sourceContext) {
      throw new ValidationError('source_context is required for verification', 'source_context');
    }
    if (options?.relevanceMode !== undefined && options?.query === undefined) {
      throw new ValidationError('relevanceMode requires query to be provided', 'relevanceMode');
    }
    const body: Record<string, unknown> = { text, source_context: sourceContext, mode };
    if (options?.query !== undefined) {
      body.query = options.query;
    }
    if (options?.relevanceMode !== undefined) {
      body.relevance_mode = options.relevanceMode;
    }
    const data = await fetchWithRetry<GuardResponse>(
      this.retryConfig,
      'POST',
      '/v1/fact-check',
      body,
      options?.timeoutMs,
    );
    return validateResponse<GuardResponse>(data, 'GuardResponse');
  }

  /** Deprecated alias for {@link HttpClient.factCheck}, kept for back-compat. */
  async guard(
    text: string,
    sourceContext: string,
    mode: GuardMode = 'lexical',
    options?: FactCheckOptions,
  ): Promise<GuardResponse> {
    return this.factCheck(text, sourceContext, mode, options);
  }

  /**
   * POST /v1/verify — Validate inline citations against sources.
   *
   * @param text - The AI-generated text (with or without citations).
   * @param sources - Source chunks to validate citations against.
   * @param threshold - Minimum citation ratio (0.0-1.0).
   */
  async verifyCitation(
    text: string,
    sources?: SourceChunk[],
    threshold?: number,
    options?: RequestOptions,
  ): Promise<VerifyCitationResponse> {
    const body: Record<string, unknown> = { text };
    if (sources !== undefined) {
      body.sources = sources;
    }
    if (threshold !== undefined) {
      body.threshold = threshold;
    }
    const data = await fetchWithRetry<VerifyCitationResponse>(
      this.retryConfig,
      'POST',
      '/v1/verify',
      body,
      options?.timeoutMs,
    );
    return validateResponse<VerifyCitationResponse>(data, 'VerifyCitationResponse');
  }

  // ── Orchestrator endpoints ───────────────────────────────────────────

  /** POST /v1/orchestrator/execute — Route to best specialist agent */
  async orchestrate(prompt: string): Promise<OrchestratorResponse> {
    const data = await fetchWithRetry<OrchestratorResponse>(
      this.retryConfig, 'POST', '/v1/orchestrator/execute', { prompt },
    );
    return validateResponse<OrchestratorResponse>(data, 'OrchestratorResponse');
  }

  /** POST /v1/orchestrator/parallel — Run all 4 specialists in parallel */
  async orchestrateParallel(prompt: string): Promise<OrchestratorResponse> {
    const data = await fetchWithRetry<OrchestratorResponse>(
      this.retryConfig, 'POST', '/v1/orchestrator/parallel', { prompt },
    );
    return validateResponse<OrchestratorResponse>(data, 'OrchestratorResponse');
  }
}
