<h1 align="center">Wauldo TypeScript SDK</h1>

<p align="center">
  <strong>Verified AI answers from your documents — with the sources to prove it.</strong>
</p>

<p align="center">
  Most RAG APIs guess. Wauldo verifies.
</p>

<p align="center">
  Sources on every answer &nbsp;|&nbsp; claim-by-claim fact-check &nbsp;|&nbsp; <a href="https://wauldo.com/benchmarks">public weekly benchmarks</a>
</p>

<p align="center">
  <a href="https://npmjs.com/package/wauldo"><img src="https://img.shields.io/npm/v/wauldo.svg" alt="npm" /></a>&nbsp;
  <a href="https://npmjs.com/package/wauldo"><img src="https://img.shields.io/npm/dm/wauldo.svg" alt="Downloads" /></a>&nbsp;
  <img src="https://img.shields.io/badge/TypeScript-5.0+-blue.svg" alt="TypeScript" />&nbsp;
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="MIT" />
</p>

<p align="center">
  <a href="https://wauldo.com/demo">Demo</a> &bull;
  <a href="https://wauldo.com/docs">Docs</a> &bull;
  <a href="https://rapidapi.com/binnewzzin/api/smart-rag-api">Free API Key</a> &bull;
  <a href="https://wauldo.com/benchmarks">Benchmarks</a>
</p>

---

## Quickstart (30 seconds)

```bash
npm install wauldo
```

```typescript
import { HttpClient } from 'wauldo';

const client = new HttpClient({ baseUrl: 'https://api.wauldo.com', apiKey: 'YOUR_API_KEY' });

// Upload a document
await client.ragUpload('Our refund policy allows returns within 60 days...', 'policy.txt');

// Ask a question — answer is verified against the source
const result = await client.ragQuery('What is the refund policy?');
console.log(result.answer);
console.log(result.sources);
```

