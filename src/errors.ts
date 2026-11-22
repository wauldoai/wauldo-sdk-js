/**
 * Custom errors for Wauldo SDK
 */

/**
 * Base error class for all Wauldo errors
 */
export class WauldoError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'WauldoError';
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, WauldoError.prototype);
  }

  override toString(): string {
    if (this.code !== undefined) {
      return `[${this.code}] ${this.message}`;
    }
    return this.message;
  }
}

/**
 * Thrown when connection to MCP server fails
 */
export class ConnectionError extends WauldoError {
  constructor(message = 'Failed to connect to MCP server') {
    super(message, -32000);
    this.name = 'ConnectionError';
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * Thrown when server returns an error response
 */
export class ServerError extends WauldoError {
  constructor(message: string, code?: number, data?: unknown) {
    super(message, code, data);
    this.name = 'ServerError';
    Object.setPrototypeOf(this, ServerError.prototype);
  }
}

/**
 * Thrown when input validation fails
 */
export class ValidationError extends WauldoError {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message, -32602);
    this.name = 'ValidationError';
    this.field = field;
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Thrown when operation times out
 */
export class TimeoutError extends WauldoError {
  readonly timeout: number | undefined;

  constructor(message = 'Operation timed out', timeout?: number) {
    super(message, -32001);
    this.name = 'TimeoutError';
    this.timeout = timeout;
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Thrown by `AgentsClient.waitForTask`, `runAndWait` and the fallback of
 * `streamTask` when a task has not settled within the wait. The task itself
 * is not affected: it keeps running on the server, and `getTask(taskId)`
 * reads it later. A `TimeoutError` (and an `Error`), so existing
 * `catch` blocks keep catching it. The message starts as before, then says
 * how to keep waiting (`waitForTask(taskId)` again).
 */
export class TaskTimeoutError extends TimeoutError {
  /** The task waited for. */
  readonly taskId: string;
  /** Its status at the last read (`"queued"`, `"running"`…). */
  readonly lastStatus: string;

  /** `timeoutMs`: the wait, in milliseconds (also `timeout`). */
  constructor(message: string, taskId: string, lastStatus: string, timeoutMs: number) {
    super(message, timeoutMs);
    this.name = 'TaskTimeoutError';
    this.taskId = taskId;
    this.lastStatus = lastStatus;
    Object.setPrototypeOf(this, TaskTimeoutError.prototype);
  }
}

/**
 * Thrown when requested tool is not available
 */
export class ToolNotFoundError extends WauldoError {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`, -32601);
    this.name = 'ToolNotFoundError';
    this.toolName = toolName;
    Object.setPrototypeOf(this, ToolNotFoundError.prototype);
  }
}
