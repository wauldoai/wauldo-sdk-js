/**
 * SSE (Server-Sent Events) stream parser for chat completions.
 */

import { ServerError } from './errors.js';

/**
 * Throw `ServerError` when an SSE payload is an in-band error.
 *
 * OpenAI-compatible servers report a failure that happens after the stream
 * started as `data: {"error": {"message": ..., "type": ...}}`. Treating it as
 * an ordinary chunk would end the stream as an empty success.
 */
function throwIfStreamError(chunk: Record<string, unknown>): void {
  const error = chunk['error'];
  if (!isTruthyJson(error)) return;
  const message =
    typeof error === 'object' && typeof (error as Record<string, unknown>)['message'] === 'string'
      ? ((error as Record<string, unknown>)['message'] as string)
      : '';
  throw new ServerError(message || 'An error occurred during streaming', undefined, error);
}

/**
 * Python truthiness, as openai-python's `data.get("error")` applies it: null,
 * false, 0, "" and an empty array or object mean "no error" (JavaScript alone
 * would treat `{}` and `[]` as present).
 */
function isTruthyJson(v: unknown): boolean {
  if (!v) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/** Parse an SSE stream body, yielding content delta strings. */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any remaining partial multi-byte sequence
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') return;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload) as Record<string, unknown>;
        } catch (e) {
          console.warn('[wauldo] Malformed SSE chunk skipped:', String(e).slice(0, 100));
          continue;
        }
        throwIfStreamError(chunk);
        const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
        const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
        const content = delta?.['content'];
        if (typeof content === 'string') yield content;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
