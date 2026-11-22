/**
 * Retries on AgentsClient.request and the terminal-event helpers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentsClient,
  HttpError,
  isTerminalTransition,
  retryDelayMs,
  terminalPayload,
  type StateTransition,
} from "../src/agents";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Answer each call from `plan` in order; the last entry repeats. */
function stubSequence(plan: Array<() => Response>): { calls: () => number } {
  let n = 0;
  (globalThis as { fetch: unknown }).fetch = vi.fn().mockImplementation(async () => {
    const make = plan[Math.min(n, plan.length - 1)];
    n += 1;
    return make();
  });
  return { calls: () => n };
}

const task = () =>
  new Response(
    JSON.stringify({ task_id: "t1", tenant_id: "tn", status: "completed", prompt: "hi", created_at: 1, updated_at: 2 }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
const run = () =>
  new Response(JSON.stringify({ task_id: "t1", agent_id: "a", status: "queued", created_at: 0 }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

function client(extra: Record<string, unknown> = {}) {
  return new AgentsClient({ baseUrl: "http://x", retryBackoffMs: 1, ...extra });
}

describe("AgentsClient retries", () => {
  it("retries a 503 until the server answers", async () => {
    const seq = stubSequence([
      () => new Response("", { status: 503 }),
      () => new Response("", { status: 503 }),
      task,
    ]);
    const t = await client().getTask("t1");
    expect(t.task_id).toBe("t1");
    expect(seq.calls()).toBe(3);
  });

  it("does not replay a POST that got a 500: the run may have started", async () => {
    const seq = stubSequence([() => new Response("boom", { status: 500 })]);
    await expect(client().run("a", "hi")).rejects.toBeInstanceOf(HttpError);
    expect(seq.calls()).toBe(1);
  });

  it("retries a 429 on a POST (the server did not take the request)", async () => {
    const seq = stubSequence([
      () => new Response("", { status: 429, headers: { "Retry-After": "0" } }),
      run,
    ]);
    const r = await client().run("a", "hi");
    expect(r.task_id).toBe("t1");
    expect(seq.calls()).toBe(2);
  });

  it("retries a GET whose connection failed, not a POST", async () => {
    const seqGet = stubSequence([
      () => { throw new TypeError("fetch failed"); },
      task,
    ]);
    await client().getTask("t1");
    expect(seqGet.calls()).toBe(2);

    const seqPost = stubSequence([() => { throw new TypeError("fetch failed"); }]);
    await expect(client().run("a", "hi")).rejects.toBeInstanceOf(TypeError);
    expect(seqPost.calls()).toBe(1);
  });

  it("gives up after maxRetries, and 0 disables retries", async () => {
    const seq = stubSequence([() => new Response("", { status: 503 })]);
    await expect(client({ maxRetries: 2 }).getTask("t1")).rejects.toBeInstanceOf(HttpError);
    expect(seq.calls()).toBe(3);

    const none = stubSequence([() => new Response("", { status: 503 })]);
    await expect(client({ maxRetries: 0 }).getTask("t1")).rejects.toBeInstanceOf(HttpError);
    expect(none.calls()).toBe(1);
  });
});

describe("retryDelayMs", () => {
  it("honours Retry-After up to 30 s, else doubles from the backoff with jitter", () => {
    expect(retryDelayMs(0, 500, "2")).toBe(2_000);
    expect(retryDelayMs(0, 500, "600")).toBe(30_000);
    expect(retryDelayMs(0, 500, "soon")).toBeGreaterThanOrEqual(500);
    const d1 = retryDelayMs(1, 500, null);
    expect(d1).toBeGreaterThanOrEqual(1_000);
    expect(d1).toBeLessThan(1_250);
    expect(retryDelayMs(9, 500, null)).toBeLessThan(8_250);
  });
});

describe("terminal event helpers", () => {
  const base: StateTransition = {
    state_name: "Analysis",
    to_state: "Answer",
    condition: "ok",
    raw_output: "{\"task_id\":\"t1\"}",
    validation_notes: [],
    timestamp: 0,
    success: true,
    retry_count: 0,
    duration_ms: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    repair_count: 0,
    cache_hit: false,
  };

  it("reads the payload off the last event only", () => {
    const terminal: StateTransition = {
      ...base,
      state_name: "TASK_COMPLETED",
      to_state: null,
      condition: "terminal",
      raw_output: JSON.stringify({ task_id: "t1", status: "completed", result: "30 days", error: null, verification: null }),
    };
    expect(isTerminalTransition(terminal)).toBe(true);
    expect(terminalPayload(terminal)?.result).toBe("30 days");
    expect(isTerminalTransition(base)).toBe(false);
    expect(terminalPayload(base)).toBeNull();
    expect(terminalPayload({ ...terminal, raw_output: "" })).toBeNull();
  });
});
