/**
 * Agents API client — Wauldo Deploy deployed-agent registry.
 *
 * Standalone client that talks to the /v1/agents endpoints. Designed to
 * work alongside the existing HttpClient without requiring modifications
 * to it — instantiate AgentsClient with the same baseUrl + apiKey you use
 * for HttpClient.
 *
 * @example
 * ```ts
 * import { AgentsClient } from "wauldo";
 * const agents = new AgentsClient({ baseUrl: "http://localhost:3000", apiKey: "..." });
 * const agent = await agents.create({
 *   name: "sdr-bot",
 *   wauldoToml: fs.readFileSync("wauldo.toml", "utf8"),
 * });
 * const run = await agents.run(agent.id, "Qualify acme.com");
 * console.log(run.task_id);
 * ```
 */

import { ServerError, TaskTimeoutError } from "./errors.js";

//: Max bytes the client will accept from a single response. Protects
//: against hostile or misbehaving servers that try to stream gigabytes.
export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── Shared types ────────────────────────────────────────────────────

export interface AgentsClientConfig {
  baseUrl: string;
  apiKey?: string;
  /** Tenant identifier forwarded via x-rapidapi-user header. */
  tenant?: string;
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number;
  /**
   * Attempts after the first on a 429 or 503 (any method) and on a
   * 500/502/504 or a network error (`GET` only — a replayed `POST` could run
   * an agent twice, a replayed cancel answers 409 for a cancel that worked).
   * Default 3; 0 disables.
   * `Retry-After` is honoured; otherwise the wait doubles from
   * `retryBackoffMs`. Timeouts are never retried.
   */
  maxRetries?: number;
  /** First backoff in ms (doubles per attempt, capped at 8 s). Default 500. */
  retryBackoffMs?: number;
}

/** Statuses retried whatever the method: the server did not take the request. */
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** Statuses retried only on a read: the server may have acted before failing. */
export const RETRY_STATUSES_IDEMPOTENT: ReadonlySet<number> = new Set([500, 502, 504]);
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET"]);
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 8_000;

function shouldRetry(method: string, status: number): boolean {
  if (RETRY_STATUSES.has(status)) return true;
  return RETRY_STATUSES_IDEMPOTENT.has(status) && IDEMPOTENT_METHODS.has(method);
}

/**
 * Milliseconds to wait before attempt `attempt + 1`: `Retry-After` (seconds)
 * when present and sane, capped at 30 s; otherwise exponential backoff from
 * `backoffMs`, capped at 8 s, plus up to 250 ms of jitter.
 */
export function retryDelayMs(
  attempt: number,
  backoffMs: number,
  retryAfter: string | null,
): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  return Math.min(backoffMs * 2 ** attempt, MAX_BACKOFF_MS) + Math.random() * 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DeployedAgent {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  wauldo_toml: string;
  model_provider: string;
  model_name: string;
  preset?: string;
  created_at: number;
  updated_at: number;
}

export interface CreateAgentInput {
  name: string;
  wauldoToml: string;
  description?: string;
  preset?: string;
  /**
   * Inline workflow (the `AgentContractV2` JSON `createRevision` takes),
   * validated by the server at creation: the agent's first run already uses
   * it, with no `createRevision` call in between. Takes precedence over
   * `preset`.
   */
  customPreset?: Record<string, unknown>;
}

export interface UpdateAgentPatch {
  description?: string;
  wauldoToml?: string;
  preset?: string;
}

export interface AgentListResponse {
  agents: DeployedAgent[];
  pagination: { total: number; limit: number; offset: number };
}

export interface AgentRunResponse {
  task_id: string;
  agent_id: string;
  status: string;
  created_at: number;
  /**
   * Filled only when the run was requested with `waitSeconds`: the task as
   * it stood when the server answered — settled, with its result and
   * verification, if the run finished within the wait.
   */
  task?: Task | null;
  /** Set when the run was requested with `autoShare` and a link was registered. */
  share_id?: string;
  /** The public URL of the run, with `share_id`. */
  share_url?: string;
}

/** Options of `run` (and, but `waitSeconds`, of `runAndWait`). */
export interface RunOptions {
  /** Hold the response up to this many seconds for the run to settle. */
  waitSeconds?: number;
  /**
   * The server POSTs the task record here when the run completes or fails.
   * A public http(s) URL: a private or internal destination is refused (400).
   */
  webhookUrl?: string;
  /**
   * Retries of the run on the server (default 3, capped at 10) — not the
   * HTTP retries of this client (`AgentsClientConfig.maxRetries`).
   */
  maxRetries?: number;
  /** Publish the run at creation: the response carries `share_url`. */
  autoShare?: boolean;
}

/**
 * `error` of a task the server cancelled because it stayed paused for
 * approval 7 days without a decision.
 */
export const PAUSED_EXPIRED_ERROR = "Cancelled: no approval decision within 7 days";

/** Longest `reason` accepted with a decision, in characters (400 above). */
export const MAX_HITL_REASON_CHARS = 1000;

