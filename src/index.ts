/**
 * Wauldo TypeScript SDK
 *
 * Two client interfaces:
 * - AgentClient — MCP server (stdio JSON-RPC) for reasoning, planning, tools
 * - HttpClient — REST API (OpenAI-compatible) for chat, embeddings, RAG, orchestrator
 *
 * @packageDocumentation
 */

// MCP Client
export { AgentClient } from './client.js';

// HTTP Client
export { HttpClient } from './http_client.js';

// Conversation helper
export { Conversation } from './conversation.js';

// Mock Client (for testing)
export { MockHttpClient } from './mock_client.js';

// Errors
export {
  WauldoError,
  ConnectionError,
  ServerError,
  ValidationError,
  TimeoutError,
  TaskTimeoutError,
  ToolNotFoundError,
} from './errors.js';

// MCP Types
export type {
  ClientOptions,
  ReasoningOptions,
  ReasoningResult,
  SourceType,
  Concept,
  ConceptResult,
  Chunk,
  ChunkResult,
  RetrievalResult,
  GraphNode,
  KnowledgeGraphResult,
  DetailLevel,
  PlanStep,
  PlanResult,
  PlanOptions,
  ToolDefinition,
  CallToolResponse,
  ToolContent,
} from './types.js';

// HTTP API Helpers
export { chatContent, guardIsSafe, guardIsBlocked } from './http_types.js';

// HTTP API Types
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  ChatChoice,
  ModelInfo,
  ModelList,
  EmbeddingData,
  EmbeddingUsage,
  EmbeddingResponse,
  RagUploadResponse,
  RagSource,
  RagAuditInfo,
  RagQueryResponse,
  OrchestratorResponse,
  GuardClaim,
  GuardResponse,
  GuardMode,
  RelevanceResult,
  FactCheckOptions,
  SourceChunk,
  CitationDetail,
  VerifyCitationResponse,
  HttpClientConfig,
  LogLevel,
  RequestOptions,
  RagUploadOptions,
  PiiPolicy,
  ChatClientLike,
} from './http_types.js';

// Deployed Agents + Tasks (create, run, poll, stream)
export {
  AgentsClient,
  HttpError,
  isSettledStatus,
  isTerminalStatus,
  isTerminalTransition,
  terminalPayload,
  retryDelayMs,
  RETRY_STATUSES,
  RETRY_STATUSES_IDEMPOTENT,
  IDEMPOTENT_METHODS,
  TERMINAL_STATE_NAMES,
  TERMINAL_CONDITIONS,
  LONG_POLL_SECONDS,
  MAX_WAIT_SECONDS,
  DEFAULT_WAIT_TIMEOUT_MS,
  STREAM_FALLBACK_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  ALREADY_FINISHED_CONDITION,
  WITHHELD_RESULT,
  PAUSED_EXPIRED_ERROR,
  MAX_HITL_REASON_CHARS,
  supportScore,
} from './agents.js';
export { taskErrorInfo, TASK_ERROR_CODES } from './task_errors.js';
export type { TaskErrorInfo, TaskErrorCode } from './task_errors.js';
export type {
  AgentsClientConfig,
  DeployedAgent,
  CreateAgentInput,
  UpdateAgentPatch,
  AgentListResponse,
  AgentRunResponse,
  RunOptions,
  HitlResponse,
  TaskDecision,
  A2aResponse,
  Verdict,
  TaskStatus,
  TaskClaim,
  TaskVerification,
  Task,
  StateTransition,
  TerminalPayload,
  AgentRevision,
  CreateRevisionInput,
  CreateRevisionResponse,
  ListRevisionsResponse,
} from './agents.js';

// Agent memory (tenant-scoped key-value store with namespaces and search)
export { MemoryClient, NamespacedMemory } from './memory.js';
export type {
  MemoryClientConfig,
  MemoryEntry,
  MemoryListResponse,
  MemorySearchResult,
  MemorySearchResponse,
  SetOptions as MemorySetOptions,
  SearchOptions as MemorySearchOptions,
} from './memory.js';

// Workflow Runtime (Step Functions style state machines)
export { WorkflowsClient, isWorkflowRunTerminal, TERMINAL_WORKFLOW_STATUSES } from './workflows.js';
export type {
  WorkflowsClientConfig,
  Workflow,
  CreateWorkflowInput,
  WorkflowListResponse,
  StartRunResponse,
  WorkflowExecution,
} from './workflows.js';

// Funnel #1 — Audit history (read + export + RTBF)
export { HistoryClient } from './history.js';
export type {
  HistoryClientConfig,
  HistoryListResponse,
  TaskHistoryEntry,
  ListOptions as HistoryListOptions,
  ExportOptions as HistoryExportOptions,
} from './history.js';
