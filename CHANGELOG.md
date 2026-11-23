# Changelog

All notable changes to the Wauldo TypeScript SDK.

## [0.19.0] - 2026-11-23

### Added
- `HttpClient.uploadFile(file, { title, piiPolicy, filename, timeoutMs })`: upload a PDF, DOCX, image or text file (`POST /v1/upload-file`, multipart, 10 MB at most for the whole request: file, file name and form fields), from a path (Node) or from bytes (`Blob`, `Uint8Array`, `ArrayBuffer`). An empty file, or one whose request would exceed the limit, is refused with `ValidationError` before anything is sent. `UploadFileOptions`, `UploadFileResponse`, `DocumentQuality` and `MAX_UPLOAD_FILE_BYTES` are exported.
- **BREAKING (types):** `"INSUFFICIENT_CLAIMS"` in `Verdict`: the verdict of an answer too short or empty to extract a claim to verify. An exhaustive `switch` over `Verdict` (ending in `const n: never = v`) must handle it.
- `STREAM_LAGGED`: the `state_name` of the notice the server sends when the stream fell behind the run. It is not a workflow state and not terminal: the run goes on, the terminal event still comes, and `getTask` holds the full run. `streamTask` passes it on and keeps reading.
- `TaskVerification.honesty_signals` (`HonestySignals`), `contract_attestation` (`ContractAttestation`, `ContractViolation`), `failure_reason` and `failure_stage`; `Task.share_id`, `Task.share_url` and `Task.race_result` (`RaceResult`, `RaceCandidate`). All optional.

### Changed
- `ragUpload` refuses a request over the 10 MB limit with `ValidationError` before sending it, instead of letting the server refuse it. The limit counts the JSON body in UTF-8 bytes, file name included, not the characters of the text (an accented letter is two bytes).
- **BREAKING (types):** `Task.tenant_id` is optional: `GET /v1/tasks/:id` does not send it, so it was typed `string` but read `undefined`. Code that passes it where a `string` is expected must handle `undefined` under `strictNullChecks`.

## [0.18.0] - 2026-11-22

