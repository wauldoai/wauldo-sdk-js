/**
 * Workflows API client — Wauldo Workflow Runtime (Step Functions style).
 *
 * State-machine workflows authored as `Task` / `Choice` / `Wait` / `Pass` /
 * `Fail` / `Succeed` states. Runs are async: `startRun` returns an
 * `execution_id`, then poll `getRun` (or use `waitForRun`) until a terminal
 * status.
 *
 * @example
 * ```ts
 * import { WorkflowsClient } from "wauldo/workflows";
 * const wf = new WorkflowsClient({ baseUrl: "https://api.wauldo.com", apiKey: "..." });
 * const created = await wf.create({
 *   name: "triage",
 *   startAt: "Compute",
 *   states: {
 *     Compute: { type: "Task", resource: "tool:calculator", next: "Done" },
 *     Done: { type: "Succeed" },
 *   },
 * });
 * const run = await wf.startRun(created.id, { operation: "add", a: 21, b: 21 });
 * const final = await wf.waitForRun(created.id, run.execution_id);
 * console.log(final.status, final.output);
 * ```
 */

import { _boundedRead, HttpError, MAX_RESPONSE_SIZE } from "./agents.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface WorkflowsClientConfig {
  baseUrl: string;
  apiKey?: string;
  /** Tenant identifier forwarded via x-rapidapi-user header. */
  tenant?: string;
  /** Per-request timeout in ms. Default 120_000. */
  timeoutMs?: number;
}

/** A workflow definition. */
export interface Workflow {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
  start_at: string;
  states: Record<string, unknown>;
  version: string;
  created_at: number;
  updated_at: number;
}

export interface CreateWorkflowInput {
  name: string;
  startAt: string;
  states: Record<string, unknown>;
  description?: string;
}

export interface WorkflowListResponse {
  workflows: Workflow[];
}

/** 202 response from `POST /v1/workflows/:id/runs`. */
export interface StartRunResponse {
  execution_id: string;
  workflow_id: string;
  status: string;
}

/**
 * A workflow execution record. `status` is one of `running`, `succeeded`,
 * `failed`, `timed_out`. `output` is populated on success; `error` on
 * terminal failure.
 */
export interface WorkflowExecution {
  id: string;
  workflow_id: string;
  tenant_id: string;
  status: string;
  current_state?: string | null;
  input: unknown;
  output?: unknown;
  started_at: number;
  ended_at?: number | null;
  error?: string | null;
}

export const TERMINAL_WORKFLOW_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
] as const;

export function isWorkflowRunTerminal(status: string): boolean {
  return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

// ─── Wire envelopes (server returns `{ workflow }` / `{ execution }`) ─

interface WorkflowEnvelope {
  workflow: Workflow;
}

interface ExecutionEnvelope {
  execution: WorkflowExecution;
}

// ─── Client ──────────────────────────────────────────────────────────

export class WorkflowsClient {
  constructor(private readonly config: WorkflowsClientConfig) {
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
      this.config.timeoutMs ?? 120_000,
    );
    try {
      const init: RequestInit = {
        method,
        headers: this.headers(),
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const resp = await fetch(url, init);
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

  // ── CRUD ──────────────────────────────────────────────────────────

  /**
   * `POST /v1/workflows` — create a workflow definition.
   *
   * The server validates cycles, transition targets, choice operators,
   * and the per-tenant cap (100) before returning 201.
   */
  async create(input: CreateWorkflowInput): Promise<Workflow> {
    const body: Record<string, unknown> = {
      name: input.name,
      start_at: input.startAt,
      states: input.states,
    };
    if (input.description !== undefined) body.description = input.description;
    const env = (await this.request<WorkflowEnvelope>("POST", "/v1/workflows", body))!;
    return env.workflow;
  }

  /**
   * `PATCH /v1/workflows/:id` — replace the workflow definition in place.
   *
   * Body shape is identical to {@link create} (`CreateWorkflowInput`). The
   * server keeps the workflow id, tenant_id, and created_at ; refreshes
   * name/description/start_at/states ; bumps `updated_at` and the monotonic
   * `version` int. Same validations as create — cycles, transition targets,
   * choice operators. Returns the updated workflow.
   */
  async update(workflowId: string, input: CreateWorkflowInput): Promise<Workflow> {
    const body: Record<string, unknown> = {
      name: input.name,
      start_at: input.startAt,
      states: input.states,
    };
    if (input.description !== undefined) body.description = input.description;
    const env = (await this.request<WorkflowEnvelope>(
      "PATCH",
      `/v1/workflows/${workflowId}`,
      body,
    ))!;
    return env.workflow;
  }

  /** `GET /v1/workflows` — list workflows for the calling tenant. */
  async list(): Promise<WorkflowListResponse> {
    return (await this.request<WorkflowListResponse>("GET", "/v1/workflows"))!;
  }

  /** `GET /v1/workflows/:id` */
  async get(workflowId: string): Promise<Workflow> {
    const env = (await this.request<WorkflowEnvelope>(
      "GET",
      `/v1/workflows/${workflowId}`,
    ))!;
    return env.workflow;
  }

  /** `DELETE /v1/workflows/:id` */
  async delete(workflowId: string): Promise<void> {
    await this.request<void>("DELETE", `/v1/workflows/${workflowId}`);
  }

  // ── Runs ──────────────────────────────────────────────────────────

  /**
   * `POST /v1/workflows/:id/runs` — start an async execution.
   *
   * Returns 202 with an `execution_id` immediately. Poll {@link getRun}
   * or use {@link waitForRun} to await completion.
   */
  async startRun(
    workflowId: string,
    input?: unknown,
  ): Promise<StartRunResponse> {
    const body: Record<string, unknown> = {};
    if (input !== undefined) body.input = input;
    return (await this.request<StartRunResponse>(
      "POST",
      `/v1/workflows/${workflowId}/runs`,
      body,
    ))!;
  }

  /** `GET /v1/workflows/:id/runs/:execution_id` — fetch one execution. */
  async getRun(
    workflowId: string,
    executionId: string,
  ): Promise<WorkflowExecution> {
    const env = (await this.request<ExecutionEnvelope>(
      "GET",
      `/v1/workflows/${workflowId}/runs/${executionId}`,
    ))!;
    return env.execution;
  }

  /**
   * Poll {@link getRun} until the run reaches a terminal status.
   *
   * Rejects with an error if the run hasn't terminated within
   * `timeoutMs`. The server enforces its own 60s wall-clock cap per run,
   * so a timeout larger than ~75_000 is just slack for polling overhead.
   */
  async waitForRun(
    workflowId: string,
    executionId: string,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<WorkflowExecution> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const execution = await this.getRun(workflowId, executionId);
      if (isWorkflowRunTerminal(execution.status)) return execution;
      if (Date.now() >= deadline) {
        throw new Error(
          `workflow run ${executionId} did not terminate within ${timeoutMs}ms ` +
            `(last status: ${execution.status})`,
        );
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}
