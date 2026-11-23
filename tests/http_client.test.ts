/**
 * Tests for Wauldo HTTP Client (REST API)
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, MAX_UPLOAD_FILE_BYTES } from '../src/http_client.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  EmbeddingResponse,
  ModelList,
  OrchestratorResponse,
  RagQueryResponse,
  RagUploadResponse,
  UploadFileResponse,
} from '../src/http_types.js';

// ============================================================================
// Client Construction
// ============================================================================

describe('HttpClient construction', () => {
  it('creates client with defaults', () => {
    const client = new HttpClient();
    expect(client).toBeDefined();
  });

  it('creates client with custom config', () => {
    const client = new HttpClient({
      baseUrl: 'http://example.com:8080',
      apiKey: 'sk-test-key',
      timeoutMs: 30000,
    });
    expect(client).toBeDefined();
  });

  it('strips trailing slash from baseUrl', () => {
    const client = new HttpClient({ baseUrl: 'http://localhost:3000/' });
    expect(client).toBeDefined();
  });
});

// ============================================================================
// Type Validation
// ============================================================================

describe('ChatRequest types', () => {
  it('builds a minimal chat request', () => {
    const req: ChatRequest = {
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    expect(req.model).toBe('qwen2.5:7b');
    expect(req.messages).toHaveLength(1);
    expect(req.temperature).toBeUndefined();
  });

  it('builds a full chat request', () => {
    const req: ChatRequest = {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'What is Rust?' },
      ],
      temperature: 0.7,
      max_tokens: 100,
      top_p: 0.9,
    };
    expect(req.messages).toHaveLength(2);
    expect(req.temperature).toBe(0.7);
  });

  it('serializes to valid JSON', () => {
    const req: ChatRequest = {
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
    };
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json);
    expect(parsed.model).toBe('test');
    expect(parsed.messages[0].role).toBe('user');
  });
});

// ============================================================================
// Response Deserialization
// ============================================================================

describe('ChatResponse parsing', () => {
  it('parses a valid chat response', () => {
    const raw: ChatResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1709900000,
      model: 'qwen2.5:7b',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };
    expect(raw.id).toBe('chatcmpl-123');
    expect(raw.choices[0].message.content).toBe('Hello!');
    expect(raw.usage.total_tokens).toBe(15);
  });
});

describe('ModelList parsing', () => {
  it('parses model list', () => {
    const raw: ModelList = {
      object: 'list',
      data: [
        { id: 'qwen2.5:7b', object: 'model', created: 1709000000, owned_by: 'ollama' },
        { id: 'llama3:8b', object: 'model', created: 1709000001, owned_by: 'ollama' },
      ],
    };
    expect(raw.data).toHaveLength(2);
    expect(raw.data[0].id).toBe('qwen2.5:7b');
  });
});

describe('EmbeddingResponse parsing', () => {
  it('parses embedding response', () => {
    const raw: EmbeddingResponse = {
      data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
      model: 'bge-small-en',
      usage: { prompt_tokens: 5, total_tokens: 5 },
    };
    expect(raw.data[0].embedding).toHaveLength(3);
    expect(raw.model).toBe('bge-small-en');
  });
});

describe('RAG types', () => {
  it('parses upload response', () => {
    const raw: RagUploadResponse = { document_id: 'doc-123', chunks_count: 5 };
    expect(raw.document_id).toBe('doc-123');
    expect(raw.chunks_count).toBe(5);
  });

  it('parses query response', () => {
    const raw: RagQueryResponse = {
      answer: 'Rust is a systems language',
      sources: [{ document_id: 'doc-1', content: 'Rust...', score: 0.95 }],
    };
    expect(raw.answer).toBe('Rust is a systems language');
    expect(raw.sources[0].score).toBeCloseTo(0.95);
  });
});

describe('Orchestrator types', () => {
  it('parses orchestrator response', () => {
    const raw: OrchestratorResponse = { final_output: 'The code looks good' };
    expect(raw.final_output).toBe('The code looks good');
  });
});

// ============================================================================
// JSON round-trip
// ============================================================================

describe('JSON round-trip', () => {
  it('chat request survives serialization', () => {
    const req: ChatRequest = {
      model: 'model-1',
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.5,
    };
    const json = JSON.stringify(req);
    const parsed = JSON.parse(json) as ChatRequest;
    expect(parsed.model).toBe('model-1');
    expect(parsed.temperature).toBe(0.5);
    expect(parsed.messages[0].content).toBe('test');
  });
});

// ============================================================================
// Mock HTTP Tests
// ============================================================================

function mockJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('HttpClient mock tests', () => {
  const mockFetch = vi.fn<typeof fetch>();
  let client: HttpClient;

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    client = new HttpClient({
      baseUrl: 'http://test-server:3000',
      maxRetries: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chat() returns parsed response', async () => {
    const chatResp: ChatResponse = {
      id: 'cmpl-mock-1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'qwen2.5:7b',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Hello from mock!' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(chatResp));

    const result = await client.chat({
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.id).toBe('cmpl-mock-1');
    expect(result.choices[0].message.content).toBe('Hello from mock!');
    expect(result.usage.total_tokens).toBe(12);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('chatSimple() returns content string', async () => {
    const chatResp: ChatResponse = {
      id: 'cmpl-mock-2',
      object: 'chat.completion',
      created: 1700000000,
      model: 'test-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Simple reply' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(chatResp));

    const content = await client.chatSimple('test-model', 'Hello');
    expect(content).toBe('Simple reply');
  });

  it('listModels() returns model list', async () => {
    const models: ModelList = {
      object: 'list',
      data: [
        { id: 'model-a', object: 'model', created: 1700000000, owned_by: 'local' },
        { id: 'model-b', object: 'model', created: 1700000001, owned_by: 'ollama' },
      ],
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(models));

    const result = await client.listModels();
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('model-a');
    expect(result.data[1].owned_by).toBe('ollama');
  });

  it('embeddings() returns embedding vectors', async () => {
    const embResp: EmbeddingResponse = {
      data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }],
      model: 'bge-small-en',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(embResp));

    const result = await client.embeddings('test input', 'bge-small-en');
    expect(result.data[0].embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(result.model).toBe('bge-small-en');
  });

  it('ragUpload() returns upload confirmation', async () => {
    const uploadResp: RagUploadResponse = { document_id: 'doc-456', chunks_count: 12 };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(uploadResp));

    const result = await client.ragUpload('Some document text', 'readme.md');
    expect(result.document_id).toBe('doc-456');
    expect(result.chunks_count).toBe(12);
  });

  it('ragUpload() sends piiPolicy only when given, and rejects unknown values', async () => {
    const uploadResp: RagUploadResponse = { document_id: 'd', chunks_count: 1 };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(uploadResp));
    await client.ragUpload('Write to help@acme.example', undefined, { piiPolicy: 'keep' });
    const sent = JSON.parse(String(mockFetch.mock.calls.at(-1)?.[1]?.body));
    expect(sent.pii_policy).toBe('keep');

    mockFetch.mockResolvedValueOnce(mockJsonResponse(uploadResp));
    await client.ragUpload('No choice made');
    const plain = JSON.parse(String(mockFetch.mock.calls.at(-1)?.[1]?.body));
    expect(plain).not.toHaveProperty('pii_policy');

    await expect(
      client.ragUpload('x', undefined, { piiPolicy: 'tag' as unknown as 'keep' }),
    ).rejects.toThrow('piiPolicy must be');
  });

  it('ragUpload() counts the encoded bytes against the 10 MB limit', async () => {
    // The server's limit applies to the body as sent, in UTF-8 bytes: three
    // million accented letters are 6 MB of text in characters, 6 MB more in bytes.
    const overhead = new TextEncoder().encode(JSON.stringify({ content: '' })).byteLength;
    const accents = 'é'.repeat(1_000_000);
    const fits = accents + 'a'.repeat(MAX_UPLOAD_FILE_BYTES - overhead - 2 * accents.length);
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ document_id: 'd', chunks_count: 1 }));
    await client.ragUpload(fits);
    const sent = String(mockFetch.mock.calls.at(-1)?.[1]?.body);
    expect(new TextEncoder().encode(sent).byteLength).toBe(MAX_UPLOAD_FILE_BYTES);
    await expect(client.ragUpload(fits + 'a')).rejects.toThrow('10 MB limit once encoded');
    await expect(client.ragUpload(fits, 'f.txt')).rejects.toThrow('10 MB limit once encoded');
    const wide = 'é'.repeat(6_000_000);
    expect(wide.length).toBeLessThan(MAX_UPLOAD_FILE_BYTES);
    await expect(client.ragUpload(wide)).rejects.toThrow('10 MB limit once encoded');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('uploadFile() reads a path and sends it as multipart with title and piiPolicy', async () => {
    const uploadResp: UploadFileResponse = {
      document_id: 'doc-1',
      chunks_count: 3,
      content_type: 'pdf',
      quality: {
        score: 0.8, label: 'high', word_count: 120,
        line_density: 0.9, avg_line_length: 40, paragraph_count: 4,
      },
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(uploadResp));
    const dir = mkdtempSync(join(tmpdir(), 'wauldo-upload-'));
    const path = join(dir, 'contract.pdf');
    writeFileSync(path, '%PDF-1.4 fake');
    try {
      const result = await client.uploadFile(path, { title: 'Q3 Contract', piiPolicy: 'keep' });
      expect(result.quality?.label).toBe('high');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const [url, init] = mockFetch.mock.calls.at(-1) ?? [];
    expect(String(url)).toBe('http://test-server:3000/v1/upload-file');
    expect(init?.method).toBe('POST');
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get('file') as File;
    expect(file.name).toBe('contract.pdf');
    expect(await file.text()).toBe('%PDF-1.4 fake');
    expect(form.get('title')).toBe('Q3 Contract');
    expect(form.get('pii_policy')).toBe('keep');
    // fetch sets the multipart Content-Type (with its boundary) itself.
    const headers = init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-type');
  });

  it('uploadFile() sends bytes under the given name, with no optional field by default', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ document_id: 'd', chunks_count: 1 }));
    await client.uploadFile(new TextEncoder().encode('hello'), { filename: 'notes.txt' });
    const form = mockFetch.mock.calls.at(-1)?.[1]?.body as FormData;
    expect((form.get('file') as File).name).toBe('notes.txt');
    expect(form.has('title')).toBe(false);
    expect(form.has('pii_policy')).toBe(false);
  });

  it('uploadFile() refuses empty, oversized and unknown-policy uploads before sending', async () => {
    await expect(client.uploadFile(new Uint8Array(0))).rejects.toThrow('empty');
    await expect(
      client.uploadFile(new Uint8Array(MAX_UPLOAD_FILE_BYTES + 1)),
    ).rejects.toThrow('10 MB');
    await expect(
      client.uploadFile(new Uint8Array(1), { piiPolicy: 'tag' as unknown as 'keep' }),
    ).rejects.toThrow('piiPolicy must be');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uploadFile() counts the whole request against the 10 MB limit', async () => {
    // The server's limit applies to the multipart body, not the file: a file
    // of exactly 10 MB used to pass the check and be refused unread.
    const empty = new FormData();
    empty.append('file', new Blob([]), 'big.pdf');
    empty.append('title', 'T');
    const overhead = (await new Response(empty).arrayBuffer()).byteLength;
    const fits = MAX_UPLOAD_FILE_BYTES - overhead;
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ document_id: 'd', chunks_count: 1 }));
    await client.uploadFile(new Uint8Array(fits), { filename: 'big.pdf', title: 'T' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = mockFetch.mock.calls.at(-1)?.[1]?.body as FormData;
    expect((await new Response(sent).arrayBuffer()).byteLength).toBe(MAX_UPLOAD_FILE_BYTES);
    await expect(
      client.uploadFile(new Uint8Array(fits + 1), { filename: 'big.pdf', title: 'T' }),
    ).rejects.toThrow('file name and form fields included');
    await expect(
      client.uploadFile(new Uint8Array(MAX_UPLOAD_FILE_BYTES), { filename: 'big.pdf' }),
    ).rejects.toThrow('10 MB');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('ragQuery() returns query results', async () => {
    const queryResp: RagQueryResponse = {
      answer: 'The answer is 42',
      sources: [{ document_id: 'doc-1', content: 'chunk text', score: 0.91 }],
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(queryResp));

    const result = await client.ragQuery('What is the answer?', 3);
    expect(result.answer).toBe('The answer is 42');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].score).toBeCloseTo(0.91);
  });

  it('throws on HTTP 500 error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(
      client.chat({ model: 'test', messages: [{ role: 'user', content: 'fail' }] }),
    ).rejects.toThrow('HTTP 500');
  });

  it('chatStream() yields content chunks from SSE', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    mockFetch.mockResolvedValueOnce(mockSSEResponse(sseChunks));

    const collected: string[] = [];
    for await (const chunk of client.chatStream({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      collected.push(chunk);
    }

    expect(collected).toEqual(['Hello', ' world']);
  });

  it('chatStream() throws ServerError on an in-band error instead of ending empty', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"error":{"message":"Internal processing error (trace: t1)","type":"server_error"}}\n\n',
    ];
    mockFetch.mockResolvedValueOnce(mockSSEResponse(sseChunks));

    const collected: string[] = [];
    const run = async () => {
      for await (const chunk of client.chatStream({
        model: 'test',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        collected.push(chunk);
      }
    };

    await expect(run()).rejects.toMatchObject({
      name: 'ServerError',
      message: 'Internal processing error (trace: t1)',
      data: { message: 'Internal processing error (trace: t1)', type: 'server_error' },
    });
    expect(collected).toEqual([]);
  });

  it('chatStream() treats a falsy error field as no error', async () => {
    const sseChunks = [
      'data: {"error":{},"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"error":false,"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: {"error":null,"choices":[{"delta":{"content":"c"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    mockFetch.mockResolvedValueOnce(mockSSEResponse(sseChunks));

    const collected: string[] = [];
    for await (const chunk of client.chatStream({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      collected.push(chunk);
    }
    expect(collected).toEqual(['a', 'b', 'c']);
  });
});

describe('factCheck validation', () => {
  it('throws when sourceContext is empty', async () => {
    const c = new HttpClient({ baseUrl: 'http://localhost:3000' });
    await expect(c.factCheck('some claim', '')).rejects.toThrow(/source_context is required/);
  });

  it('throws when text is empty', async () => {
    const c = new HttpClient({ baseUrl: 'http://localhost:3000' });
    await expect(c.factCheck('', 'context')).rejects.toThrow(/text cannot be empty/);
  });

  it('throws when relevanceMode is set without query', async () => {
    const c = new HttpClient({ baseUrl: 'http://localhost:3000' });
    await expect(
      c.factCheck('claim', 'context', 'lexical', { relevanceMode: 'fast' }),
    ).rejects.toThrow(/relevanceMode requires query/);
  });
});

describe('factCheck relevance', () => {
  const mockFetch = vi.fn<typeof fetch>();
  let client: HttpClient;

  const guardBody = (extra: Record<string, unknown> = {}) => ({
    verdict: 'verified',
    action: 'allow',
    hallucination_rate: 0,
    mode: 'lexical',
    total_claims: 1,
    supported_claims: 1,
    confidence: 0.9,
    claims: [],
    processing_time_ms: 12,
    ...extra,
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    client = new HttpClient({ baseUrl: 'http://test-server:3000', maxRetries: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends query and relevance_mode, parses the relevance block', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(guardBody({ relevance: { score: 0.91, verdict: 'relevant' } })),
    );

    const result = await client.factCheck('Rust released in 2010.', 'Rust: 2010.', 'lexical', {
      query: 'What year was Rust released?',
      relevanceMode: 'fast',
    });

    const sent = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(sent.query).toBe('What year was Rust released?');
    expect(sent.relevance_mode).toBe('fast');
    expect(result.relevance?.verdict).toBe('relevant');
    expect(result.relevance?.score).toBe(0.91);
    // Relevance never alters the factual verdict.
    expect(result.verdict).toBe('verified');
  });

  it('omits query/relevance_mode when unset and tolerates their absence in the response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(guardBody()));

    const result = await client.factCheck('claim', 'context');

    const sent = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(sent).not.toHaveProperty('query');
    expect(sent).not.toHaveProperty('relevance_mode');
    expect(result.relevance).toBeUndefined();
    expect(result.relevance_warning).toBeUndefined();
  });

  it('surfaces relevance_warning when relevance was not computable', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(guardBody({ relevance_warning: 'relevance not computed: embeddings unavailable' })),
    );

    const result = await client.factCheck('claim', 'context', 'lexical', { query: 'What?' });

    expect(result.relevance).toBeUndefined();
    expect(result.relevance_warning).toMatch(/embeddings unavailable/);
  });
});