### Added
- `AgentsClient.runAndWait(agentId, input, opts?)`: run an agent and resolve with the settled `Task` in one call. The server holds the response for up to `MAX_WAIT_SECONDS` (50 s), so a quick run comes back verified in a single round-trip; a longer one is followed with `waitForTask`.
- `run(..., { waitSeconds })` and `getTask(taskId, { waitSeconds })`: the server holds the response until the task settles or the delay elapses (`?wait=`). `AgentRunResponse.task` carries the task when `waitSeconds` was given.
- `isSettledStatus`, `"paused_for_approval"` in `TaskStatus`, `MAX_WAIT_SECONDS`, `LONG_POLL_SECONDS`.
- `AgentsClientConfig.maxRetries` (default 3) and `retryBackoffMs` (default 500): transient failures are retried — 429 and 503 on any call, 500/502/504 and network errors on `GET` only, so a replayed `POST` can never run an agent twice and a replayed cancel never answers 409 for a cancel that worked. `Retry-After` is honoured (capped at 30 s), the wait otherwise doubles (capped at 8 s, with jitter); timeouts are never retried. `maxRetries: 0` disables. `retryDelayMs`, `RETRY_STATUSES`, `RETRY_STATUSES_IDEMPOTENT` and `IDEMPOTENT_METHODS` are exported.
- `isTerminalTransition(event)`, `terminalPayload(event)` and `TerminalPayload`: the stream's last event (`TASK_COMPLETED` / `TASK_FAILED` / `TASK_CANCELLED`) carries `task_id`, `status`, `result`, `error` and `verification`, so a streaming client has nothing left to fetch.
- `run(..., { webhookUrl, maxRetries, autoShare })` (`RunOptions`, also accepted by `runAndWait`): the server POSTs the task to `webhookUrl` when the run completes or fails (a private or internal address is refused with a 400); `maxRetries` sets the retries of the run on the server (default 3, capped at 10 — not `AgentsClientConfig.maxRetries`, the client's HTTP retries); `autoShare: true` publishes the run at creation and `AgentRunResponse.share_id` / `share_url` carry the link.
- `create({ ..., customPreset })`: an inline workflow at creation, used from the agent's first run (it used to need `create` then `createRevision`).
- `pauseTask`, `approveTask`, `rejectTask` (optional `reason`), resolving with `HitlResponse { task_id, previous_status, new_status }`: pause a queued or running task for a human decision, then approve it (it is queued and runs again) or reject it (cancelled). The `reason` (at most 1000 characters, `MAX_HITL_REASON_CHARS`) is stored with the decision and listed in `Task.decisions` (`TaskDecision`), which keeps the 20 most recent decisions. A task left paused 7 days without a decision is cancelled by the server (`Task.error` is `PAUSED_EXPIRED_ERROR`); approving or rejecting it then answers 409.
- `resumeTask(taskId)`: run a failed or cancelled task again, as a new task (`AgentRunResponse` with the new `task_id`).
- `getTask(taskId, { includeJournal: false })`: leave the execution journal out of the response. Not sent by default.
- `TaskTimeoutError` (exported), with `taskId`, `lastStatus` and `timeout` (ms): what `waitForTask`, `runAndWait` and the fallback of `streamTask` reject with when the wait runs out. It extends `TimeoutError` (and `Error`). Its message starts as before, then says the task may still be running and how to keep waiting (`waitForTask(taskId)` again).
- `DEFAULT_WAIT_TIMEOUT_MS`.
- `taskErrorInfo(task)`: a failed task's `error` (`code: message`) split into its stable `code` and its `message` (`TaskErrorInfo`, `TaskErrorCode`, `TASK_ERROR_CODES`: `invalid_preset`, `invalid_agent_config`, `rate_limited`, `timeout`, `model_unavailable`, `run_failed`). It also reads a stream's `TerminalPayload`. An unknown code is kept as sent; an error that does not start with a code has a `null` code. `Task.error` is unchanged.

### Fixed
- `waitForTask` and `runAndWait` gave up after 180 s by default: slower runs were reported as timed out although the server went on to finish them. The default is now 360 s (`DEFAULT_WAIT_TIMEOUT_MS`), which covers ordinary runs; it is not a bound on how long a run may take. For a long run, pass a larger `timeoutMs`, use `streamTask`, or give the run a `webhookUrl`. Each request inside the wait is still a 30 s long poll; the request timeout is unchanged.
- `waitForTask` rejected with a plain `Error` on timeout, distinguishable only by its message: it rejects with `TaskTimeoutError`.
- `cancelTask` sent `DELETE /v1/tasks/:id`, which the server maps to *deleting a finished task*: a running task could not be cancelled, and a finished one was erased. It now sends `PUT` (the server's cancel) and resolves with the cancelled `Task` (**BREAKING:** it used to resolve with `void`). The old behaviour is available as `deleteTask`.
- `streamTask` always ends on the terminal event. When the server has no stream for the task (404: still queued, server restarted) or the stream closes before its last event (connection cut, 30-minute limit), the task is long-polled until it settles (`STREAM_FALLBACK_TIMEOUT_MS`, waiting out the 429/5xx/refused connections of a server restarting) and a terminal event built from it is yielded — condition `"Already finished"` (`ALREADY_FINISHED_CONDITION`), same payload, with `WITHHELD_RESULT` in place of the result when the stream withheld the run's output (`Task.output_withheld`) — so a loop that stops on `isTerminalTransition` always gets the result. It used to reject with the 404, or end without the result. A task paused for approval ends the stream without a terminal event: approve it, then stream again.
- `streamTask` gives the response headers, then each read, `STREAM_IDLE_TIMEOUT_MS` (60 s; the server sends a keep-alive far more often): a connection that goes silent is treated as cut and recovered as above, instead of hanging.
- `isTerminalTransition` also requires a terminal `condition` (`"terminal"` or `"Already finished"`, `TERMINAL_CONDITIONS`): a workflow state named `TASK_COMPLETED` no longer ends `streamTask` before the run's real terminal event.
- `Task.output_withheld`: true when the run's stream withheld its output.
- `MemoryClient` and `NamespacedMemory` (with their types; the option types as `MemorySetOptions` and `MemorySearchOptions`) are exported from `wauldo`. The package only exposes its root entry, so they could not be imported; the docs named `wauldo/memory` and `wauldo/agents`, which do not exist: import both clients from `wauldo`.

### Changed
- `HttpError` (what `AgentsClient` and `WorkflowsClient` reject with on an HTTP error status) extends `ServerError`, so `instanceof WauldoError` catches it with the SDK's other errors; `code` is the HTTP status. `status`, `statusText`, `body`, `name` and the message are unchanged.
- **BREAKING:** `waitForTask` resolves with a task that is `paused_for_approval` (the caller has to act) instead of rejecting on timeout, and `TaskStatus` gains that value. It also long-polls the server (`longPollSeconds`, 30 s per request by default) instead of sleeping `pollIntervalMs` between polls, so the result arrives the moment it lands; the sleep remains as the fallback against a server that answers at once.

## [0.17.1] - 2026-11-15

### Changed
- README and package metadata: the RapidAPI example now uses the RapidAPI host (a free-plan key does not work on `api.wauldo.com`), the free tier is 500 verifications/month, claims that could not be checked were removed, and benchmarks link to the public weekly page. No code change.

## [0.17.0] - 2026-11-15

### Added
- `ragUpload`: optional `piiPolicy` (`RagUploadOptions`, new `PiiPolicy` type) — `"redact"` (server default) or `"keep"` to store contact details as sent. Unknown values throw `ValidationError`.

### Fixed
- `chatStream`: a failure reported by the server mid-stream (`data: {"error": {...}}`) now throws `ServerError` carrying the server's message and error body. It was skipped, so the stream ended as an empty, apparently successful answer.

### Removed
- **Breaking:** `agentsMd` and `mcpJson` are removed from agent create/update and from the agent type. The server never used them and now ignores them; requests that still send them are accepted unchanged.

## [0.16.0] - 2026-06-10

### Added
- `factCheck` / `guard`: new `FactCheckOptions` (extends `RequestOptions`) with optional `query` and `relevanceMode` — when `query` is provided, the response carries a `relevance` block (`RelevanceResult`: `score`, `verdict` relevant/partial/off_topic, `rationale`) scoring how well the text answers the question, fully decoupled from the factual verdict. `relevance_warning` explains when relevance could not be computed. Only `relevanceMode: "fast"` is supported server-side today.

## [0.15.1] - 2026-06-07

### Fixed
- `factCheck`: `sourceContext` is now **required** (was optional). The server rejects a missing context with 400, so the optional form always failed at runtime. Surfaced by a live dogfooding pass.

### Added
- Client-side validation on `factCheck` (empty `text` / `sourceContext`) — throws `ValidationError` instead of a server round-trip.

## [0.15.0] - 2026-06-07

### Added
- `HttpClient.factCheck(text, sourceContext?, mode?)` — canonical name for the `/v1/fact-check` verify call, matching the `fact_check` naming used across the Python and Rust SDKs. `sourceContext` is now optional (the server accepts a missing context).
- `HttpClient.verifyCitation(text, sources?, threshold?)` — validate inline citations via `POST /v1/verify`. Closes the cross-SDK parity gap (was Python-only). New types `VerifyCitationResponse`, `CitationDetail`, `SourceChunk`.

### Changed
- `guard()` is now a deprecated back-compat alias delegating to `factCheck()`. Same applies on `MockHttpClient`.

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
