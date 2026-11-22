/**
 * What a failed task's `error` says, parsed.
 *
 * The server writes a failed task's `error` as `code: message`: the code is
 * stable, for programs; the message is for people. `taskErrorInfo` splits
 * the two.
 */

/**
 * Stable codes a failed task's `error` starts with. New codes may be added:
 * handle an unknown one like `run_failed`.
 *
 * - `invalid_preset`: the agent names a workflow preset that does not exist. Fix the agent.
 * - `invalid_agent_config`: the agent's inline workflow could not be loaded. Fix the agent.
 * - `rate_limited`: the model service is saturated. Retry in a few minutes.
 * - `timeout`: the run did not finish within its time limit. Retry, or simplify the request.
 * - `model_unavailable`: the model service is temporarily unavailable. Retry later.
 * - `run_failed`: the run failed for another reason. Retry later.
 */
export type TaskErrorCode =
  | "invalid_preset"
  | "invalid_agent_config"
  | "rate_limited"
  | "timeout"
  | "model_unavailable"
  | "run_failed";

/** Every `TaskErrorCode` this SDK version knows. */
export const TASK_ERROR_CODES: ReadonlySet<string> = new Set<TaskErrorCode>([
  "invalid_preset",
  "invalid_agent_config",
  "rate_limited",
  "timeout",
  "model_unavailable",
  "run_failed",
]);

/**
 * A task's `error`, split into its stable `code` and its `message`. A value,
 * not an exception. `code` is kept as sent, even one this SDK does not know
 * (see `TASK_ERROR_CODES`); it is `null` when the error does not start with a
 * code (the 7-day approval cancellation, for one), and `message` is then the
 * whole error.
 */
export interface TaskErrorInfo {
  /** A `TaskErrorCode`, or a code this SDK version does not know. */
  code: string | null;
  message: string;
}

const ERROR_CODE = /^[a-z][a-z0-9_]*$/;

/**
 * The parsed `error` of a task (`Task`, or a stream's `TerminalPayload`);
 * `null` when it has none. `task.error` itself is unchanged.
 */
export function taskErrorInfo(task: { error?: string | null }): TaskErrorInfo | null {
  const raw = task.error;
  if (!raw) return null;
  const sep = raw.indexOf(": ");
  if (sep > 0) {
    const code = raw.slice(0, sep);
    if (ERROR_CODE.test(code)) return { code, message: raw.slice(sep + 2) };
  }
  return { code: null, message: raw };
}
