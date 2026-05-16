# Changelog

All notable changes to the Wauldo TypeScript SDK.

## [0.14.0] - 2026-05-16

### Added
- `WorkflowsClient.update(workflowId, input)` — edit a workflow in place via `PATCH /v1/workflows/:id`. Body shape is identical to `create` (reuses `CreateWorkflowInput`). Server keeps id/tenant_id/created_at, bumps `updated_at` and the monotonic `version`. Closes the SDK-parity gap left when the PATCH endpoint shipped in monorepo commit `54d533b` without the matching SDK method.

## [0.13.0] - 2026-05-14

### Added
- `WorkflowsClient` — six methods covering the Wauldo Workflow Runtime surface (`create`, `list`, `get`, `delete`, `startRun`, `getRun`) plus a `waitForRun` polling helper. Mirrors the `/v1/workflows*` endpoints shipped in rev 63 (Phase 1+2 runtime: Task / Choice / Wait / Pass / Fail / Succeed state machines).
- Top-level exports: `WorkflowsClient`, `isWorkflowRunTerminal`, `TERMINAL_WORKFLOW_STATUSES`, plus types `Workflow`, `CreateWorkflowInput`, `WorkflowListResponse`, `StartRunResponse`, `WorkflowExecution`.

## [0.12.0] - 2026-05-08

### Added
- `AgentsClient.shareTask(taskId)` → `Promise<ShareResponse>` — publish a verified run as a public URL (`https://wauldo.com/r/<id>`). Idempotent ; free tier gets a 30-day TTL, paid tenants get `expires_at = null`.
- `AgentsClient.unshareTask(taskId)` → `Promise<void>` — revoke a published run.
- `ShareResponse` interface exported.

## [0.11.0] - 2026-05-05

### Added
- `AgentsClient.createRevision()`, `listRevisions()`, `getRevision()`, `setActiveRevision()` — ECS-style immutable revisions for `custom_preset` agents (O(1) rollback, no LLM cost).
- Types: `AgentRevision`, `CreateRevisionInput`, `CreateRevisionResponse`, `ListRevisionsResponse` (re-exported from `wauldo`).

## [0.10.0] - 2026-04-30

### Added
- `src/agents.ts` and `src/memory.ts` modules — Tasks API client + agent memory bindings.
- `tests/agents_memory.test.ts` and `tests/agents_tasks.test.ts` integration tests.

### Changed
- Repository URL migrated to github.com/wauldoai.
- README hero refresh + footer alignment with WAULDO_README_TEMPLATE.

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
