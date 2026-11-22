/**
 * `streamTask` always ends on the terminal event: when the server has no
 * stream (404) or the stream closes before its last event, the task is read
 * and the terminal event is built from it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentsClient,
  HttpError,
  isTerminalTransition,
  STREAM_IDLE_TIMEOUT_MS,
  terminalPayload,
  WITHHELD_RESULT,
  type StateTransition,
} from "../src/agents";

afterEach(() => {
  vi.restoreAllMocks();
});

const VERIFICATION = {
  verdict: "SAFE",
  hallucination_rate: 0,
  confidence: 0.9,
  trust_score: 1,
  verification_source: "sources",
  claims: [{ text: "30 days", supported: true, confidence: 0.9 }],
};

function task(status: string, extra: Record<string, unknown> = {}) {
  return {
    task_id: "t1",
    tenant_id: "tn",
    status,
    prompt: "q",
    created_at: 1,
    updated_at: 2,
    result: status === "completed" ? "30 days" : null,
    verification: status === "completed" ? VERIFICATION : null,
    ...extra,
  };
}

function transition(name: string): StateTransition {
  return {
    state_name: name,
    to_state: "NEXT",
    condition: "ok",
    raw_output: "draft",
    validation_notes: [],
    timestamp: 1,
    success: true,
    retry_count: 0,
    duration_ms: 10,
    prompt_tokens: 0,
    completion_tokens: 0,
    repair_count: 0,
    cache_hit: false,
  };
}

/** SSE body with these events; `cut` errors the stream after them. */
function sse(events: StateTransition[], cut = false): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(": keep-alive\n\n"));
      for (const ev of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
    },
    // Once the events are read: the connection drops, or the server closes.
    pull(controller) {
      if (cut) controller.error(new TypeError("terminated"));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Routes `/stream` and the task read; records each URL hit. */
function route(
  stream: (signal: AbortSignal) => Response | Promise<Response>,
  get: () => Response,
): string[] {
  const hits: string[] = [];
  (globalThis as { fetch: unknown }).fetch = vi
    .fn()
    .mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      hits.push(url);
      return url.includes("/stream") ? stream(init!.signal!) : get();
    });
  return hits;
}

/** A stream that sends these events then stays silent, failing (like a real
 * fetch body) only when the request is aborted. */
function silentAfter(events: StateTransition[], signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const ev of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Whether `p` settled once the event loop has turned a few times. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 20 && !done; i++) await new Promise((r) => setImmediate(r));
  return done;
}

async function collect(client: AgentsClient): Promise<StateTransition[]> {
  const got: StateTransition[] = [];
  for await (const ev of client.streamTask("t1")) got.push(ev);
  return got;
}

const client = () => new AgentsClient({ baseUrl: "http://x", apiKey: "k", maxRetries: 0 });

