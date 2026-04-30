/**
 * Memory API client — Wauldo Deploy long-term memory.
 *
 * Tenant-scoped key-value store with namespaces and lexical search.
 * Standalone like AgentsClient — no coupling to HttpClient.
 *
 * @example
 * ```ts
 * import { MemoryClient } from "wauldo/memory";
 * const mem = new MemoryClient({ baseUrl: "http://localhost:3000", apiKey: "..." });
 * await mem.set("support", "ticket-123", "Customer asked about pricing", {
 *   tags: ["urgent", "sales"],
 * });
 * const results = await mem.search("support", { query: "pricing", tags: ["urgent"] });
 * console.log(results.results[0]?.entry.value);
 * ```
 */

import { _boundedRead, HttpError, MAX_RESPONSE_SIZE } from "./agents";

export interface MemoryClientConfig {
  baseUrl: string;
  apiKey?: string;
  tenant?: string;
  timeoutMs?: number;
}

export interface MemoryEntry {
  id: string;
  tenant_id: string;
  namespace: string;
  key: string;
  value: string;
  tags: string[];
  embedding?: number[];
  created_at: number;
  updated_at: number;
}

export interface MemoryListResponse {
  entries: MemoryEntry[];
  pagination: { total: number; limit: number; offset: number };
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matched_fields: string[];
}

export interface MemorySearchResponse {
  results: MemorySearchResult[];
  total_matched: number;
  mode: string;
}

export interface SetOptions {
  tags?: string[];
  embedding?: number[];
}

export interface SearchOptions {
  query?: string;
  tags?: string[];
  limit?: number;
}

export class MemoryClient {
  constructor(private readonly config: MemoryClientConfig) {
    if (!config.baseUrl) throw new Error("baseUrl is required");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["Authorization"] = `Bearer ${this.config.apiKey}`;
    if (this.config.tenant) h["x-rapidapi-user"] = this.config.tenant;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const url = this.config.baseUrl.replace(/\/$/, "") + path;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 60_000,
    );
    try {
      const resp = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (resp.status === 204) return null;
      const bytes = await _boundedRead(resp, MAX_RESPONSE_SIZE);
      const text = new TextDecoder().decode(bytes);
      if (!resp.ok) {
        throw new HttpError(resp.status, resp.statusText, text);
      }
      return text ? (JSON.parse(text) as T) : null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────

  async set(
    namespace: string,
    key: string,
    value: string,
    options: SetOptions = {},
  ): Promise<MemoryEntry> {
    const body: Record<string, unknown> = { key, value };
    if (options.tags && options.tags.length > 0) body.tags = options.tags;
    if (options.embedding) body.embedding = options.embedding;
    return (await this.request<MemoryEntry>("POST", `/v1/memory/${namespace}`, body))!;
  }

  async get(namespace: string, key: string): Promise<MemoryEntry> {
    return (await this.request<MemoryEntry>("GET", `/v1/memory/${namespace}/${key}`))!;
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/memory/${namespace}/${key}`);
  }

  async list(namespace: string, limit = 20, offset = 0): Promise<MemoryListResponse> {
    return (await this.request<MemoryListResponse>(
      "GET",
      `/v1/memory/${namespace}?limit=${limit}&offset=${offset}`,
    ))!;
  }

  async search(
    namespace: string,
    options: SearchOptions,
  ): Promise<MemorySearchResponse> {
    const query = options.query ?? "";
    const tags = options.tags ?? [];
    if (!query && tags.length === 0) {
      throw new Error("search requires query or tags (or both)");
    }
    const body: Record<string, unknown> = { query };
    if (tags.length > 0) body.tags = tags;
    if (options.limit !== undefined) body.limit = options.limit;
    return (await this.request<MemorySearchResponse>(
      "POST",
      `/v1/memory/${namespace}/search`,
      body,
    ))!;
  }

  // ── Namespace sugar ────────────────────────────────────────────
  //
  // Bound views so callers can write `client.short_term.set("k", "v")`
  // instead of `client.set("short_term", "k", "v")`. Pure sugar — the
  // base CRUD methods above remain unchanged.

  /** Sugar for namespace `short_term` (session/transient state). */
  get short_term(): NamespacedMemory {
    return new NamespacedMemory(this, "short_term");
  }

  /** Sugar for namespace `long_term` (durable user/agent facts). */
  get long_term(): NamespacedMemory {
    return new NamespacedMemory(this, "long_term");
  }

  /** Sugar for namespace `entity` (per-entity profiles/state). */
  get entity(): NamespacedMemory {
    return new NamespacedMemory(this, "entity");
  }

  /** Sugar for namespace `contextual` (per-context attachments). */
  get contextual(): NamespacedMemory {
    return new NamespacedMemory(this, "contextual");
  }
}

/**
 * Namespace-bound view over a {@link MemoryClient}.
 *
 * Returned by `MemoryClient.short_term`, `.long_term`, `.entity`,
 * `.contextual`. Every method forwards to the parent client with the
 * namespace prefilled.
 */
export class NamespacedMemory {
  constructor(
    private readonly client: MemoryClient,
    public readonly namespace: string,
  ) {}

  set(key: string, value: string, options: SetOptions = {}): Promise<MemoryEntry> {
    return this.client.set(this.namespace, key, value, options);
  }

  get(key: string): Promise<MemoryEntry> {
    return this.client.get(this.namespace, key);
  }

  delete(key: string): Promise<void> {
    return this.client.delete(this.namespace, key);
  }

  list(limit = 20, offset = 0): Promise<MemoryListResponse> {
    return this.client.list(this.namespace, limit, offset);
  }

  search(options: SearchOptions): Promise<MemorySearchResponse> {
    return this.client.search(this.namespace, options);
  }
}
