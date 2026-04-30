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
  it("sends DELETE and returns void on 204", async () => {
    const seen: { method?: string; url: string }[] = [];
    stubFetch((url, init) => {
      seen.push({ method: init?.method, url });
      return new Response(null, { status: 204 });
    });
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    await expect(client.cancelTask("t1")).resolves.toBeUndefined();
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
    stubFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const got: StateTransition[] = [];
    for await (const ev of client.streamTask("t1")) {
      got.push(ev);
    }
    expect(got.length).toBe(2);
    expect(got[0]?.state_name).toBe("Analysis");
    expect(got[1]?.state_name).toBe("Tradeoffs");
    expect(got[0]?.duration_ms).toBe(1000);
  });

  it("throws on non-2xx responses", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const client = new AgentsClient({ baseUrl: "http://x", apiKey: "k" });
    const gen = client.streamTask("t1");
    await expect(gen.next()).rejects.toThrow(/HTTP 500/);
  });
});
