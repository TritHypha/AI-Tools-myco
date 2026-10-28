// =============================================================================
// TriRegex — ternary streaming pattern matching for a supported subset.
// The supported engine is non-backtracking and bounded by a compile-time cost
// certificate; unsupported or over-budget patterns fail closed.
// Public API. Provenance: dp-rd-0459 (defensive publication).
// Contact hello@trithypha.dev · Apache-2.0.
// =============================================================================
import { compileAst } from "./compile.ts";
import { parsePattern } from "./parser.ts";
import { TriMatcher } from "./engine.ts";
import { findAll, toUtf16Spans } from "./find-all.ts";
import type { FindAllOptions, FindAllResult } from "./find-all.ts";
import type { Budget, CompileVeto, CostCertificate } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";

export const VERSION = "0.5.0";

export {
  MATCH, INDETERMINATE, SECURITY_VETO, DEFAULT_BUDGET,
} from "./types.ts";
export type {
  TriVerdict, Budget, CostCertificate, CompileVeto, EngineStats, MatchOutcome,
} from "./types.ts";
export type { TriStream } from "./engine.ts";
export { TriMatcher } from "./engine.ts";
export { toUtf16Spans } from "./find-all.ts";
export type { FindAllOptions, FindAllResult } from "./find-all.ts";

export interface CompileOptions {
  budget?: Partial<Budget>;
  /**
   * Disable the early exit after a latched match (every character is still
   * scanned). v0.1 HONESTY: this reduces data-dependent control flow; it is
   * NOT a constant-time guarantee (JS/JIT gives none) and the active-set size
   * still varies with content. A dense fixed-shape scan is a declared v0.2.
   */
  uniformScan?: boolean;
  /**
   * Case-insensitive matching (the `i` flag), ASCII-scoped (A-Z ↔ a-z), matching
   * the engine's ASCII \w scope. Implemented as a compile-time range fold, so it
   * costs nothing at match time and the ReDoS certificate is unchanged.
   */
  ignoreCase?: boolean;
}

export interface CompileOk {
  ok: true;
  certificate: CostCertificate;
  matcher: TriMatcher;
  /** Every non-overlapping leftmost-longest match, with its derived work bound. */
  findAll: (input: string, opts?: FindAllOptions) => FindAllResult;
}

/**
 * Compile a pattern. NEVER throws on pattern content — an unsupported or
 * over-budget pattern returns a SECURITY_VETO refusal ({ok:false, verdict:-1})
 * so the caller's fail-closed path is a value check, not exception handling.
 */
export function compile(pattern: string, opts: CompileOptions = {}): CompileOk | CompileVeto {
  if (typeof pattern !== "string") {
    return {
      ok: false,
      verdict: -1,
      code: "TPRX-PARSE",
      reason: "pattern must be a string",
    };
  }
  const supplied = opts.budget ?? {};
  const budget: Budget = {
    maxInstructions: supplied.maxInstructions ?? DEFAULT_BUDGET.maxInstructions,
    maxPatternLength: supplied.maxPatternLength ?? DEFAULT_BUDGET.maxPatternLength,
    maxRepetition: supplied.maxRepetition ?? DEFAULT_BUDGET.maxRepetition,
  };
  for (const [name, value, minimum] of [
    ["maxInstructions", budget.maxInstructions, 1],
    ["maxPatternLength", budget.maxPatternLength, 0],
    ["maxRepetition", budget.maxRepetition, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      return {
        ok: false,
        verdict: -1,
        code: "TPRX-BUDGET",
        reason: `budget.${name} must be a finite safe integer >= ${minimum}`,
      };
    }
  }
  const parsed = parsePattern(pattern, budget, opts.ignoreCase === true);
  if (!parsed.ok) return parsed;
  const compiled = compileAst(parsed.ast, budget, pattern.length);
  if ("ok" in compiled) return compiled;
  const uniform = opts.uniformScan === true;
  const matcher = new TriMatcher(compiled, uniform);
  const certificate = compiled.certificate;
  return {
    ok: true,
    certificate,
    matcher,
    findAll: (input, o) => findAll(compiled, certificate, uniform, input, o),
  };
}

export interface CaseShadowResult {
  ok: true;
  /** Case-sensitive match count. */
  sensitive: number;
  /** Case-insensitive match count. */
  insensitive: number;
  /** Matches a case-SENSITIVE search MISSED that ignoring case would find —
   *  the reverse-case occurrences. Empty when the two agree. */
  shadow: ReadonlyArray<readonly [number, number]>;
}

/**
 * The anti-silent-under-reporting check for case: run the pattern both
 * case-sensitively and case-insensitively over `input` and report the matches
 * the sensitive search MISSED (`shadow`). A caller doing a case-sensitive search
 * warns when `shadow.length > 0` — "you searched case-sensitively; there are N
 * reverse-case matches" — the exact silence that made a case-sensitive myco
 * search look empty when the content was there. Never guesses: an unsupported
 * pattern returns the SECURITY_VETO value (checked once, both compiles share it).
 */
export function caseShadow(pattern: string, input: string, opts: CompileOptions = {}): CaseShadowResult | CompileVeto {
  const cs = compile(pattern, { ...opts, ignoreCase: false });
  if (!cs.ok) return cs;
  const ci = compile(pattern, { ...opts, ignoreCase: true });
  if (!ci.ok) return ci; // by construction the same veto as cs, but checked honestly
  const sens = cs.findAll(input).spans;
  const insens = ci.findAll(input).spans;
  const sensStarts = new Set(sens.map((x) => x[0]));
  const shadow = insens.filter((x) => !sensStarts.has(x[0]));
  return { ok: true, sensitive: sens.length, insensitive: insens.length, shadow };
}