/** A human decision taken on a task, with the reviewer's note if one was sent. */
export interface TaskDecision {
  /** `"pause"`, `"approve"` or `"reject"`. */
  action: string;
  /** The reviewer's note, when one was sent. */
  reason?: string;
  /** When the decision was applied (Unix seconds). */
  at: number;
}

/** Result of `pauseTask`, `approveTask` and `rejectTask`. */
export interface HitlResponse {
  task_id: string;
  previous_status: TaskStatus | string;
  new_status: TaskStatus | string;
}

/**
 * Default wait of `waitForTask` and `runAndWait`, in ms. It covers ordinary
 * runs, queueing and verification included; it is not a bound on how long
 * the server may take. For a long run (many workflow states, tools,
 * retries), pass a larger `timeoutMs`, follow it with `streamTask`, or give
 * the run a `webhookUrl`. When the wait runs out the task keeps running:
 * `TaskTimeoutError.taskId` is there to wait again. Only the wait is long:
 * each request inside it stays a `LONG_POLL_SECONDS` long poll.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 360_000;

/**
 * Longest the server holds a request open for `wait`, in seconds. Larger
 * values are clamped server-side, not refused.
 */
export const MAX_WAIT_SECONDS = 50;

/**
 * Length of each long-poll request issued by `waitForTask`. Kept under
 * `MAX_WAIT_SECONDS` and well under the client timeout so a slow run still
 * reports progress every half minute.
 */
export const LONG_POLL_SECONDS = 30;

/**
 * Longest `streamTask` waits for the task once the stream is gone (no stream
 * on the server, or closed before its terminal event): the lifetime the
 * server gives a stream.
 */
export const STREAM_FALLBACK_TIMEOUT_MS = 1_800_000;

/**
 * `condition` of the terminal event: the one the server sends when the task
 * was already over, and the one `streamTask` gives the event it builds from
 * the task when the stream could not deliver it.
 */
export const ALREADY_FINISHED_CONDITION = "Already finished";

/**
 * Longest `streamTask` waits on the open stream without a byte (headers, then
 * each read) before falling back to reading the task. The server sends a
 * keep-alive every 15 s, so only a dead connection stays silent this long.
 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * What the stream says in place of `result` when it withheld the run's output
 * (`Task.output_withheld`).
 */
export const WITHHELD_RESULT = "Output withheld: injection detected";

/**
 * A failure a deploy or restart causes (429, 5xx, refused or reset
 * connection, timeout): worth reading the task again.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * `?wait=N` for a positive wait, the empty string otherwise. Rounded up: the
 * server takes whole seconds, and asking for one more is better than
 * returning before the caller's own deadline.
 */
/** `?wait=N` and/or `include_journal=true|false`; `""` when neither is set. */
function taskQuery(waitSeconds?: number, includeJournal?: boolean): string {
  const wait = waitQuery(waitSeconds);
  if (includeJournal === undefined) return wait;
  const flag = `include_journal=${includeJournal ? "true" : "false"}`;
  return wait ? `${wait}&${flag}` : `?${flag}`;
}

/** What a wait that ran out says after its first sentence. */
function stillRunning(taskId: string): string {
  return (
    `; the task may still be running on the server: call waitForTask("${taskId}") ` +
    `to keep waiting, or getTask("${taskId}") to read it`
  );
}

function waitQuery(waitSeconds?: number): string {
  if (waitSeconds === undefined || !(waitSeconds > 0)) return "";
  return `?wait=${Math.ceil(Math.min(waitSeconds, MAX_WAIT_SECONDS))}`;
}

/**
 * Immutable snapshot of an agent's `AgentContractV2` payload, content-addressed
 * via SHA-256 and identified by a monotone `rev` integer. Mirrors AWS ECS
 * task-definition revisions: append-only, O(1) rollback via `setActiveRevision`.
 */
export interface AgentRevision {
  rev: number;
  sha256: string;
  contract_json: string;
  created_at: number;
  message?: string;
  created_by?: string;
}

export interface CreateRevisionInput {
  /** Full `AgentContractV2` JSON payload (same shape as `custom_preset` on POST /v1/agents). */
  customPreset: Record<string, unknown>;
  /** Optional commit-message-style note (≤256 chars). */
  message?: string;
  /** When `true` (default) the new revision becomes active immediately. */
  setActive?: boolean;
}

export interface CreateRevisionResponse {
  rev: number;
  sha256: string;
  active_rev: number;
}

export interface ListRevisionsResponse {
  revisions: AgentRevision[];
  active_rev: number;
  head_rev: number;
  count: number;
}

/**
 * Result of `shareTask` / `unshareTask`.
 *
 * `expiresAt` is epoch milliseconds, or `null` for paid tenants
 * (no expiration). Free-tier shares default to a 30-day TTL ; once
 * elapsed, the public `GET /v1/runs/<shareId>` returns 404.
 */
