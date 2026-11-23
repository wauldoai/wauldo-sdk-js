/**
 * Verification block of a task: verdict, claims, honesty signals, run
 * contract attestation, and the outcome of a fact-check race.
 */

/** Verification verdict returned on completed tasks. */
export type Verdict =
  | "SAFE"
  | "UNCERTAIN"
  | "PARTIAL"
  | "BLOCK"
  | "CONFLICT"
  | "UNVERIFIED"
  /** The answer was too short or empty to extract a claim to verify. */
  | "INSUFFICIENT_CLAIMS";

/** A single verified claim from an agent output. */
export interface TaskClaim {
  text: string;
  supported: boolean;
  confidence: number;
}

/** Checks of the final answer itself (`TaskVerification.honesty_signals`). */
export interface HonestySignals {
  /** The answer is empty or says nothing (e.g. "no answer"). */
  is_non_answer: boolean;
  /** The answer is a raw JSON dump with no readable prose. */
  json_garbage: boolean;
  /** Which checks fired, so a client can say why the answer was flagged. */
  matched_patterns?: string[];
}

/** One way a run broke its agent's contract (`kind` names it). */
export type ContractViolation =
  | { kind: "disallowed_tool"; state: string; tool: string }
  | { kind: "unknown_state"; state: string }
  | { kind: "transition_violation"; from: string; to: string }
  | { kind: "output_schema_mismatch"; format_key: string; error: string }
  | { kind: "forbidden_pattern_matched"; pattern: string }
  | { kind: "misconfigured"; reason: string };

/**
 * Did the run honour its agent's contract (allowed tools, transitions,
 * output schema, forbidden behaviours)? Independent of the fact-check
 * `verdict`: an answer can be `SAFE` and its run `DEGRADED`.
 */
export interface ContractAttestation {
  matches: boolean;
  violations?: ContractViolation[];
  verdict: "SUCCESS" | "DEGRADED" | "FAIL";
  replay_token: string;
}

/** One model's result in a fact-check race. */
export interface RaceCandidate {
  model: string;
  score: number | null;
  timed_out: boolean;
}

/** Outcome of a fact-check race (`Task.race_result`): the winner and every candidate. */
export interface RaceResult {
  winner: string;
  winner_score: number;
  candidates: RaceCandidate[];
}

/**
 * Verification block attached to completed tasks. When
 * `verification_source === "prompt_only"` the `confidence` and
 * `hallucination_rate` fields reflect self-consistency only; rely on
 * `verdict` + `support_score` (alias `trust_score`) + `message` as authoritative.
 *
 * Note: `support_score` is the public name for the same numeric value
 * the wire protocol calls `trust_score`. The JSON wire field is unchanged
 * for backward compatibility — use `supportScore(v)` to read the value
 * by its public name. New code should prefer `support_score`.
 */
export interface TaskVerification {
  verdict: Verdict;
  hallucination_rate: number;
  confidence: number;
  trust_score: number;
  /**
   * Public name for `trust_score` (0-1 fraction of claims supported
   * by the sources). Optional on the wire; always equals `trust_score`
   * when populated. Prefer the `supportScore()` helper to read it.
   */
  support_score?: number;
  verification_source: string;
  claims: TaskClaim[];
  verification_retries: number;
  /** Human-readable context for non-SAFE verdicts. */
  message?: string | null;
  sources_cited?: number[];
  stripped_claims?: string[];
  /** Checks of the final answer itself. Absent when they were not run. */
  honesty_signals?: HonestySignals;
  /** Whether the run honoured the agent's contract. Absent for runs without one. */
  contract_attestation?: ContractAttestation;
  /** Why the run failed before reaching a verdict. Absent on success. */
  failure_reason?: string;
  /** Stage of the pipeline where the run failed. Absent on success. */
  failure_stage?: string;
}

/**
 * Read the support score of a verification block. Falls back to
 * `trust_score` when the optional `support_score` field is absent
 * (the JSON wire format only emits `trust_score` for backward
 * compatibility). Always returns the same numeric value either way.
 */
export function supportScore(v: TaskVerification): number {
  return v.support_score ?? v.trust_score;
}
