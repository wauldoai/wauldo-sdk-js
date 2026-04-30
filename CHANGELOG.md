# Changelog

All notable changes to the Wauldo TypeScript SDK.

## [0.8.0] - 2026-04-15

### Added
- Typed interfaces for the Tasks API: `Task`, `TaskClaim`,
  `TaskVerification`, `StateTransition`, plus string-literal unions
  `Verdict` and `TaskStatus`. All exposed from the top-level `wauldo`
  package.
- `AgentsClient.getTask(taskId)` — fetch current task state.
- `AgentsClient.cancelTask(taskId)` — `DELETE /v1/tasks/:id`.
- `AgentsClient.waitForTask(taskId, opts?)` — blocking poll helper.
  Accepts `{ timeoutMs, pollIntervalMs }`. Rejects with a timeout
  error when the task stays non-terminal past the deadline.
- `AgentsClient.streamTask(taskId)` — async generator over SSE
  `data:` frames. Yields typed `StateTransition` events as each
  workflow state completes. Consumes the new
  `GET /v1/tasks/:id/stream` endpoint.
- `isTerminalStatus(status)` helper for UI state machines.
- `TaskVerification.message` optional field — human-readable context
  for non-SAFE verdicts (e.g. explains `UNVERIFIED` + `prompt_only`).

### Fixed
- `AgentsClient.request` no longer passes `body: undefined` to fetch's
  `RequestInit`, silencing a spurious `exactOptionalPropertyTypes`
  DTS-build error on recent tsup/tsc.

## [0.1.0] - 2026-03-16

### Added
- `HttpClient` — REST API client (OpenAI-compatible, zero runtime deps)
  - `chat()`, `chatSimple()`, `chatStream()`, `listModels()`, `embeddings()`
  - `ragUpload()`, `ragQuery()`, `ragAsk()`
  - `orchestrate()`, `orchestrateParallel()`
- `AgentClient` — MCP client (stdio JSON-RPC)
  - `reason()`, `extractConcepts()`, `planTask()`
  - `chunkDocument()`, `retrieveContext()`, `summarize()`
  - `searchKnowledge()`, `addToKnowledge()`
- `Conversation` — automatic chat history management
- `MockHttpClient` — offline testing with call recording
- Retry with exponential backoff (429/503/network errors)
- Configurable logging via `onLog` callback
- Event hooks: `onRequest`, `onResponse`, `onError`
- Response validation via `validateResponse<T>()`
- Per-request `timeoutMs` override on `chat()` and `ragUpload()`
- 3 examples: basic_chat, streaming_chat, rag_workflow
- 42 unit tests (Vitest)
- Zero runtime dependencies (Node 18+ built-in APIs only)
- Dual-package: ESM + CommonJS with TypeScript declarations
