// =============================================================================
// TriRegex — types, verdicts, budgets, certificate.
// Ternary verdict vocabulary (Kleene K3 discipline):
//   +1 MATCH        — a match is proven.
//    0 INDETERMINATE — streaming only: not yet decidable; MUST collapse at the
//                      boundary (end-of-stream) — never acted on as "good enough".
//   -1 SECURITY_VETO / NO_MATCH — refused (compile) or proven absent (run).
// Contact hello@trithypha.dev · Apache-2.0.
// =============================================================================

export type TriVerdict = -1 | 0 | 1;
export const MATCH: TriVerdict = 1;
export const INDETERMINATE: TriVerdict = 0;
export const SECURITY_VETO: TriVerdict = -1;

/** Compile-time resource budget. Exceeding any bound is a VETO, never a slow run. */
export interface Budget {
  /** Max NFA instructions after quantifier expansion (the state bound). */
  maxInstructions: number;
  /** Max source pattern length in code units. */
  maxPatternLength: number;
  /** Max finite repetition bound in {n}, {n,m} (mirrors the myco guard's cap). */
  maxRepetition: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxInstructions: 4096,
  maxPatternLength: 4096,
  maxRepetition: 1000,
};

/** The certificate: the bounds a consumer can check BEFORE running the matcher. */
export interface CostCertificate {
  /** NFA instruction count (the automaton size). */
  instructions: number;
  /** Resting states (char/eol) — the active-set upper bound. */
  restingStates: number;
  /**
   * Hard per-character work bound in the engine's certified work units. This
   * includes active-slot tests, range-search comparisons, bitset unions, and
   * leftmost-start propagation.
   */
  perCharWorkBound: number;
  /** One-off stream initialisation plus end-of-stream work bound. */
  boundaryWorkBound: number;
  /** Maximum binary-search comparisons for one character-class membership test. */
  maxRangeComparisons: number;
  /** Zero-width assertion resting states (\b, \B) — 0 when the pattern has none. */
  assertionStates: number;
  /**
   * Portable accounting estimate for closure rows and state arrays. JavaScript
   * object overhead is runtime-specific, so this is not a process-heap ceiling.
   */
  memoryBoundBytes: number;
  /** Pattern length compiled. */
  patternLength: number;
  /** True when the pattern is start-anchored (no fresh starts mid-stream). */
  anchoredStart: boolean;
}

export interface CompileVeto {
  ok: false;
  verdict: -1;
  /** Machine-usable refusal class. */
  code:
    | "TPRX-PARSE"        // malformed pattern
    | "TPRX-UNSUPPORTED"  // construct refused BY DESIGN (backref, lookaround, …)
    | "TPRX-BUDGET";      // certificate would exceed the budget
  reason: string;
  /** Offset in the pattern where the refusal fired, when known. */
  at?: number;
}

// ── AST ──────────────────────────────────────────────────────────────────────
/** Sorted, disjoint, inclusive code-point ranges. */
export type Ranges = ReadonlyArray<readonly [number, number]>;

export type AstNode =
  | { kind: "class"; ranges: Ranges }               // literal chars are 1-range classes
  | { kind: "any" }                                  // '.' — any cp except \n
  | { kind: "concat"; items: AstNode[] }
  | { kind: "alt"; items: AstNode[] }
  | { kind: "rep"; item: AstNode; min: number; max: number } // max: Infinity allowed
  | { kind: "bol" }
  | { kind: "eol" }
  | { kind: "wb" }                                    // \b — word boundary (zero-width)
  | { kind: "nwb" }                                   // \B — non-word boundary (zero-width)
  | { kind: "empty" };

// ── NFA program ──────────────────────────────────────────────────────────────
export type Instr =
  | { op: "char"; ranges: Ranges }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "bol" }
  | { op: "eol" }
  | { op: "wb" }                                      // \b resting assertion
  | { op: "nwb" }                                     // \B resting assertion
  | { op: "match" };

export interface EngineStats {
  /** Code points consumed. */
  chars: number;
  /** Certified work units performed; compare with the certificate bounds. */
  steps: number;
  /** Peak active resting-state count observed. */
  maxActive: number;
}

export interface MatchOutcome {
  verdict: -1 | 1;
  /** Leftmost-earliest first-completion span [start, end) in code POINTS, when matched. */
  span?: readonly [number, number];
}