> Got your key from RapidAPI? Use the RapidAPI host instead — see [RapidAPI](#rapidapi).

```
Output:
Answer: Returns are accepted within 60 days of purchase.
Sources: policy.txt — "Our refund policy allows returns within 60 days"
Grounded: true | Confidence: 0.92
```

[Try the demo](https://wauldo.com/demo) | [Get a free API key](https://rapidapi.com/binnewzzin/api/smart-rag-api)

---

## Why Wauldo (and not standard RAG)

**Typical RAG pipeline**

```
retrieve → generate → hope it's correct
```

**Wauldo pipeline**

```
retrieve → extract facts → generate → verify → return or refuse
```

If the answer can't be verified, it returns **"insufficient evidence"** instead of guessing.

### See the difference

```
Document: "Refunds are processed within 60 days"

Typical RAG:  "Refunds are processed within 30 days"     ← wrong
Wauldo:       "Refunds are processed within 60 days"     ← verified
              or "insufficient evidence" if unclear       ← safe
```

---

## Examples

### Upload a PDF and ask questions

```typescript
// Upload — text extraction + quality scoring happens server-side
const upload = await client.uploadFile(filePath, { title: 'Q3 Contract' });
console.log(`Extracted ${upload.chunks_count} chunks, quality: ${upload.quality_label}`);

// Query
const result = await client.ragQuery('What are the payment terms?');
console.log(`Answer: ${result.answer}`);
console.log(`Confidence: ${Math.round(result.audit.confidence * 100)}%`);
console.log(`Grounded: ${result.audit.grounded}`);
```

### Guard — fact-check any LLM output

```typescript
const result = await client.guard(
  'Returns are accepted within 60 days.',
  'Our policy allows returns within 14 days.',
  'lexical',
);
console.log(result.verdict);          // "rejected"
console.log(result.action);           // "block"
console.log(result.claims[0].reason); // "numerical_mismatch"
```

Optionally score how well the text answers the original question — decoupled
from the factual verdict (a verified answer can still be off-topic):

```typescript
const result = await client.factCheck(
  'Rust was first released in 2010 by Mozilla Research.',
  'Rust is a systems language released in 2010 by Mozilla Research.',
  'lexical',
  { query: 'What year was Rust released?' },
);
console.log(result.verdict);            // "verified"
console.log(result.relevance?.verdict); // "relevant" | "partial" | "off_topic"
console.log(result.relevance?.score);   // cosine similarity — interpret through verdict, not absolute value
```

### Deployed Agents — create, run, stream

```typescript
import { AgentsClient, TaskTimeoutError, isTerminalTransition, taskErrorInfo, terminalPayload } from 'wauldo';

const agents = new AgentsClient({
  baseUrl: 'https://api.wauldo.com',
  apiKey: 'YOUR_API_KEY',
  tenant: 'my-tenant',
  // maxRetries: 3 (default). Transient failures are retried, Retry-After honoured:
  // 429/503 on any call, 500/502/504 and network errors on GET only.
});

const agent = await agents.create({
  name: 'support-bot',
  description: 'Answers refund questions',
  wauldoToml: `[agent]\nname = "support-bot"\n[model]\nprovider = "openrouter"\nname = "auto"`,
  preset: 'general_task', // or 'rust_backend_architect', 'rag_data_engineer', ...
});

// One call: the server holds the response while the run completes,
// so a quick run comes back verified in a single round-trip.
const task = await agents.runAndWait(agent.id, 'Can I return a shirt 30 days after purchase?');
console.log(task.result);                     // The answer
console.log(task.verification?.verdict);      // SAFE | UNVERIFIED | BLOCK | …
console.log(task.verification?.trust_score);  // 0.0 – 1.0
console.log(task.verification?.message);      // Human-readable context when non-SAFE

// Need progress events? Start the run, then stream each workflow state as it completes.
const run = await agents.run(agent.id, 'Can I return a shirt 30 days after purchase?');
for await (const event of agents.streamTask(run.task_id)) {
  console.log(`  ${event.state_name}: ${event.duration_ms}ms  (${event.completion_tokens} tok)`);
  if (isTerminalTransition(event)) { // last event: result + verification, nothing left to fetch
    console.log(terminalPayload(event)?.result ?? event.condition); // payload null when withheld
  }
}

// Batch job: no polling, the server POSTs the task to your webhook when the run ends;
// autoShare returns a public link to the run at creation.
const batch = await agents.run(agent.id, 'Summarise ticket #4521', undefined, undefined, {
  webhookUrl: 'https://example.com/hooks/wauldo',
  autoShare: true,
});
console.log(batch.share_url);

// Waiting has a limit (timeoutMs, default 360 s: enough for ordinary runs); the task
// keeps running past it. For long runs, pass a larger timeoutMs, stream, or use a webhook.
try {
  await agents.waitForTask(batch.task_id, { timeoutMs: 60_000 });
} catch (e) {
  if (!(e instanceof TaskTimeoutError)) throw e;
  console.log(`${e.taskId} still ${e.lastStatus}`);
  await agents.waitForTask(e.taskId); // keep waiting
}

// Human approval: pause a task, then approve (it runs again) or reject (cancelled).
// The reason is stored with the decision (task.decisions). A task left paused 7 days
// without a decision is cancelled; resumeTask() runs it again as a new task.
await agents.pauseTask(batch.task_id, 'check the refund amount');
await agents.approveTask(batch.task_id); // or rejectTask

// A failed task is not an exception: its error is "code: message", parsed by taskErrorInfo.
const info = taskErrorInfo(task); // { code, message } | null
if (task.status === 'failed' && info) {
  if (info.code === 'invalid_preset' || info.code === 'invalid_agent_config') {
    console.error(`Fix the agent: ${info.message}`);
  } else {
    await agents.resumeTask(task.task_id); // transient: run it again later
  }
}
```

| Code | Meaning | What to do |
|---|---|---|
| `invalid_preset` | The agent names a workflow preset that does not exist | Fix the agent |
| `invalid_agent_config` | The agent's inline workflow could not be loaded | Fix the agent |
| `rate_limited` | The model service is saturated | Retry in a few minutes |
| `timeout` | The run did not finish within its time limit | Retry, or simplify the request |
| `model_unavailable` | The model service is temporarily unavailable | Retry later |
| `run_failed` | The run failed for another reason | Retry later |

New codes may be added: handle an unknown one like `run_failed`. An error that
does not start with a code (a task cancelled after 7 days without an approval
decision) has a `null` code and the whole error in `message`.

`create({ ..., customPreset })` takes an inline workflow at creation, used from the agent's first run.

### Chat (OpenAI-compatible)

```typescript
const reply = await client.chatSimple('auto', 'Explain async/await in TypeScript');
console.log(reply);
```

### Streaming

```typescript
const stream = client.chatStream({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello!' }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

### Conversation

```typescript
const conv = client.conversation({ system: 'You are an expert on TypeScript.', model: 'auto' });
const reply = await conv.say('What are generics?');
const followUp = await conv.say('Give me an example');
```

---

## Features

- **Pre-generation fact extraction** — numbers, dates, limits injected as constraints
- **Post-generation grounding check** — every answer verified against sources
- **Guard API** — verify any claim against any source (3 modes: lexical, hybrid, semantic)
- **Native PDF/DOCX upload** — server-side extraction with quality scoring
- **Smart model routing** — auto-selects cheapest model that meets quality
- **OpenAI-compatible** — swap your `baseUrl`, keep your existing code
- **Zero dependencies** — uses Node 18+ built-in APIs (fetch, ReadableStream)

---

## Error Handling

```typescript
import { HttpClient, ServerError } from 'wauldo';

try {
  const response = await client.chat({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] });
} catch (error) {
  if (error instanceof ServerError) {
    console.error(`Server error [${error.code}]: ${error.message}`);
  }
}
```

`AgentsClient` and `WorkflowsClient` reject with `HttpError` on an
HTTP error status. It extends `ServerError` (so `WauldoError`), with `code` set
to the HTTP status, and keeps `status`, `statusText` and `body` (the server's
JSON error). A wait that runs out rejects with `TaskTimeoutError`.

```typescript
import { HttpError, TaskTimeoutError } from 'wauldo';

try {
  const task = await agents.runAndWait(agentId, 'Qualify acme.com');
} catch (e) {
  if (e instanceof HttpError) console.error(e.status, e.body);
  else if (e instanceof TaskTimeoutError) await agents.waitForTask(e.taskId);
  else throw e;
}
```

---

## RapidAPI

Keys from the free RapidAPI plan work on the RapidAPI host, not on `api.wauldo.com` (Enterprise keys):

```typescript
const client = new HttpClient({
  baseUrl: 'https://smart-rag-api.p.rapidapi.com',
  headers: {
    'X-RapidAPI-Key': 'YOUR_RAPIDAPI_KEY',
    'X-RapidAPI-Host': 'smart-rag-api.p.rapidapi.com',
  },
});
```

Free tier (500 verifications/month): [RapidAPI](https://rapidapi.com/binnewzzin/api/smart-rag-api)

---

[Website](https://wauldo.com) | [Docs](https://wauldo.com/docs) | [Demo](https://wauldo.com/demo) | [Benchmarks](https://wauldo.com/benchmarks)

## Contributing

PRs welcome. Check the [good first issues](https://github.com/wauldoai/wauldo-sdk-js/labels/good%20first%20issue).

## License

MIT — see [LICENSE](./LICENSE)
