/**
 * Agents errors: HttpError in the WauldoError hierarchy, and the
 * parsed `code: message` of a failed task.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentsClient,
  HttpError,
  ServerError,
  TASK_ERROR_CODES,
  WauldoError,
  WorkflowsClient,
  taskErrorInfo,
  type Task,
} from "../src/index";

afterEach(() => {
  vi.restoreAllMocks();
});

const ERROR_BODY = JSON.stringify({ error: { message: "Invalid API key", type: "unauthorized" } });

function stubUnauthorized(): void {
  (globalThis as { fetch: unknown }).fetch = vi.fn().mockImplementation(
    async () =>
      new Response(ERROR_BODY, {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      }),
  );
}

function expectAgentsHttpError(err: unknown): void {
  expect(err).toBeInstanceOf(WauldoError);
  expect(err).toBeInstanceOf(ServerError);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toBeInstanceOf(Error);
  const e = err as HttpError;
  expect(e.status).toBe(401);
  expect(e.code).toBe(401);
  expect(e.statusText).toBe("Unauthorized");
  expect(e.body).toBe(ERROR_BODY);
  expect(e.name).toBe("HttpError");
  expect(e.message).toBe(`HTTP 401 Unauthorized: ${ERROR_BODY}`);
  expect(e.toString()).toBe(`HttpError: HTTP 401 Unauthorized: ${ERROR_BODY}`);
}

describe("HttpError", () => {
  it("is a WauldoError when AgentsClient gets an error status", async () => {
    stubUnauthorized();
    const err = await new AgentsClient({ baseUrl: "http://x", maxRetries: 0 })
      .getTask("t1")
      .catch((e: unknown) => e);
    expectAgentsHttpError(err);
  });

  it("is a WauldoError when WorkflowsClient gets an error status", async () => {
    stubUnauthorized();
    const err = await new WorkflowsClient({ baseUrl: "http://x" }).get("wf1").catch((e: unknown) => e);
    expectAgentsHttpError(err);
  });
});

describe("taskErrorInfo", () => {
  it.each([...TASK_ERROR_CODES])("parses the known code %s", (code) => {
    expect(taskErrorInfo({ error: `${code}: Something to read.` })).toEqual({
      code,
      message: "Something to read.",
    });
  });

  it("keeps an unknown code and the colons of the message", () => {
    const info = taskErrorInfo({ error: "quota_exceeded: Limit: 10 runs" });
    expect(info).toEqual({ code: "quota_exceeded", message: "Limit: 10 runs" });
    expect(TASK_ERROR_CODES.has(info!.code!)).toBe(false);
  });

  it("gives no code when the error does not start with one", () => {
    for (const raw of [
      "Cancelled: no approval decision within 7 days",
      "internal error: the run did not complete",
      "plain text",
    ]) {
      expect(taskErrorInfo({ error: raw })).toEqual({ code: null, message: raw });
    }
    expect(taskErrorInfo({ error: null })).toBeNull();
    expect(taskErrorInfo({ error: "" })).toBeNull();
    expect(taskErrorInfo({})).toBeNull();
  });

  it("reads a failed task", () => {
    const task: Task = {
      task_id: "t1",
      tenant_id: "tn",
      status: "failed",
      prompt: "hi",
      created_at: 1,
      updated_at: 2,
      error: "invalid_preset: Unknown preset: my_presett",
    };
    expect(taskErrorInfo(task)).toEqual({ code: "invalid_preset", message: "Unknown preset: my_presett" });
    expect(task.error).toBe("invalid_preset: Unknown preset: my_presett");
  });
});