export interface ShareResponse {
  share_id: string;
  url: string;
  expires_at: number | null;
}

export interface A2aResponse {
  task_id: string;
  agent_id: string;
  trace: string[];
  depth: number;
  status: string;
}

// ─── Tasks + verification types ──────────────────────────────────────

/** Verification verdict returned on completed tasks. */
export type Verdict =
  | "SAFE"
  | "UNCERTAIN"
  | "PARTIAL"
  | "BLOCK"
  | "CONFLICT"
  | "UNVERIFIED";

/** Task lifecycle status. */
export type TaskStatus =
  | "queued"
  | "running"
  | "paused_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

/** A single verified claim from an agent output. */
export interface TaskClaim {
  text: string;
  supported: boolean;
  confidence: number;
}

/**
 * Verification block attached to completed tasks. When
 * `verification_source === "prompt_only"` the `confidence` and
 * `hallucination_rate` fields reflect self-consistency only; rely on
 * `verdict` + `support_score` (alias `trust_score`) + `message` as authoritative.
 *
 * Note: `support_score` is the public name for the same numeric value
 * the wire protocol calls `trust_score`. The JSON wire field is unchanged
 * for backward compatibility — use `supportScore(v)` to read the value
 * by its public name. New code should prefer `support_score`.
 */
export interface TaskVerification {
  verdict: Verdict;
  hallucination_rate: number;
  confidence: number;
  trust_score: number;
  /**
   * Public name for `trust_score` (0-1 fraction of claims supported
   * by the sources). Optional on the wire; always equals `trust_score`
   * when populated. Prefer the `supportScore()` helper to read it.
   */
  support_score?: number;
  verification_source: string;
  claims: TaskClaim[];
  verification_retries: number;
  /** Human-readable context for non-SAFE verdicts. */
  message?: string | null;
  sources_cited?: number[];
  stripped_claims?: string[];
}

/**
 * Read the support score of a verification block. Falls back to
 * `trust_score` when the optional `support_score` field is absent
 * (the JSON wire format only emits `trust_score` for backward
 * compatibility). Always returns the same numeric value either way.
 */
export function supportScore(v: TaskVerification): number {
  return v.support_score ?? v.trust_score;
}

/** Full task record returned by `GET /v1/tasks/:id`. */
export interface Task {
  task_id: string;
  tenant_id: string;
  status: TaskStatus;
  prompt: string;
  created_at: number;
  updated_at: number;
  preset?: string | null;
  result?: string | null;
  error?: string | null;
  partial_result?: string | null;
  verification?: TaskVerification | null;
  journal?: Record<string, unknown> | null;
  /**
   * True when the run's stream withheld its output (injection detected): the
   * stream's terminal event carries `WITHHELD_RESULT` in place of `result`.
   * Absent otherwise.
   */
  output_withheld?: boolean;
  /**
   * Human decisions taken on the task, oldest first. Only the 20 most recent
   * are kept: past that, the oldest is dropped. Absent when none.
   */
  decisions?: TaskDecision[];
}

/**
 * Single event yielded by `GET /v1/tasks/:id/stream`. Each SSE `data:`
 * line is a JSON-serialised StateTransition emitted when a workflow
 * state completes.
 */
export interface StateTransition {
  state_name: string;
  to_state?: string | null;
  condition: string;
  raw_output: string;
  validation_notes: string[];
  timestamp: number;
  success: boolean;
  retry_count: number;
  duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  repair_count: number;
  cache_hit: boolean;
}

export function isTerminalStatus(s: TaskStatus | string): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

/**
 * True for the stream's last event (`TASK_COMPLETED`, `TASK_FAILED`,
 * `TASK_CANCELLED`): the run is over and `terminalPayload` holds its result,
 * so there is nothing left to fetch. Exact names and a terminal `condition`:
 * a workflow state may be called anything, `TASK_COMPLETED` included.
 */
export function isTerminalTransition(t: StateTransition): boolean {
  return (
    (t.to_state ?? null) === null &&
    TERMINAL_STATE_NAMES.has(t.state_name) &&
    TERMINAL_CONDITIONS.has(t.condition)
  );
}

/**
 * `condition` of the stream's last event: `"terminal"` when the run ends on
 * the stream, `"Already finished"` when it was over at subscription.
 */
export const TERMINAL_CONDITIONS: ReadonlySet<string> = new Set([
  "terminal",
  ALREADY_FINISHED_CONDITION,
]);

/** State names of the stream's last event, one per terminal status. */
export const TERMINAL_STATE_NAMES: ReadonlySet<string> = new Set([
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED",
]);

/** What the terminal event carries: the same fields as `GET /v1/tasks/:id`. */
export interface TerminalPayload {
  task_id: string;
  status: TaskStatus | string;
  result?: string | null;
  error?: string | null;
  verification?: TaskVerification | null;
}

/**
 * The terminal event's content, or `null` on an ordinary transition and when
 * the server withheld it.
 */
