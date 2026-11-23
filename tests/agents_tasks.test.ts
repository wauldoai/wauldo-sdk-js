/**
 * Unit tests for the new Tasks + SSE surface on AgentsClient (v0.8.0).
 *
 * - getTask / cancelTask / waitForTask happy + timeout paths
 * - streamTask parsing of SSE `data:` frames into typed StateTransitions
 *
 * Uses vitest's fetch stub like the sibling agents_memory.test.ts file.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentsClient,
  isTerminalStatus,
  type StateTransition,
  type Task,
} from "../src/agents";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  (globalThis as { fetch: unknown }).fetch = vi
    .fn()
    .mockImplementation(async (input: string | URL, init?: RequestInit) => {
      return handler(input.toString(), init);
    });
}

describe("isTerminalStatus", () => {
  it("matches completed/failed/cancelled", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });
  it("rejects queued/running", () => {
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("AgentsClient.getTask — fields beyond the base record", () => {
  it("passes share, race result and the verification signals through", async () => {
    stubFetch(() => {
      const body: Task = {
        task_id: "t1",
        status: "completed",
        prompt: "hi",
        created_at: 1,
        updated_at: 2,
        share_id: "r_x",
        share_url: "https://wauldo.com/r/r_x",
        race_result: {
          winner: "model-a",
          winner_score: 0.9,
          candidates: [
            { model: "model-a", score: 0.9, timed_out: false },
            { model: "model-b", score: null, timed_out: true },
          ],
        },
        verification: {
          verdict: "INSUFFICIENT_CLAIMS",
          hallucination_rate: 0,
          confidence: 0,
          trust_score: 0,
          verification_source: "source_documents",
          claims: [],
          verification_retries: 0,
          honesty_signals: { is_non_answer: true, json_garbage: false },
          contract_attestation: {
            matches: false,
            verdict: "DEGRADED",
            replay_token: "rt",
            violations: [{ kind: "disallowed_tool", state: "PLAN", tool: "web_search" }],
          },
          failure_stage: "fact_check",
        },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const task = await new AgentsClient({ baseUrl: "http://x" }).getTask("t1");
    expect(task.tenant_id).toBeUndefined();
    expect(task.share_url).toBe("https://wauldo.com/r/r_x");
    expect(task.race_result?.candidates[1]?.timed_out).toBe(true);
    expect(task.verification?.verdict).toBe("INSUFFICIENT_CLAIMS");
    expect(task.verification?.honesty_signals?.is_non_answer).toBe(true);
    expect(task.verification?.contract_attestation?.verdict).toBe("DEGRADED");
    expect(task.verification?.failure_stage).toBe("fact_check");
  });
});

describe("AgentsClient.getTask", () => {
  it("returns typed Task with embedded verification + message", async () => {
    stubFetch(() => {
      const body: Task = {
        task_id: "t1",
        tenant_id: "tn",
        status: "completed",
        prompt: "hi",
        created_at: 1,
        updated_at: 2,
        result: "hello",
        verification: {
          verdict: "UNVERIFIED",
          hallucination_rate: 0.0,
          confidence: 1.0,
          trust_score: 0.0,
          verification_source: "prompt_only",
          claims: [],
          verification_retries: 0,
          message: "No source documents uploaded.",
        },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const task = await client.getTask("t1");
    expect(task.status).toBe("completed");
    expect(task.verification?.verdict).toBe("UNVERIFIED");
    expect(task.verification?.trust_score).toBe(0.0);
    expect(task.verification?.message).toContain("No source documents");
  });
});

describe("AgentsClient.cancelTask", () => {
  it("sends PUT (the server's cancel) and returns the cancelled task", async () => {
    const seen: { method?: string; url: string }[] = [];
    stubFetch((url, init) => {
      seen.push({ method: init?.method, url });
      return new Response(
        JSON.stringify({
          task_id: "t1",
          tenant_id: "tn",
          status: "cancelled",
          prompt: "",
          created_at: 0,
          updated_at: 0,
        }),
        { status: 200 },
      );
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const task = await client.cancelTask("t1");
    expect(task.status).toBe("cancelled");
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.url).toBe("http://x/v1/tasks/t1");
  });
});

describe("AgentsClient.deleteTask", () => {
  it("sends DELETE and resolves on 204", async () => {
    const seen: { method?: string; url: string }[] = [];
    stubFetch((url, init) => {
      seen.push({ method: init?.method, url });
      return new Response(null, { status: 204 });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    await expect(client.deleteTask("t1")).resolves.toBeUndefined();
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.url).toBe("http://x/v1/tasks/t1");
  });
});

describe("AgentsClient.waitForTask", () => {
  it("polls until terminal and returns the completed task", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      const status = calls < 3 ? "running" : "completed";
      const body = {
        task_id: "t1",
        tenant_id: "tn",
        status,
        prompt: "",
        created_at: 0,
        updated_at: 0,
      };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const task = await client.waitForTask("t1", {
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });
    expect(task.status).toBe("completed");
    expect(calls).toBe(3);
  });

  it("rejects with timeout when task stays running", async () => {
    stubFetch(() => {
      const body = {
        task_id: "t1",
        tenant_id: "tn",
        status: "running",
        prompt: "",
        created_at: 0,
        updated_at: 0,
      };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    await expect(
      client.waitForTask("t1", { timeoutMs: 30, pollIntervalMs: 5 }),
    ).rejects.toThrow(/still in status/);
  });
});

describe("AgentsClient.streamTask", () => {
  it("yields parsed StateTransition events from SSE frames", async () => {
    const events: StateTransition[] = [
      {
        state_name: "Analysis",
        to_state: "Tradeoffs",
        condition: "Sequential execution",
        raw_output: "",
        validation_notes: [],
        timestamp: 1,
        success: true,
        retry_count: 0,
        duration_ms: 1000,
        prompt_tokens: 10,
        completion_tokens: 200,
        repair_count: 0,
        cache_hit: false,
      },
      {
        state_name: "Tradeoffs",
        to_state: null,
        condition: "Sequential execution",
        raw_output: "",
        validation_notes: [],
        timestamp: 2,
        success: true,
        retry_count: 0,
        duration_ms: 2000,
        prompt_tokens: 10,
        completion_tokens: 300,
        repair_count: 0,
        cache_hit: false,
      },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const ev of events) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
        // keep-alive comment — must be ignored
        controller.enqueue(enc.encode(`: keep-alive\n\n`));
        controller.close();
      },
    });
    stubFetch((url) =>
      url.endsWith("/stream")
        ? new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        : new Response(
            JSON.stringify({ task_id: "t1", tenant_id: "tn", status: "completed", prompt: "", created_at: 0, updated_at: 0 }),
            { status: 200 },
          ),
    );
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const got: StateTransition[] = [];
    for await (const ev of client.streamTask("t1")) {
      got.push(ev);
    }
    // The stream closed without its terminal event: the last one is built
    // from the task (see agents_stream.test.ts).
    expect(got.length).toBe(3);
    expect(got[0]?.state_name).toBe("Analysis");
    expect(got[1]?.state_name).toBe("Tradeoffs");
    expect(got[2]?.state_name).toBe("TASK_COMPLETED");
    expect(got[0]?.duration_ms).toBe(1000);
  });

  it("throws on non-2xx responses", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const gen = client.streamTask("t1");
    await expect(gen.next()).rejects.toThrow(/HTTP 500/);
  });
});

// ─── Wait / one-call result (0.18.0) ────────────────────────────────────────

function taskBody(status: string, extra: Record<string, unknown> = {}) {
  return {
    task_id: "t1",
    tenant_id: "tn",
    status,
    prompt: "",
    created_at: 0,
    updated_at: 0,
    ...extra,
  };
}

describe("AgentsClient.run with waitSeconds", () => {
  it("adds ?wait= and parses the task carried by the response", async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          task_id: "t1",
          agent_id: "bot",
          status: "completed",
          created_at: 0,
          task: taskBody("completed", { result: "42" }),
        }),
        { status: 201 },
      );
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const resp = await client.run("bot", "Hello", undefined, undefined, {
      waitSeconds: 30,
    });
    expect(urls[0]).toBe("http://x/v1/agents/bot/runs?wait=30");
    expect(resp.status).toBe("completed");
    expect(resp.task?.result).toBe("42");
  });

  it("sends no query without waitSeconds, and clamps a large wait", async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return new Response(JSON.stringify(taskBody("running")), { status: 200 });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    await client.getTask("t1");
    await client.getTask("t1", { waitSeconds: 3600 });
    expect(urls).toEqual(["http://x/v1/tasks/t1", "http://x/v1/tasks/t1?wait=50"]);
  });
});

describe("AgentsClient.waitForTask (long poll)", () => {
  it("long-polls with ?wait= bounded by the remaining timeout", async () => {
    const urls: string[] = [];
    let calls = 0;
    stubFetch((url) => {
      urls.push(url);
      calls += 1;
      return new Response(
        JSON.stringify(taskBody(calls < 2 ? "running" : "completed")),
        { status: 200 },
      );
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const task = await client.waitForTask("t1", {
      timeoutMs: 10_000,
      pollIntervalMs: 1,
    });
    expect(task.status).toBe("completed");
    expect(urls[0]).toBe("http://x/v1/tasks/t1?wait=10");
    expect(urls.every((u) => u.includes("?wait="))).toBe(true);
  });

  it("resolves on a task paused for approval instead of timing out", async () => {
    stubFetch(
      () => new Response(JSON.stringify(taskBody("paused_for_approval")), { status: 200 }),
    );
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const task = await client.waitForTask("t1", { timeoutMs: 1000, pollIntervalMs: 1 });
    expect(task.status).toBe("paused_for_approval");
    expect(isTerminalStatus(task.status)).toBe(false);
  });
});

describe("AgentsClient.runAndWait", () => {
  it("returns the settled task in one round-trip when the wait pays off", async () => {
    const calls: { url: string; method?: string }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method });
      return new Response(
        JSON.stringify({
          task_id: "t1",
          agent_id: "bot",
          status: "completed",
          created_at: 0,
          task: taskBody("completed", { result: "42" }),
        }),
        { status: 201 },
      );
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const task = await client.runAndWait("bot", "Hello", { verificationMode: "strict" });
    expect(task.result).toBe("42");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://x/v1/agents/bot/runs?wait=50");
  });

  it("falls back to polling when the run outlives the wait", async () => {
    const methods: (string | undefined)[] = [];
    stubFetch((url, init) => {
      methods.push(init?.method);
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            task_id: "t1",
            agent_id: "bot",
            status: "running",
            created_at: 0,
            task: taskBody("running"),
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify(taskBody("completed", { result: "late" })), {
        status: 200,
      });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const task = await client.runAndWait("bot", "Hello", { timeoutMs: 10_000 });
    expect(task.result).toBe("late");
    expect(methods).toEqual(["POST", "GET"]);
  });

  it("rejects when the task never settles within timeoutMs", async () => {
    stubFetch((_url, init) =>
      new Response(
        JSON.stringify(
          init?.method === "POST"
            ? { task_id: "t1", agent_id: "bot", status: "running", created_at: 0 }
            : taskBody("running"),
        ),
        { status: init?.method === "POST" ? 201 : 200 },
      ),
    );
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    await expect(client.runAndWait("bot", "Hello", { timeoutMs: 30 })).rejects.toThrow(
      /still in status/,
    );
  });
});

describe("AgentsClient wait budget", () => {
  it("bounds the server-side wait by the client's own timeout", async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return new Response(JSON.stringify(taskBody("completed")), { status: 200 });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k", timeoutMs: 12_000 });
    await client.waitForTask("t1", { timeoutMs: 60_000 });
    // 30 s long poll, but the client would abort at 12 s: ask for 7 s.
    expect(urls[0]).toBe("http://x/v1/tasks/t1?wait=7");
  });
});

describe("AgentsClient.waitForTask at its deadline", () => {
  it("reads once without a server-side hold, then rejects", async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return new Response(JSON.stringify(taskBody("running")), { status: 200 });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    await expect(client.waitForTask("t1", { timeoutMs: 0, pollIntervalMs: 1 })).rejects.toThrow(
      /still in status/,
    );
    expect(urls).toEqual(["http://x/v1/tasks/t1"]);
  });
});
