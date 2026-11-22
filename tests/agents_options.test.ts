/**
 * Run options (webhook, server retries, share), customPreset at creation,
 * the HITL calls and the typed wait timeout of AgentsClient, against a
 * stubbed fetch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentsClient,
  DEFAULT_WAIT_TIMEOUT_MS,
  PAUSED_EXPIRED_ERROR,
  type Task,
} from "../src/agents";
import { TaskTimeoutError, TimeoutError, WauldoError } from "../src/errors";
import * as sdk from "../src/index";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

const RUNNING: Task = {
  task_id: "t1",
  tenant_id: "t",
  status: "running",
  prompt: "hi",
  created_at: 1,
  updated_at: 2,
};

const AGENT = {
  id: "a1",
  tenant_id: "t",
  name: "bot",
  description: "",
  wauldo_toml: "[agent]",
  model_provider: "openrouter",
  model_name: "qwen",
  created_at: 0,
  updated_at: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every request answers `reply` (JSON, 200); the calls are recorded. */
function stub(reply: unknown): Call[] {
  return stubEach([reply]);
}

/** Each request answers the next of `replies`, the last one repeated. */
function stubEach(replies: unknown[]): Call[] {
  const calls: Call[] = [];
  (globalThis as { fetch: unknown }).fetch = vi
    .fn()
    .mockImplementation(async (input: string | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: input.toString(),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      return new Response(JSON.stringify(reply), { status: 200 });
    });
  return calls;
}

const client = () => new AgentsClient({ baseUrl: "http://stub" });