export function terminalPayload(t: StateTransition): TerminalPayload | null {
  if (!isTerminalTransition(t) || !t.raw_output) return null;
  try {
    const parsed: unknown = JSON.parse(t.raw_output);
    if (parsed === null || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    return typeof p.task_id === "string" && typeof p.status === "string" ? (p as unknown as TerminalPayload) : null;
  } catch {
    return null;
  }
}

/**
 * True when nothing will change until the caller acts: the run is over, or
 * it is paused for a human approval. This is what the server's `?wait=`
 * waits for, and what `waitForTask` returns on.
 */
export function isSettledStatus(s: TaskStatus | string): boolean {
  return isTerminalStatus(s) || s === "paused_for_approval";
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * The terminal event the server would have sent for `task`: same state name,
 * condition and payload (`task_id`, `status`, `result`, `error`,
 * `verification` as the server sent it). A run whose stream withheld its
 * output carries `WITHHELD_RESULT` in place of its result, as on the stream.
 */
function terminalTransitionOf(task: Task): StateTransition {
  const payload: TerminalPayload = {
    task_id: task.task_id,
    status: task.status,
    result: task.output_withheld ? WITHHELD_RESULT : (task.result ?? null),
    error: task.error ?? null,
    verification: task.verification ?? null,
  };
  return {
    state_name: `TASK_${String(task.status).toUpperCase()}`,
    to_state: null,
    condition: ALREADY_FINISHED_CONDITION,
    raw_output: JSON.stringify(payload),
    validation_notes: [],
    timestamp: Math.floor(Date.now() / 1000),
    success: task.status === "completed",
    retry_count: 0,
    duration_ms: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    repair_count: 0,
    cache_hit: false,
  };
}

/** An SSE `data:` line, as a transition; `null` for anything else. */
function parseSseLine(line: string): StateTransition | null {
  const trimmed = line.trimEnd().replace(/\r$/, "");
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  try {
    const obj: unknown = JSON.parse(payload);
    return obj !== null && typeof obj === "object" ? (obj as StateTransition) : null;
  } catch {
    return null; // Keep-alive or partial frame — skip.
  }
}

/**
 * Read a Response body as a single Uint8Array, aborting if it exceeds
 * `limit`. Uses the streaming reader so we never hold the full body in
 * memory if it's over the cap.
 */
export async function _boundedRead(
  resp: Response,
  limit: number = MAX_RESPONSE_SIZE,
): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(
          `response body too large: >${limit} bytes`,
        );
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

/**
 * An HTTP error status (4xx/5xx) from the agents, tasks, memory or workflows
 * API. A `ServerError` (so a `WauldoError`) whose `code` is the HTTP status;
 * `status`, `statusText` and `body` (the response body, the server's JSON
 * error usually) as before. A failed task is not an `HttpError`: read
 * `taskErrorInfo(task)`.
 */
export class HttpError extends ServerError {
  constructor(public status: number, public statusText: string, public body: string) {
    super(`HTTP ${status} ${statusText}: ${body}`, status, body);
    this.name = "HttpError";
    Object.setPrototypeOf(this, HttpError.prototype);
  }

  /** `HttpError: HTTP 401 Unauthorized: ...`, as before it was a `WauldoError`. */
  override toString(): string {
    return `${this.name}: ${this.message}`;
  }
}

// ─── Client ──────────────────────────────────────────────────────────

export class AgentsClient {
  constructor(private readonly config: AgentsClientConfig) {
    if (!config.baseUrl) throw new Error("baseUrl is required");
  }

  /**
   * `waitSeconds` bounded by the client's own request timeout (5 s of
   * margin): otherwise a client configured with `timeoutMs: 20_000` would see
   * every 30 s long poll abort before the server answers.
   */
  private waitBudget(waitSeconds: number): number {
    const clientSeconds = (this.config.timeoutMs ?? 120_000) / 1000;
    return Math.max(Math.min(waitSeconds, clientSeconds - 5), 0);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["Authorization"] = `Bearer ${this.config.apiKey}`;
    if (this.config.tenant) h["x-rapidapi-user"] = this.config.tenant;
    return { ...h, ...(extra ?? {}) };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headerOverride?: Record<string, string>,
  ): Promise<T | null> {
    const url = this.config.baseUrl.replace(/\/$/, "") + path;
    const maxRetries = Math.max(0, this.config.maxRetries ?? DEFAULT_MAX_RETRIES);
    const backoffMs = this.config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    for (let attempt = 0; ; attempt++) {
      // One timer per attempt, covering the request AND the body read.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120_000);
      try {
        let resp: Response;
        try {
          const init: RequestInit = {
            method,
            headers: this.headers(headerOverride),
            signal: controller.signal,
          };
          if (body !== undefined) init.body = JSON.stringify(body);
          resp = await fetch(url, init);
        } catch (err) {
          // `fetch` rejects with a TypeError when the request did not get a
          // response (refused, reset): replayed only on a read. A timeout
          // aborts with an AbortError and is never retried.
          if (attempt < maxRetries && IDEMPOTENT_METHODS.has(method) && err instanceof TypeError) {
            await sleep(retryDelayMs(attempt, backoffMs, null));
            continue;
          }
          throw err;
        }
        if (resp.status === 204) return null;
        const bytes = await _boundedRead(resp);
        const text = new TextDecoder().decode(bytes);
        if (!resp.ok) {
          if (attempt < maxRetries && shouldRetry(method, resp.status)) {
            await sleep(retryDelayMs(attempt, backoffMs, resp.headers.get("Retry-After")));
            continue;
          }
          throw new HttpError(resp.status, resp.statusText, text);
        }
        return text ? (JSON.parse(text) as T) : null;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────

  async create(input: CreateAgentInput): Promise<DeployedAgent> {
    const body: Record<string, unknown> = {
      name: input.name,
      wauldo_toml: input.wauldoToml,
      description: input.description ?? "",
    };
    if (input.preset !== undefined) body.preset = input.preset;
    if (input.customPreset !== undefined) body.custom_preset = input.customPreset;
    return (await this.request<DeployedAgent>("POST", "/v1/agents", body))!;
  }

  async list(limit = 20, offset = 0): Promise<AgentListResponse> {
    return (await this.request<AgentListResponse>(
      "GET",
      `/v1/agents?limit=${limit}&offset=${offset}`,
    ))!;
  }

  async get(agentId: string): Promise<DeployedAgent> {
    return (await this.request<DeployedAgent>("GET", `/v1/agents/${agentId}`))!;
  }

  async update(agentId: string, patch: UpdateAgentPatch): Promise<DeployedAgent> {
    const body: Record<string, unknown> = {};
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.wauldoToml !== undefined) body.wauldo_toml = patch.wauldoToml;
    if (patch.preset !== undefined) body.preset = patch.preset;
    return (await this.request<DeployedAgent>("PATCH", `/v1/agents/${agentId}`, body))!;
  }

  async delete(agentId: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/agents/${agentId}`);
  }

  // ── Revisions (ECS-style versioning) ────────────────────────────

  /**
   * `POST /v1/agents/:id/revisions` — mint an immutable revision.
   *
   * The server validates `customPreset` (size, depth, states, cycle, tools,
   * quota) and stores an immutable snapshot keyed by SHA-256. When
   * `setActive` is `true` (default) the new revision becomes the agent's
   * live revision; `false` stages it for review.
   */
  async createRevision(
    agentId: string,
    input: CreateRevisionInput,
  ): Promise<CreateRevisionResponse> {
    const body: Record<string, unknown> = {
      custom_preset: input.customPreset,
      set_active: input.setActive ?? true,
    };
    if (input.message !== undefined) body.message = input.message;
    return (await this.request<CreateRevisionResponse>(
      "POST",
      `/v1/agents/${agentId}/revisions`,
      body,
    ))!;
  }

  /** `GET /v1/agents/:id/revisions` — list revisions newest-first. */
  async listRevisions(agentId: string): Promise<ListRevisionsResponse> {
    return (await this.request<ListRevisionsResponse>(
      "GET",
      `/v1/agents/${agentId}/revisions`,
    ))!;
  }

  /** `GET /v1/agents/:id/revisions/:rev` — fetch one revision verbatim. */
  async getRevision(agentId: string, rev: number): Promise<AgentRevision> {
    return (await this.request<AgentRevision>(
      "GET",
      `/v1/agents/${agentId}/revisions/${rev}`,
    ))!;
  }

  /**
   * `PATCH /v1/agents/:id/active-revision` — O(1) rollback / promotion.
   *
   * No LLM cost — the revision is already validated and stored. Use this
   * to roll back to a previous good revision when the current one breaks
   * in production.
   */
  async setActiveRevision(agentId: string, rev: number): Promise<DeployedAgent> {
    return (await this.request<DeployedAgent>(
      "PATCH",
      `/v1/agents/${agentId}/active-revision`,
      { rev },
    ))!;
  }

  // ── Runs ────────────────────────────────────────────────────────

  /**
   * `POST /v1/agents/:id/runs` — trigger a verified run.
   *
   * With `opts.waitSeconds` the server holds the response until the run
   * settles or the delay elapses (clamped to `MAX_WAIT_SECONDS`), and fills
   * `task` with the task as it stands — the verified result in one
   * round-trip when the run is quick. Use `runAndWait` to always get the
   * final `Task`. `opts.webhookUrl`, `opts.maxRetries` and `opts.autoShare`:
   * see `RunOptions`.
   */
  async run(
    agentId: string,
    input: string,
    verificationMode?: "strict" | "balanced" | "permissive",
    factCheckMode?: "lexical" | "hybrid" | "semantic",
    opts: RunOptions = {},
  ): Promise<AgentRunResponse> {
    if (!input) throw new Error("input is required");
    const body: Record<string, unknown> = { input };
    if (verificationMode) body.verification_mode = verificationMode;
    if (factCheckMode) body.fact_check_mode = factCheckMode;
    if (opts.webhookUrl !== undefined) body.webhook_url = opts.webhookUrl;
    if (opts.maxRetries !== undefined) body.max_retries = opts.maxRetries;
    if (opts.autoShare !== undefined) body.auto_share = opts.autoShare;
    return (await this.request<AgentRunResponse>(
      "POST",
      `/v1/agents/${agentId}/runs${waitQuery(opts.waitSeconds)}`,
      body,
    ))!;
  }

  /**
   * Run an agent and resolve with the settled `Task` — one call.
   *
   * The run is created with the server holding the response for up to
   * `MAX_WAIT_SECONDS`; a quick run therefore comes back verified in a
   * single round-trip. A longer one is followed with `waitForTask` until
   * `timeoutMs` (default `DEFAULT_WAIT_TIMEOUT_MS`, which covers ordinary
   * runs, not every run), which rejects with a `TaskTimeoutError` if the task
   * has not settled; the run goes on on the server, and
   * `waitForTask(err.taskId)` keeps waiting. `webhookUrl`,
   * `maxRetries` and `autoShare` are passed to `run`.
   */
  async runAndWait(
    agentId: string,
    input: string,
    opts: Omit<RunOptions, "waitSeconds"> & {
      verificationMode?: "strict" | "balanced" | "permissive";
      factCheckMode?: "lexical" | "hybrid" | "semantic";
      timeoutMs?: number;
    } = {},
  ): Promise<Task> {
    const { verificationMode, factCheckMode, timeoutMs: requested, ...runOpts } = opts;
    const timeoutMs = requested ?? DEFAULT_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const resp = await this.run(agentId, input, verificationMode, factCheckMode, {
      ...runOpts,
      waitSeconds: this.waitBudget(Math.min(timeoutMs / 1000, MAX_WAIT_SECONDS)),
    });
    if (resp.task && isSettledStatus(resp.task.status)) return resp.task;
    return this.waitForTask(resp.task_id, {
      timeoutMs: Math.max(deadline - Date.now(), 0),
    });
  }

  async a2aInvoke(
    agentId: string,
    input: string,
    trace?: string[],
    verificationMode?: "strict" | "balanced" | "permissive",
    factCheckMode?: "lexical" | "hybrid" | "semantic",
  ): Promise<A2aResponse> {
    if (!input) throw new Error("input is required");
    const body: Record<string, unknown> = { input };
    if (verificationMode) body.verification_mode = verificationMode;
    if (factCheckMode) body.fact_check_mode = factCheckMode;
    const extraHeaders: Record<string, string> = {};
    if (trace && trace.length > 0) extraHeaders["x-a2a-trace"] = trace.join(",");
    return (await this.request<A2aResponse>(
      "POST",
      `/v1/a2a/${agentId}`,
      body,
      extraHeaders,
    ))!;
  }

  // ── Tasks (poll + stream) ───────────────────────────────────────

  /**
   * `GET /v1/tasks/:id` — fetch the current state of a task.
   *
   * With `opts.waitSeconds` the server holds the response until the task
   * settles or the delay elapses (clamped to `MAX_WAIT_SECONDS`): a long
   * poll, so the result arrives the moment it lands. The task is returned
   * as it stands either way.
   *
   * `opts.includeJournal: false` leaves the execution journal (every state's
   * raw output) out of the response: `journal` is then `null`. Not sent by
   * default, so the journal is included.
   */
  async getTask(
    taskId: string,
    opts: { waitSeconds?: number; includeJournal?: boolean } = {},
  ): Promise<Task> {
    return (await this.request<Task>(
      "GET",
      `/v1/tasks/${taskId}${taskQuery(opts.waitSeconds, opts.includeJournal)}`,
    ))!;
  }

  /**
   * `PUT /v1/tasks/:id` — cancel a queued or running task; resolves with the
   * task as cancelled. (Up to 0.17, this sent `DELETE`, which the server maps
   * to *deleting a finished task*: a running task could not be cancelled, and
   * a finished one was erased.)
   */
  async cancelTask(taskId: string): Promise<Task> {
    return (await this.request<Task>("PUT", `/v1/tasks/${taskId}`))!;
  }

  /** `DELETE /v1/tasks/:id` — delete a finished task (completed, failed, cancelled). */
  async deleteTask(taskId: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/tasks/${taskId}`);
  }

  // ── Shareable runs ──────────────────────────────────────────────

  /**
   * `POST /v1/tasks/:id/share` — publish a run as a public URL.
   *
   * Idempotent : calling on an already-shared task returns the existing
   * `ShareResponse` without bumping the per-tenant cap. The returned
   * `url` (form `https://wauldo.com/r/<id>`) can be pasted anywhere —
   * anyone with the link sees the verdict + claims + sources + timeline
   * through a strict-whitelist projection (no `custom_preset` /
   * `wauldo_toml` / system prompt / tool args ever leave the tenant).
   *
   * Free-tier tenants get a 30-day TTL ; paid tenants get
   * `expires_at = null` (no expiration).
   */
  async shareTask(taskId: string): Promise<ShareResponse> {
    return (await this.request<ShareResponse>(
      "POST",
      `/v1/tasks/${taskId}/share`,
      {},
    ))!;
  }

  /**
   * `DELETE /v1/tasks/:id/share` — make a published run private again.
   *
   * Idempotent : calling on a never-published task returns 204.
   * Subsequent `GET /v1/runs/<shareId>` for the cleared id returns 404.
   */
  async unshareTask(taskId: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/tasks/${taskId}/share`);
  }

  // ── Human in the loop ───────────────────────────────────────────

  /**
   * `POST /v1/tasks/:id/pause` — stop a queued or running task until a human
   * decides (status `paused_for_approval`). The run in flight is stopped, not
   * only relabelled; `waitForTask` and `runAndWait` resolve as soon as a task
   * is paused. `reason` is an optional note (at most 1000 characters, 400
   * above) stored with the decision: it is listed in `Task.decisions`, which
   * keeps the 20 most recent decisions (the oldest is dropped past that).
   *
   * A task left paused 7 days without a decision is cancelled by the server,
   * with the error `PAUSED_EXPIRED_ERROR`; approving or rejecting it then
   * answers 409, and `resumeTask` runs it again as a new task. `HttpError`
   * 409 here: the task cannot be paused (already over or paused); 404: it
   * does not exist.
   */
  async pauseTask(taskId: string, reason?: string): Promise<HitlResponse> {
    return this.hitl(taskId, "pause", reason);
  }

  /**
   * `POST /v1/tasks/:id/approve` — resume a paused task: it is queued and runs
   * again. `reason` is stored with the decision (see `pauseTask`). `HttpError`
   * 409 if the task is not paused for approval, including a task cancelled
   * after 7 days without a decision (`Task.error` is then
   * `PAUSED_EXPIRED_ERROR`).
   */
  async approveTask(taskId: string, reason?: string): Promise<HitlResponse> {
    return this.hitl(taskId, "approve", reason);
  }

  /**
   * `POST /v1/tasks/:id/reject` — cancel a paused task (final status
   * `cancelled`). `reason` is stored with the decision (see `pauseTask`).
   * `HttpError` 409 if the task is not paused for approval, including a task
   * already cancelled after 7 days without a decision.
   */
  async rejectTask(taskId: string, reason?: string): Promise<HitlResponse> {
    return this.hitl(taskId, "reject", reason);
  }

  /**
   * `POST /v1/tasks/:id/resume` — run a failed or cancelled task again. The
   * server creates a **new** task from the same prompt and settings (webhook
   * included); the original stays as it was. Resolves with the new task's id
   * and status (`queued`): follow it with `waitForTask` or `streamTask`.
   * `HttpError` 409 if the task is not failed or cancelled; 404 if it does
   * not exist. `agent_id` is `""`: the response names no agent.
   */
  async resumeTask(taskId: string): Promise<AgentRunResponse> {
    const resp = await this.request<Omit<AgentRunResponse, "agent_id"> & { agent_id?: string }>(
      "POST",
      `/v1/tasks/${taskId}/resume`,
      {},
    );
    return { ...resp!, agent_id: resp!.agent_id ?? "" };
  }

  private async hitl(
    taskId: string,
    action: "pause" | "approve" | "reject",
    reason?: string,
  ): Promise<HitlResponse> {
    const body = reason === undefined ? {} : { reason };
    return (await this.request<HitlResponse>("POST", `/v1/tasks/${taskId}/${action}`, body))!;
  }

  /**
   * Wait until the task settles — terminal, or paused for approval.
   *
   * Each request is a long poll (`?wait=`, `LONG_POLL_SECONDS`): the server
   * answers the moment the task settles, so the result is not delayed by a
   * polling interval. Against a server that does not hold the request, this
   * falls back to sleeping `pollIntervalMs` between polls, as before.
   *
   * Rejects with a `TaskTimeoutError` (carrying `taskId` and `lastStatus`)
   * if the task has not settled after `timeoutMs` (default
   * `DEFAULT_WAIT_TIMEOUT_MS`, which covers ordinary runs, not every run);
   * the task keeps running on the server, and calling this again with
   * `err.taskId` keeps waiting. Use
   * `streamTask` when you need event-by-event progress instead of a single
   * final state.
   */
  async waitForTask(
    taskId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number; longPollSeconds?: number } = {},
  ): Promise<Task> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    const longPollSeconds = opts.longPollSeconds ?? LONG_POLL_SECONDS;
    const deadline = Date.now() + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Never ask the server to hold longer than what is left of the caller's
      // own deadline; at or past it, a plain read then the rejection.
      const remainingSeconds = Math.max((deadline - Date.now()) / 1000, 0);
      const started = Date.now();
      const task = await this.getTask(taskId, {
        waitSeconds: this.waitBudget(Math.min(longPollSeconds, remainingSeconds)),
      });
      if (isSettledStatus(task.status)) return task;
      if (Date.now() >= deadline) {
        throw new TaskTimeoutError(
          `task ${taskId} still in status '${task.status}' after ${timeoutMs}ms` +
            stillRunning(taskId),
          taskId,
          String(task.status),
          timeoutMs,
        );
      }
      // A reply within half a second means the server did not hold the
      // request (older server): pace the polls ourselves.
      if (Date.now() - started < 500) {
        await new Promise((r) =>
          setTimeout(r, Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0))),
        );
      }
    }
  }

  /**
   * Subscribe to `GET /v1/tasks/:id/stream` and yield typed
   * StateTransition events as each workflow state completes. The last one is
   * the terminal event (`isTerminalTransition`), carrying the result.
   *
   * When the server has no stream for the task (404: still queued, already
   * over, server restarted) or the stream closes before its terminal event
   * (connection cut, silent for `STREAM_IDLE_TIMEOUT_MS`, 30-minute limit),
   * the task is long-polled until it settles (up to
   * `STREAM_FALLBACK_TIMEOUT_MS`, through the 429/5xx/refused connections of
   * a server restarting) and a terminal event built from it, with condition
   * `"Already finished"`, ends the generator. A task
   * paused for approval ends it without a terminal event: approve, then
   * stream again.
   *
   * @example
   * ```ts
   * for await (const event of agents.streamTask(run.task_id)) {
   *   console.log(event.state_name, event.duration_ms);
   * }
   * ```
   */
  async *streamTask(taskId: string): AsyncGenerator<StateTransition> {
    const url = this.config.baseUrl.replace(/\/$/, "") +
      `/v1/tasks/${taskId}/stream`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    try {
      // The headers, then each read, get `STREAM_IDLE_TIMEOUT_MS`: a
      // connection that stays silent (not even a keep-alive) is aborted, and
      // the task is read below as when the stream is cut.
      let idled = false;
      const idle = setTimeout(() => {
        idled = true;
        abort();
      }, STREAM_IDLE_TIMEOUT_MS);
      let resp: Response | null = null;
      try {
        resp = await fetch(url, {
          method: "GET",
          headers: this.headers({ Accept: "text/event-stream" }),
          signal: controller.signal,
        });
      } catch (err) {
        if (!idled) throw err;
      } finally {
        clearTimeout(idle);
      }
      // 404: the server has no stream for the task and asks for a poll. A
      // task that does not exist answers 404 too; the poll then rejects.
      if (resp && !resp.ok && resp.status !== 404) {
        const text = await resp.text().catch(() => "");
        throw new HttpError(resp.status, resp.statusText, text);
      }
      if (resp?.ok && resp.body) {
        for await (const event of readSse(resp.body, abort)) {
          yield event;
          if (isTerminalTransition(event)) return;
        }
      } else {
        await resp?.body?.cancel().catch(() => undefined);
      }
    } finally {
      abort();
    }
    const task = await this.settledTaskThroughOutages(taskId);
    if (isTerminalStatus(task.status)) yield terminalTransitionOf(task);
  }

  /**
   * Long-poll the task until it settles, within `STREAM_FALLBACK_TIMEOUT_MS`.
   * A transient failure (429, 5xx, refused connection: the server restarting
   * under a deploy) is waited out until that deadline, not only for
   * `maxRetries` attempts: the stream was most likely cut by that restart.
   */
  private async settledTaskThroughOutages(taskId: string): Promise<Task> {
    const deadline = Date.now() + STREAM_FALLBACK_TIMEOUT_MS;
    const backoffMs = this.config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    for (let failures = 0; ; failures++) {
      const remaining = Math.max(deadline - Date.now(), 0);
      try {
        return await this.waitForTask(taskId, { timeoutMs: remaining });
      } catch (err) {
        if (!isTransient(err) || Date.now() >= deadline) throw err;
      }
      await sleep(Math.min(retryDelayMs(failures, backoffMs, null), remaining));
    }
  }
}

/**
 * The transitions of an SSE body, read line by line; keep-alives and other
 * lines are skipped. A read silent for `STREAM_IDLE_TIMEOUT_MS` calls
 * `onIdle` (which aborts the request). A read that fails (connection cut,
 * aborted when idle) ends the iteration like the end of the body: the caller
 * then reads the task.
 */
async function* readSse(
  body: ReadableStream<Uint8Array>,
  onIdle: () => void,
): AsyncGenerator<StateTransition> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      // Per read, not per stream: time the caller spends on an event is
      // not the connection's silence.
      const idle = setTimeout(onIdle, STREAM_IDLE_TIMEOUT_MS);
      try {
        chunk = await reader.read();
      } catch {
        return;
      } finally {
        clearTimeout(idle);
      }
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseSseLine(line);
        if (event) yield event;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
