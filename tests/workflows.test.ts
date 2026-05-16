/**
 * Unit tests for the Workflows SDK surface.
 *
 * Stubs `fetch` to verify request shape (method, path, body) and
 * response parsing for `create`, `list`, `get`, `delete`, `startRun`,
 * `getRun`, and the `waitForRun` polling helper.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isWorkflowRunTerminal,
  WorkflowsClient,
  type StartRunResponse,
  type Workflow,
  type WorkflowExecution,
  type WorkflowListResponse,
} from "../src/workflows";

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

const sampleWorkflow: Workflow = {
  id: "wf_1",
  tenant_id: "t1",
  name: "triage",
  start_at: "Compute",
  states: { Compute: { type: "Succeed" } },
  version: "1.0",
  created_at: 100,
  updated_at: 200,
};

describe("isWorkflowRunTerminal", () => {
  it("matches succeeded/failed/timed_out", () => {
    expect(isWorkflowRunTerminal("succeeded")).toBe(true);
    expect(isWorkflowRunTerminal("failed")).toBe(true);
    expect(isWorkflowRunTerminal("timed_out")).toBe(true);
  });
  it("rejects running", () => {
    expect(isWorkflowRunTerminal("running")).toBe(false);
    expect(isWorkflowRunTerminal("queued")).toBe(false);
  });
});

describe("WorkflowsClient.create", () => {
  it("POSTs the snake_case body and unwraps `workflow`", async () => {
    let captured: { method?: string; path?: string; body?: string } = {};
    stubFetch((url, init) => {
      captured.method = init?.method;
      captured.path = new URL(url).pathname;
      captured.body = init?.body as string;
      return new Response(JSON.stringify({ workflow: sampleWorkflow }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const c = new WorkflowsClient({ baseUrl: "http://x", apiKey: "k" });
    const wf = await c.create({
      name: "triage",
      startAt: "Compute",
      states: { Compute: { type: "Succeed" } },
    });
    expect(captured.method).toBe("POST");
    expect(captured.path).toBe("/v1/workflows");
    const parsed = JSON.parse(captured.body ?? "{}");
    expect(parsed.start_at).toBe("Compute");
    expect(parsed.name).toBe("triage");
    expect(wf.id).toBe("wf_1");
  });
});

describe("WorkflowsClient.update", () => {
  it("PATCHes /v1/workflows/:id with the snake_case body and unwraps `workflow`", async () => {
    let captured: { method?: string; path?: string; body?: string } = {};
    stubFetch((url, init) => {
      captured.method = init?.method;
      captured.path = new URL(url).pathname;
      captured.body = init?.body as string;
      return new Response(JSON.stringify({ workflow: { ...sampleWorkflow, version: "2" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const c = new WorkflowsClient({ baseUrl: "http://x", apiKey: "k" });
    const wf = await c.update("wf_1", {
      name: "triage-v2",
      startAt: "Compute",
      states: { Compute: { type: "Succeed" } },
      description: "post-fix",
    });
    expect(captured.method).toBe("PATCH");
    expect(captured.path).toBe("/v1/workflows/wf_1");
    const parsed = JSON.parse(captured.body ?? "{}");
    expect(parsed.start_at).toBe("Compute");
    expect(parsed.name).toBe("triage-v2");
    expect(parsed.description).toBe("post-fix");
    expect(wf.version).toBe("2");
  });
});

describe("WorkflowsClient.list", () => {
  it("GETs /v1/workflows and returns the wrapper", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ workflows: [sampleWorkflow] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const c = new WorkflowsClient({ baseUrl: "http://x" });
    const r: WorkflowListResponse = await c.list();
    expect(r.workflows).toHaveLength(1);
    expect(r.workflows[0].id).toBe("wf_1");
  });
});

describe("WorkflowsClient.get + delete", () => {
  it("GETs by id and unwraps `workflow`", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ workflow: sampleWorkflow }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const c = new WorkflowsClient({ baseUrl: "http://x" });
    const wf = await c.get("wf_1");
    expect(wf.name).toBe("triage");
  });

  it("DELETEs and returns void on 204", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const c = new WorkflowsClient({ baseUrl: "http://x" });
    await expect(c.delete("wf_1")).resolves.toBeUndefined();
  });
});

describe("WorkflowsClient.startRun + getRun", () => {
  it("POSTs input and returns execution_id", async () => {
    const resp: StartRunResponse = {
      execution_id: "wfr_abc",
      workflow_id: "wf_1",
      status: "running",
    };
    let capturedBody = "";
    stubFetch((_url, init) => {
      capturedBody = (init?.body as string) ?? "";
      return new Response(JSON.stringify(resp), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });
    const c = new WorkflowsClient({ baseUrl: "http://x" });
    const r = await c.startRun("wf_1", { a: 1, b: 2 });
    expect(r.execution_id).toBe("wfr_abc");
    const parsed = JSON.parse(capturedBody);
    expect(parsed.input).toEqual({ a: 1, b: 2 });
  });

  it("GETs run by execution_id and unwraps `execution`", async () => {
    const execution: WorkflowExecution = {
      id: "wfr_abc",
      workflow_id: "wf_1",
      tenant_id: "t1",
      status: "succeeded",
      input: { a: 1 },
      output: { answer: 3 },
      started_at: 100,
      ended_at: 110,
      current_state: null,
    };
    stubFetch(() =>
      new Response(JSON.stringify({ execution }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const c = new WorkflowsClient({ baseUrl: "http://x" });
    const r = await c.getRun("wf_1", "wfr_abc");
    expect(r.status).toBe("succeeded");
    expect(r.output).toEqual({ answer: 3 });
  });
});

describe("WorkflowsClient.waitForRun", () => {
  it("polls until terminal", async () => {
    let n = 0;
    stubFetch(() => {
      n += 1;
      const execution: WorkflowExecution = {
        id: "wfr_abc",
        workflow_id: "wf_1",
        tenant_id: "t1",
        status: n < 3 ? "running" : "succeeded",
        input: null,
        output: n >= 3 ? { ok: true } : undefined,
        started_at: 100,
        ended_at: n >= 3 ? 110 : null,
      };
      return new Response(JSON.stringify({ execution }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const c = new WorkflowsClient({ baseUrl: "http://x" });
    const final = await c.waitForRun("wf_1", "wfr_abc", {
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    expect(final.status).toBe("succeeded");
    expect(n).toBe(3);
  });

  it("throws on timeout", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          execution: {
            id: "wfr_x",
            workflow_id: "wf_1",
            tenant_id: "t1",
            status: "running",
            input: null,
            started_at: 100,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const c = new WorkflowsClient({ baseUrl: "http://x" });
    await expect(
      c.waitForRun("wf_1", "wfr_x", { timeoutMs: 30, pollIntervalMs: 5 }),
    ).rejects.toThrow(/did not terminate/);
  });
});
