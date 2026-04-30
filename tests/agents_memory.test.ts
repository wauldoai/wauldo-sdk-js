/**
 * Unit tests for AgentsClient + MemoryClient.
 *
 * Uses vitest's built-in fetch mock via globalThis overrides — no
 * dependency on msw or nock. Each test records the request and returns
 * a stubbed response so we can assert on URL, headers, body shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsClient, HttpError } from "../src/agents";
import { MemoryClient } from "../src/memory";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Stub {
  status?: number;
  body?: unknown;
  bodyBytes?: Uint8Array; // for size-cap tests
}

function installFetchStub(stub: Stub): Captured[] {
  const captured: Captured[] = [];
  (globalThis as { fetch: unknown }).fetch = vi
    .fn()
    .mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers as
        | Headers
        | Record<string, string>
        | undefined;
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (rawHeaders) {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      const bodyStr = init?.body as string | undefined;
      captured.push({
        url: input.toString(),
        method: init?.method ?? "GET",
        headers,
        body: bodyStr ? JSON.parse(bodyStr) : undefined,
      });
      const status = stub.status ?? 200;
      // HTTP spec: 204/205/304 MUST have a null body — the Response
      // constructor throws otherwise. Other statuses stream the bytes.
      if (status === 204 || status === 205 || status === 304) {
        return new Response(null, { status, statusText: "No Content" });
      }
      const bytes =
        stub.bodyBytes ??
        new TextEncoder().encode(stub.body ? JSON.stringify(stub.body) : "");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return new Response(stream, {
        status,
        statusText: status === 404 ? "Not Found" : "OK",
      });
    });
  return captured;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── AgentsClient tests ───────────────────────────────────────────

describe("AgentsClient", () => {
  const baseUrl = "http://127.0.0.1:9999";

  it("create posts full body and injects headers", async () => {
    const captured = installFetchStub({
      status: 201,
      body: {
        id: "a1",
        name: "bot",
        tenant_id: "t",
        description: "",
        wauldo_toml: "",
        model_provider: "openrouter",
        model_name: "qwen",
        created_at: 0,
        updated_at: 0,
      },
    });
    const client = new AgentsClient({ baseUrl, apiKey: "k", tenant: "t" });
    const out = await client.create({
      name: "bot",
      wauldoToml: "[agent]\nname = 'x'\n[model]\nprovider = 'o'\nname = 'm'",
      agentsMd: "---\nname: bot\n---\nBody",
      description: "test",
      preset: "general_task",
    });
    expect(out.id).toBe("a1");
    expect(captured[0].url).toBe(`${baseUrl}/v1/agents`);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].headers["authorization"]).toBe("Bearer k");
    expect(captured[0].headers["x-rapidapi-user"]).toBe("t");
    const body = captured[0].body as Record<string, unknown>;
    expect(body.name).toBe("bot");
    expect(body.preset).toBe("general_task");
    expect(body.agents_md).toBe("---\nname: bot\n---\nBody");
  });

  it("create omits undefined optional fields", async () => {
    const captured = installFetchStub({ status: 201, body: { id: "a" } });
    const client = new AgentsClient({ baseUrl });
    await client.create({ name: "x", wauldoToml: "[agent]\n[model]" });
    const body = captured[0].body as Record<string, unknown>;
    expect(body.agents_md).toBeUndefined();
    expect(body.mcp_json).toBeUndefined();
    expect(body.preset).toBeUndefined();
  });

  it("list builds query string", async () => {
    const captured = installFetchStub({
      body: { agents: [], pagination: { total: 0, limit: 10, offset: 5 } },
    });
    const client = new AgentsClient({ baseUrl });
    await client.list(10, 5);
    expect(captured[0].url).toBe(`${baseUrl}/v1/agents?limit=10&offset=5`);
  });

  it("get returns the agent", async () => {
    installFetchStub({ body: { id: "abc" } });
    const client = new AgentsClient({ baseUrl });
    const out = await client.get("abc");
    expect(out.id).toBe("abc");
  });

  it("update sends only provided patch fields", async () => {
    const captured = installFetchStub({ body: { id: "id1" } });
    const client = new AgentsClient({ baseUrl });
    await client.update("id1", { description: "new" });
    expect(captured[0].method).toBe("PATCH");
    expect(captured[0].body).toEqual({ description: "new" });
  });

  it("delete sends DELETE and returns void", async () => {
    installFetchStub({ status: 204 });
    const client = new AgentsClient({ baseUrl });
    const out = await client.delete("xyz");
    expect(out).toBeUndefined();
  });

  it("run forwards verification_mode", async () => {
    const captured = installFetchStub({
      status: 201,
      body: { task_id: "tk1", agent_id: "bot", status: "queued", created_at: 0 },
    });
    const client = new AgentsClient({ baseUrl });
    const out = await client.run("bot", "Hello", "strict");
    expect(out.task_id).toBe("tk1");
    const body = captured[0].body as Record<string, unknown>;
    expect(body.verification_mode).toBe("strict");
  });

  it("run forwards fact_check_mode", async () => {
    const captured = installFetchStub({
      status: 201,
      body: { task_id: "tk1", agent_id: "bot", status: "queued", created_at: 0 },
    });
    const client = new AgentsClient({ baseUrl });
    await client.run("bot", "Hello", undefined, "hybrid");
    const body = captured[0].body as Record<string, unknown>;
    expect(body.fact_check_mode).toBe("hybrid");
  });

  it("run omits fact_check_mode when not provided", async () => {
    const captured = installFetchStub({
      status: 201,
      body: { task_id: "tk1", agent_id: "bot", status: "queued", created_at: 0 },
    });
    const client = new AgentsClient({ baseUrl });
    await client.run("bot", "Hello");
    const body = captured[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty("fact_check_mode");
  });

  it("run rejects empty input locally", async () => {
    const client = new AgentsClient({ baseUrl });
    await expect(client.run("bot", "")).rejects.toThrow("input is required");
  });

  it("a2aInvoke sends trace header and body", async () => {
    const captured = installFetchStub({
      status: 201,
      body: {
        task_id: "tk",
        agent_id: "target",
        trace: ["caller", "target"],
        depth: 2,
        status: "queued",
      },
    });
    const client = new AgentsClient({ baseUrl });
    const out = await client.a2aInvoke("target", "do the thing", ["caller"]);
    expect(out.depth).toBe(2);
    expect(captured[0].headers["x-a2a-trace"]).toBe("caller");
    const body = captured[0].body as Record<string, unknown>;
    expect(body.input).toBe("do the thing");
  });

  it("a2aInvoke rejects empty input", async () => {
    const client = new AgentsClient({ baseUrl });
    await expect(client.a2aInvoke("target", "")).rejects.toThrow();
  });

  it("non-2xx response becomes HttpError", async () => {
    installFetchStub({ status: 404, body: { error: "not found" } });
    const client = new AgentsClient({ baseUrl });
    await expect(client.get("missing")).rejects.toBeInstanceOf(HttpError);
  });

  it("response body cap rejects oversized payload", async () => {
    // 12 MB > MAX_RESPONSE_SIZE (10 MB)
    const big = new Uint8Array(12 * 1024 * 1024);
    installFetchStub({ bodyBytes: big });
    const client = new AgentsClient({ baseUrl });
    await expect(client.get("huge")).rejects.toThrow("too large");
  });
});

// ─── MemoryClient tests ───────────────────────────────────────────

describe("MemoryClient", () => {
  const baseUrl = "http://127.0.0.1:9999";

  it("set posts basic body without optional fields", async () => {
    const captured = installFetchStub({
      body: {
        id: "m1",
        tenant_id: "t",
        namespace: "support",
        key: "k1",
        value: "hello",
        tags: [],
        created_at: 0,
        updated_at: 0,
      },
    });
    const client = new MemoryClient({ baseUrl });
    const out = await client.set("support", "k1", "hello");
    expect(out.id).toBe("m1");
    expect(captured[0].url).toBe(`${baseUrl}/v1/memory/support`);
    const body = captured[0].body as Record<string, unknown>;
    expect(body.key).toBe("k1");
    expect(body.value).toBe("hello");
    expect(body.tags).toBeUndefined();
    expect(body.embedding).toBeUndefined();
  });

  it("set forwards tags and embedding when present", async () => {
    const captured = installFetchStub({ body: { id: "m" } });
    const client = new MemoryClient({ baseUrl });
    await client.set("ns", "k", "v", { tags: ["urgent"], embedding: [0.1, 0.2] });
    const body = captured[0].body as Record<string, unknown>;
    expect(body.tags).toEqual(["urgent"]);
    expect(body.embedding).toEqual([0.1, 0.2]);
  });

  it("list builds pagination query string", async () => {
    const captured = installFetchStub({
      body: { entries: [], pagination: { total: 0, limit: 20, offset: 0 } },
    });
    const client = new MemoryClient({ baseUrl });
    await client.list("ns");
    expect(captured[0].url).toContain("limit=20");
  });

  it("search query-only sends query, no tags", async () => {
    const captured = installFetchStub({
      body: { results: [], total_matched: 0, mode: "lexical" },
    });
    const client = new MemoryClient({ baseUrl });
    await client.search("ns", { query: "hello" });
    const body = captured[0].body as Record<string, unknown>;
    expect(body.query).toBe("hello");
    expect(body.tags).toBeUndefined();
  });

  it("search tags+query+limit sends all three", async () => {
    const captured = installFetchStub({
      body: { results: [], total_matched: 0, mode: "lexical" },
    });
    const client = new MemoryClient({ baseUrl });
    await client.search("ns", { query: "q", tags: ["urgent", "vip"], limit: 5 });
    const body = captured[0].body as Record<string, unknown>;
    expect(body.tags).toEqual(["urgent", "vip"]);
    expect(body.limit).toBe(5);
  });

  it("search requires query or tags", async () => {
    const client = new MemoryClient({ baseUrl });
    await expect(client.search("ns", {})).rejects.toThrow(/query or tags/);
  });

  it("injects tenant header", async () => {
    const captured = installFetchStub({ body: {} });
    const client = new MemoryClient({
      baseUrl,
      apiKey: "k",
      tenant: "tenant-x",
    });
    await client.set("ns", "k", "v");
    expect(captured[0].headers["authorization"]).toBe("Bearer k");
    expect(captured[0].headers["x-rapidapi-user"]).toBe("tenant-x");
  });
});
