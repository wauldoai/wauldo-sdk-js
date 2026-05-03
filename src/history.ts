/**
 * History API client — Wauldo Funnel #1 audit log.
 *
 * Read-only access to a tenant's task history (every completed task is
 * persisted to a tenant-scoped DynamoDB audit log on the server side,
 * exposed via /v1/history). Mirrors {@link MemoryClient} shape so a
 * caller already familiar with the Memory API has zero ramp-up.
 *
 * Three formats:
 *
 * - {@link HistoryClient.list} — paginated JSON, suitable for dashboards.
 * - {@link HistoryClient.export} with `format="csv"` — single CSV blob
 *   (compliance evidence, header + footer metadata).
 * - {@link HistoryClient.export} with `format="jsonl"` — newline-
 *   delimited JSON for log pipelines.
 *
 * Right To Be Forgotten (GDPR Art. 17) is supported via
 * {@link HistoryClient.deleteTask}, which removes every audit row for a
 * specific task id within the caller's tenant.
 *
 * @example
 * ```ts
 * import { HistoryClient } from "wauldo/history";
 * const hist = new HistoryClient({
 *   baseUrl: "https://api.wauldo.com",
 *   apiKey: "tig_live_...",
 *   tenant: "my-org",
 * });
 * const page = await hist.list({ verdict: "CONFLICT", limit: 20 });
 * for (const item of page.items) console.log(item.task_id, item.verdict);
 * const blob = await hist.export({ format: "csv" });
 * await hist.deleteTask("a69b8612-0c47-43f3-93f2-c00c8a4ac1f8");
 * ```
 */

export interface HistoryClientConfig {
  baseUrl: string;
  apiKey?: string;
  tenant?: string;
  timeoutMs?: number;
}

export interface TaskHistoryEntry {
  task_id: string;
  tenant_id: string;
  agent_id?: string | null;
  verdict: string;
  support_score: number;
  halluc_rate: number;
  latency_ms: number;
  cost_micro_usd: number;
  claims_count: number;
  model?: string | null;
  created_at: number;
}

export interface HistoryListResponse {
  items: TaskHistoryEntry[];
  next_cursor: string | null;
  /**
   * `false` when the server hasn't wired its DynamoDB store (self-host
   * without IAM perm). UI should show "audit log not enabled" rather
   * than "no events yet" in that case.
   */
  enabled: boolean;
}

export interface ListOptions {
  verdict?: string;
  agentId?: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  cursor?: string;
}

export interface ExportOptions extends Omit<ListOptions, "limit" | "cursor"> {
  format: "csv" | "jsonl" | "json";
}

export class HistoryClient {
  constructor(private readonly config: HistoryClientConfig) {
    if (!config.baseUrl) throw new Error("baseUrl is required");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["Authorization"] = `Bearer ${this.config.apiKey}`;
    if (this.config.tenant) h["x-rapidapi-user"] = this.config.tenant;
    return h;
  }

  private buildQs(params: Record<string, unknown>): string {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length === 0) return "";
    const usp = new URLSearchParams();
    for (const [k, v] of entries) usp.set(k, String(v));
    return "?" + usp.toString();
  }

  private async fetchRaw(method: string, path: string): Promise<Response> {
    const url = this.config.baseUrl.replace(/\/$/, "") + path;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);
    try {
      const resp = await fetch(url, {
        method,
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`);
      }
      return resp;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * GET /v1/history — paginated audit log page. Pass `cursor` from a
   * previous response's `next_cursor` to paginate. Filters compose
   * with AND.
   */
  async list(opts: ListOptions = {}): Promise<HistoryListResponse> {
    const qs = this.buildQs({
      verdict: opts.verdict,
      agent_id: opts.agentId,
      from: opts.fromMs,
      to: opts.toMs,
      limit: opts.limit,
      cursor: opts.cursor,
    });
    const resp = await this.fetchRaw("GET", `/v1/history${qs}`);
    return (await resp.json()) as HistoryListResponse;
  }

  /**
   * Async generator over all pages within a window, yielding each page
   * as the server returns it. Stops when `next_cursor` is null.
   */
  async *iterPages(opts: ListOptions = {}): AsyncIterableIterator<HistoryListResponse> {
    let cursor: string | undefined = opts.cursor;
    const pageSize = opts.limit ?? 50;
    while (true) {
      const next: ListOptions = { ...opts, limit: pageSize };
      if (cursor !== undefined) next.cursor = cursor;
      const page: HistoryListResponse = await this.list(next);
      yield page;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
  }

  /**
   * GET /v1/history?format=csv|jsonl — single-blob export. Returns
   * the body as a string (`format=csv|jsonl`) or a parsed object
   * (`format=json`). Server auto-paginates up to 10000 rows; the body
   * footer (CSV `# wauldo-history-export ...` line / JSONL `_export`
   * object) signals truncation. Rate-limited per tenant to 5 / 60s —
   * a non-2xx response throws.
   */
  async export(opts: ExportOptions): Promise<string | HistoryListResponse> {
    if (!["csv", "jsonl", "json"].includes(opts.format)) {
      throw new Error(`unsupported format '${opts.format}' — use csv|jsonl|json`);
    }
    const qs = this.buildQs({
      format: opts.format,
      verdict: opts.verdict,
      agent_id: opts.agentId,
      from: opts.fromMs,
      to: opts.toMs,
    });
    const resp = await this.fetchRaw("GET", `/v1/history${qs}`);
    if (opts.format === "json") {
      return (await resp.json()) as HistoryListResponse;
    }
    return await resp.text();
  }

  /**
   * DELETE /v1/history/:task_id — RTBF (GDPR Art. 17). Removes every
   * audit row for `taskId` within the caller's tenant. Idempotent.
   * Returns the number of rows deleted.
   */
  async deleteTask(taskId: string): Promise<number> {
    if (!taskId) throw new Error("taskId required");
    const resp = await this.fetchRaw("DELETE", `/v1/history/${encodeURIComponent(taskId)}`);
    const body = (await resp.json()) as { deleted?: number };
    return Number(body?.deleted ?? 0);
  }
}
