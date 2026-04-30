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
 * import { AgentsClient } from "wauldo/agents";
 * const agents = new AgentsClient({ baseUrl: "http://localhost:3000", apiKey: "..." });
 * const agent = await agents.create({
 *   name: "sdr-bot",
 *   wauldoToml: fs.readFileSync("wauldo.toml", "utf8"),
 *   agentsMd: fs.readFileSync("AGENTS.md", "utf8"),
 * });
 * const run = await agents.run(agent.id, "Qualify acme.com");
 * console.log(run.task_id);
 * ```
 */

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
}

export interface DeployedAgent {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  wauldo_toml: string;
  agents_md?: string;
  mcp_json?: string;
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
  agentsMd?: string;
  mcpJson?: string;
  preset?: string;
}

export interface UpdateAgentPatch {
  description?: string;
  wauldoToml?: string;
  agentsMd?: string;
  mcpJson?: string;
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

// ─── Internal helpers ────────────────────────────────────────────────

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

export class HttpError extends Error {
  constructor(public status: number, public statusText: string, public body: string) {
    super(`HTTP ${status} ${statusText}: ${body}`);
    this.name = "HttpError";
  }
}

// ─── Client ──────────────────────────────────────────────────────────

export class AgentsClient {
  constructor(private readonly config: AgentsClientConfig) {
    if (!config.baseUrl) throw new Error("baseUrl is required");
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
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 120_000,
    );
    try {
      const init: RequestInit = {
        method,
        headers: this.headers(headerOverride),
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const resp = await fetch(url, init);
      if (resp.status === 204) return null;
      const bytes = await _boundedRead(resp);
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

  async create(input: CreateAgentInput): Promise<DeployedAgent> {
    const body: Record<string, unknown> = {
      name: input.name,
      wauldo_toml: input.wauldoToml,
      description: input.description ?? "",
    };
    if (input.agentsMd !== undefined) body.agents_md = input.agentsMd;
    if (input.mcpJson !== undefined) body.mcp_json = input.mcpJson;
    if (input.preset !== undefined) body.preset = input.preset;
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
    if (patch.agentsMd !== undefined) body.agents_md = patch.agentsMd;
    if (patch.mcpJson !== undefined) body.mcp_json = patch.mcpJson;
    if (patch.preset !== undefined) body.preset = patch.preset;
    return (await this.request<DeployedAgent>("PATCH", `/v1/agents/${agentId}`, body))!;
  }

  async delete(agentId: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/agents/${agentId}`);
  }

  // ── Runs ────────────────────────────────────────────────────────

  async run(
    agentId: string,
    input: string,
    verificationMode?: "strict" | "balanced" | "permissive",
    factCheckMode?: "lexical" | "hybrid" | "semantic",
  ): Promise<AgentRunResponse> {
    if (!input) throw new Error("input is required");
    const body: Record<string, unknown> = { input };
    if (verificationMode) body.verification_mode = verificationMode;
    if (factCheckMode) body.fact_check_mode = factCheckMode;
    return (await this.request<AgentRunResponse>(
      "POST",
      `/v1/agents/${agentId}/runs`,
      body,
    ))!;
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

  /** `GET /v1/tasks/:id` — fetch the current state of a task. */
  async getTask(taskId: string): Promise<Task> {
    return (await this.request<Task>("GET", `/v1/tasks/${taskId}`))!;
  }

  /** `DELETE /v1/tasks/:id` — cancel a queued or running task. */
  async cancelTask(taskId: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/tasks/${taskId}`);
  }

  /**
   * Poll `getTask` until the task reaches a terminal status. Resolves
   * with the final Task snapshot. Rejects with `Error("timeout")` if
   * the task is still running after `timeoutMs`. Use `streamTask` when
   * you need event-by-event progress instead of a single final state.
   */
  async waitForTask(
    taskId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<Task> {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const task = await this.getTask(taskId);
      if (isTerminalStatus(task.status)) return task;
      if (Date.now() >= deadline) {
        throw new Error(
          `task ${taskId} still in status '${task.status}' after ${timeoutMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  /**
   * Subscribe to `GET /v1/tasks/:id/stream` and yield typed
   * StateTransition events as each workflow state completes. The
   * generator closes when the upstream stream closes (task reached
   * terminal status) or on connection error.
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
    const resp = await fetch(url, {
      method: "GET",
      headers: this.headers({ Accept: "text/event-stream" }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new HttpError(resp.status, resp.statusText, text);
    }
    if (!resp.body) return;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trimEnd().replace(/\r$/, "");
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            const obj = JSON.parse(payload) as StateTransition;
            yield obj;
          } catch {
            // Keep-alive or partial frame — skip.
          }
        }
      }
    } finally {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
  }
}