describe("run options", () => {
  it("sends webhook_url, max_retries and auto_share, and reads the share link", async () => {
    const calls = stub({
      task_id: "t1",
      agent_id: "a1",
      status: "queued",
      created_at: 0,
      share_id: "r_x",
      share_url: "https://wauldo.com/r/r_x",
    });
    const resp = await client().run("a1", "hi", undefined, undefined, {
      webhookUrl: "https://example.com/hook",
      maxRetries: 5,
      autoShare: true,
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://stub/v1/agents/a1/runs");
    expect(calls[0]!.body).toEqual({
      input: "hi",
      webhook_url: "https://example.com/hook",
      max_retries: 5,
      auto_share: true,
    });
    expect(resp.share_url).toBe("https://wauldo.com/r/r_x");
  });

  it("sends only the input without options", async () => {
    const calls = stub({ task_id: "t1", agent_id: "a1", status: "queued", created_at: 0 });
    await client().run("a1", "hi");
    expect(calls[0]!.body).toEqual({ input: "hi" });
  });

  it("runAndWait passes the run options through", async () => {
    const calls = stub({
      task_id: "t1",
      agent_id: "a1",
      status: "completed",
      created_at: 0,
      task: { ...RUNNING, status: "completed" },
    });
    await client().runAndWait("a1", "hi", { webhookUrl: "https://example.com/h", autoShare: false });
    expect(calls[0]!.body).toEqual({
      input: "hi",
      webhook_url: "https://example.com/h",
      auto_share: false,
    });
    expect(calls[0]!.url).toMatch(/\?wait=\d+$/);
  });
});

describe("create", () => {
  it("sends custom_preset", async () => {
    const calls = stub(AGENT);
    const contract = { name: "flow", states: [] };
    await client().create({ name: "bot", wauldoToml: "[agent]", customPreset: contract });
    expect(calls[0]!.body!.custom_preset).toEqual(contract);
  });

  it("omits custom_preset when not given", async () => {
    const calls = stub(AGENT);
    await client().create({ name: "bot", wauldoToml: "[agent]" });
    expect(calls[0]!.body).not.toHaveProperty("custom_preset");
  });
});

describe("human in the loop", () => {
  const reply = { task_id: "t1", previous_status: "running", new_status: "paused_for_approval" };

  it.each([
    ["pauseTask", "pause"],
    ["approveTask", "approve"],
    ["rejectTask", "reject"],
  ] as const)("%s posts the transition", async (method, action) => {
    const calls = stub(reply);
    const out = await client()[method]("t1");
    expect(calls).toEqual([
      { method: "POST", url: `http://stub/v1/tasks/t1/${action}`, body: {} },
    ]);
    expect(out.new_status).toBe("paused_for_approval");
  });

  it("sends the reason when given", async () => {
    const calls = stub(reply);
    await client().rejectTask("t1", "wrong account");
    expect(calls[0]!.body).toEqual({ reason: "wrong account" });
  });

  it("resumeTask posts and resolves with the new task", async () => {
    const calls = stub({ task_id: "t2", status: "queued", created_at: 9 });
    const out = await client().resumeTask("t1");
    expect(calls).toEqual([
      { method: "POST", url: "http://stub/v1/tasks/t1/resume", body: {} },
    ]);
    expect(out.task_id).toBe("t2");
    expect(out.agent_id).toBe("");
    expect(out.status).toBe("queued");
  });

  it("reads the decisions of a task, with their notes", async () => {
    stub({
      ...RUNNING,
      status: "cancelled",
      error: PAUSED_EXPIRED_ERROR,
      decisions: [{ action: "pause", reason: "check the total", at: 10 }],
    });
    const task = await client().getTask("t1");
    expect(task.decisions).toEqual([{ action: "pause", reason: "check the total", at: 10 }]);
    expect(sdk.PAUSED_EXPIRED_ERROR).toBe(PAUSED_EXPIRED_ERROR);
  });
});

describe("getTask includeJournal", () => {
  it("is sent only when given, beside the wait", async () => {
    const calls = stub(RUNNING);
    await client().getTask("t1");
    await client().getTask("t1", { includeJournal: false });
    await client().getTask("t1", { includeJournal: true, waitSeconds: 5 });
    expect(calls.map((c) => c.url)).toEqual([
      "http://stub/v1/tasks/t1",
      "http://stub/v1/tasks/t1?include_journal=false",
      "http://stub/v1/tasks/t1?wait=5&include_journal=true",
    ]);
  });

  it("is not sent by waitForTask", async () => {
    const calls = stub({ ...RUNNING, status: "completed" });
    await client().waitForTask("t1");
    expect(calls[0]!.url).not.toContain("include_journal");
  });
});

describe("wait timeout", () => {
  it("rejects with a TaskTimeoutError carrying the task and its last status", async () => {
    stub(RUNNING);
    const err = await client()
      .waitForTask("t1", { timeoutMs: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskTimeoutError);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toBeInstanceOf(WauldoError);
    expect(err).toBeInstanceOf(Error);
    const e = err as TaskTimeoutError;
    expect(e.name).toBe("TaskTimeoutError");
    expect(e.taskId).toBe("t1");
    expect(e.lastStatus).toBe("running");
    expect(e.timeout).toBe(0);
    expect(e.message.startsWith("task t1 still in status 'running' after 0ms")).toBe(true);
  });

  it("says the task may still run, and waiting again with its id gets the result", async () => {
    // The wait gives up while the run goes on: the error names the task and
    // says how to keep waiting, and doing so resolves with the result.
    const calls = stubEach([RUNNING, { ...RUNNING, status: "completed", result: "done" }]);
    const err = (await client()
      .waitForTask("t1", { timeoutMs: 0 })
      .catch((e: unknown) => e)) as TaskTimeoutError;
    expect(err).toBeInstanceOf(TaskTimeoutError);
    expect(err.message).toContain("may still be running on the server");
    expect(err.message).toContain('waitForTask("t1")');
    const task = await client().waitForTask(err.taskId, { timeoutMs: 5_000 });
    expect(task.status).toBe("completed");
    expect(task.result).toBe("done");
    expect(calls.every((c) => c.url.startsWith("http://stub/v1/tasks/t1"))).toBe(true);
  });

  it("runAndWait rejects with the same error", async () => {
    stub(RUNNING);
    await expect(client().runAndWait("a1", "hi", { timeoutMs: 0 })).rejects.toBeInstanceOf(
      TaskTimeoutError,
    );
  });

  it("is exported from the package root", () => {
    expect(sdk.TaskTimeoutError).toBe(TaskTimeoutError);
    expect(sdk.DEFAULT_WAIT_TIMEOUT_MS).toBe(DEFAULT_WAIT_TIMEOUT_MS);
  });

  it("waits DEFAULT_WAIT_TIMEOUT_MS by default", async () => {
    // The default covers ordinary runs; it is not a bound on the server's run
    // time (a long run outlasts it: the test above shows how to keep waiting).
    vi.useFakeTimers();
    try {
      stub(RUNNING);
      const start = Date.now();
      let settledAfter = -1;
      const done = client()
        .waitForTask("t1", { pollIntervalMs: 1_000 })
        .catch(() => {
          settledAfter = Date.now() - start;
        });
      await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_TIMEOUT_MS + 5_000);
      await done;
      expect(settledAfter).toBeGreaterThanOrEqual(DEFAULT_WAIT_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