describe("AgentsClient.streamTask fallback", () => {
  it("falls back to the task on a 404 and ends on its terminal event", async () => {
    route(
      () => json(404, { error: "No active stream for task: t1" }),
      () => json(200, task("completed")),
    );
    // Without the fallback, the 404 rejected with an HttpError.
    const got = await collect(client());
    expect(got).toHaveLength(1);
    const last = got[0]!;
    expect(isTerminalTransition(last)).toBe(true);
    expect(last.state_name).toBe("TASK_COMPLETED");
    expect(last.condition).toBe("Already finished");
    expect(last.success).toBe(true);
    const payload = terminalPayload(last);
    expect(payload?.status).toBe("completed");
    expect(payload?.result).toBe("30 days");
    expect(payload?.verification?.verdict).toBe("SAFE");
  });

  it("completes a stream that closed before its terminal event", async () => {
    route(
      () => sse([transition("PLAN")]),
      () => json(200, task("failed", { error: "boom" })),
    );
    const got = await collect(client());
    // Without the fallback, the generator ended on PLAN, with no result.
    expect(got.map((e) => e.state_name)).toEqual(["PLAN", "TASK_FAILED"]);
    expect(got[1]!.success).toBe(false);
    expect(terminalPayload(got[1]!)?.error).toBe("boom");
  });

  it("completes a stream cut mid-body", async () => {
    route(
      () => sse([transition("PLAN")], true),
      () => json(200, task("completed")),
    );
    const got = await collect(client());
    expect(got.map((e) => e.state_name)).toEqual(["PLAN", "TASK_COMPLETED"]);
  });

  it("does not read the task when the stream delivered its terminal event", async () => {
    const terminal: StateTransition = {
      ...transition("TASK_COMPLETED"),
      to_state: null,
      condition: "terminal",
      raw_output: JSON.stringify({ task_id: "t1", status: "completed", result: "ok" }),
    };
    const hits = route(
      () => sse([transition("PLAN"), terminal]),
      () => json(500, {}),
    );
    const got = await collect(client());
    expect(got.map((e) => e.condition)).toEqual(["ok", "terminal"]);
    expect(hits).toEqual(["http://x/v1/tasks/t1/stream"]);
  });

  it("ends without a terminal event on a task paused for approval", async () => {
    route(
      () => json(404, { error: "No active stream" }),
      () => json(200, task("paused_for_approval")),
    );
    expect(await collect(client())).toEqual([]);
  });

  it("still rejects with the 404 of a task that does not exist", async () => {
    route(
      () => json(404, { error: "Task not found: t1" }),
      () => json(404, { error: "Task not found: t1" }),
    );
    const err = await collect(client()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });

  it("does not stop on a workflow state named like a terminal status", async () => {
    // A custom workflow whose last state is called TASK_COMPLETED: the
    // sequential executor sends it with no next state.
    const workflowState: StateTransition = {
      ...transition("TASK_COMPLETED"),
      to_state: null,
      condition: "Sequential execution",
      raw_output: '{"summary": "draft"}',
    };
    const terminal: StateTransition = {
      ...transition("TASK_COMPLETED"),
      to_state: null,
      condition: "terminal",
      raw_output: JSON.stringify({ task_id: "t1", status: "completed", result: "ok" }),
    };
    route(
      () => sse([workflowState, terminal]),
      () => json(500, {}),
    );
    const got = await collect(client());
    // Without the condition check, the generator stopped on the workflow state.
    expect(got.map((e) => e.condition)).toEqual(["Sequential execution", "terminal"]);
    expect(isTerminalTransition(got[0]!)).toBe(false);
    expect(terminalPayload(got[1]!)?.result).toBe("ok");
  });

  it("gives a withheld run's marker, not its answer, in the event it builds", async () => {
    route(
      () => json(404, { error: "No active stream" }),
      () => json(200, task("completed", { output_withheld: true, verification: null })),
    );
    const got = await collect(client());
    expect(terminalPayload(got[0]!)?.result).toBe(WITHHELD_RESULT);
    expect(got[0]!.raw_output).not.toContain("30 days");
  });

  it("keeps the verification exactly as the server sent it", async () => {
    const verification = {
      ...VERIFICATION,
      verdict: "SOMETHING_NEW",
      failure_reason: "injection blocked at stage 2",
      failure_stage: "guard",
    };
    route(
      () => json(404, { error: "No active stream" }),
      () => json(200, task("failed", { verification })),
    );
    const got = await collect(client());
    expect(terminalPayload(got[0]!)?.verification).toEqual(verification);
  });

  it("waits out a restart while reading the task", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let reads = 0;
    route(
      () => json(404, { error: "No active stream" }),
      () => (++reads <= 5 ? json(503, { error: "restarting" }) : json(200, task("completed"))),
    );
    const fast = new AgentsClient({ baseUrl: "http://x", maxRetries: 0, retryBackoffMs: 1 });
    // Without the outage loop, the first 503 rejected the generator.
    const got = await collect(fast);
    expect(terminalPayload(got[0]!)?.result).toBe("30 days");
    expect(reads).toBe(6);
  });

  describe("idle bound", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    afterEach(() => vi.useRealTimers());

    it("falls back to the task when the stream goes silent", async () => {
      route(
        (signal) => silentAfter([transition("PLAN")], signal),
        () => json(200, task("completed")),
      );
      const got: StateTransition[] = [];
      const run = (async () => {
        for await (const ev of client().streamTask("t1")) got.push(ev);
      })();
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
      // Without the idle timer, the read never settled.
      expect(await settled(run)).toBe(true);
      expect(got.map((e) => e.state_name)).toEqual(["PLAN", "TASK_COMPLETED"]);
    });

    it("falls back to the task when the stream's headers never come", async () => {
      route(
        (signal) =>
          new Promise<Response>((_, reject) =>
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
          ),
        () => json(200, task("completed")),
      );
      const run = collect(client());
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
      expect(await settled(run)).toBe(true);
      expect((await run).map((e) => e.state_name)).toEqual(["TASK_COMPLETED"]);
    });
  });
});
