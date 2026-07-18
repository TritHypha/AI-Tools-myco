// regex-guard.ts — a ReDoS mitigation for user-supplied regex search patterns.
//
// myco's regex mode compiles an ARBITRARY user pattern (search.ts `buildMatcher`)
// and runs it, unbounded, over every line of every candidate file. A
// catastrophic-backtracking pattern such as /(a+)+$/ against a long non-matching
// line takes exponential time and hangs the process. This module is the guard.
//
// Defense in depth, and honest about its limits:
//   1. assessRegexSafety — a STATIC refusal of the known-exponential shapes
//      (nested expanding quantifiers, i.e. "star height >= 2", and absurd bounded
//      repetition counts). Deterministic; the primary, fail-closed defense — a
//      pattern judged unsafe is NEVER compiled or run.
//   2. MAX_REGEX_LINE_LEN — bounds the input handed to any single match, so the
//      `n` in an O(2^n) / O(n^2) blow-up cannot be driven arbitrarily high.
//   3. SEARCH_TIME_BUDGET_MS — a wall-clock ceiling on one search's verify phase;
//      a slow-but-not-refused pattern cannot run forever.
//
// This is a MITIGATION, not immunity. True ReDoS-immunity needs a non-backtracking
// engine (RE2, or a ternary automaton — see the TriRegex / RD-0459 R&D). The static
// check is deliberately CONSERVATIVE: it can still pass an overlapping-alternation
// pattern like /(a|ab)*/, which layers 2 and 3 then bound. It errs toward allowing
// ordinary patterns and refusing only the shapes that are exponential by construction.

/** Bounded-repetition count at/above which a quantifier is refused outright. */
export const MAX_REPETITION = 1000;

/** A single line longer than this is matched only up to this prefix — bounds one
 *  exec's input. (myco already skips whole files over --max-size; this bounds the
 *  rare pathological single line, e.g. a minified blob, within an allowed file.) */
export const MAX_REGEX_LINE_LEN = 200_000;

/** Wall-clock ceiling for one search's verify phase; exceeded => stop + truncate. */
export const SEARCH_TIME_BUDGET_MS = 5_000;

export type RegexVerdict = { safe: true } | { safe: false; reason: string };

// Parse a `{lo,hi}` quantifier body. Returns null if it is not a real quantifier
// (a literal brace), else the bounds (hi = Infinity when the upper bound is open).
function parseBraceQuantifier(body: string): { lo: number; hi: number } | null {
  const m = /^(\d+)?(,)?(\d+)?$/.exec(body);
  if (!m || (m[1] === undefined && m[3] === undefined)) return null;
  const lo = m[1] !== undefined ? Number.parseInt(m[1], 10) : 0;
  const hi = m[3] !== undefined ? Number.parseInt(m[3], 10) : m[2] ? Infinity : lo;
  return { lo, hi };
}

/**
 * Static ReDoS-shape assessment. Fail-closed: returns { safe:false, reason } for a
 * pattern that is exponential by construction; the caller must NOT run it.
 *
 * Detects (the high-signal, low-false-positive shapes):
 *  - star height >= 2 — an expanding quantifier (`*`, `+`, or `{n,}`/`{,m>=2}`)
 *    applied to a GROUP whose body already contains an expanding quantifier:
 *    `(a+)+`, `(a*)*`, `(.*)+`, `((ab)+)*`, `(\d+)+`, …  — the canonical catastrophe.
 *  - absurd bounded repetition — any `{n}` / `{n,}` / `{n,m}` with a bound >= MAX_REPETITION.
 *
 * Char classes `[...]` are treated as a single atom; escaped metacharacters
 * (`\(`, `\)`, `\+`, …) are literals, not structure.
 */
export function assessRegexSafety(src: string): RegexVerdict {
  const groupStack: { expands: boolean }[] = [];
  let inClass = false;
  let classEscaped = false;
  // Did the atom immediately to the left just close a group, and did that group's
  // body contain an expanding quantifier? (null => the left atom is not such a group.)
  let leftGroupExpands: boolean | null = null;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inClass) {
      if (classEscaped) classEscaped = false;
      else if (c === "\\") classEscaped = true;
      else if (c === "]") inClass = false;
      leftGroupExpands = null;
      continue;
    }

    if (c === "\\") {
      i++; // the escaped char is a literal atom; skip it
      leftGroupExpands = null;
      continue;
    }
    if (c === "[") {
      inClass = true;
      leftGroupExpands = null;
      continue;
    }
    if (c === "(") {
      groupStack.push({ expands: false });
      leftGroupExpands = null;
      continue;
    }
    if (c === ")") {
      const frame = groupStack.pop();
      leftGroupExpands = frame ? frame.expands : false;
      continue;
    }

    if (c === "*" || c === "+") {
      if (leftGroupExpands === true) {
        return {
          safe: false,
          reason: `nested expanding quantifier '${c}' on a quantified group (star height >= 2) at index ${i} — catastrophic-backtracking risk`,
        };
      }
      const starTop = groupStack.at(-1);
      if (starTop) starTop.expands = true;
      leftGroupExpands = null;
      continue;
    }

    if (c === "{") {
      const close = src.indexOf("}", i);
      const bounds = close === -1 ? null : parseBraceQuantifier(src.slice(i + 1, close));
      if (bounds) {
        if (bounds.lo >= MAX_REPETITION || bounds.hi >= MAX_REPETITION) {
          return {
            safe: false,
            reason: `excessive repetition {${src.slice(i + 1, close)}} (bound >= ${MAX_REPETITION}) at index ${i}`,
          };
        }
        // Exponential nesting needs an UNBOUNDED outer quantifier ({n,} or *,+); a
        // finite {n,m} on a variable group is only polynomial (bounded work), so it
        // is NOT refused here — e.g. (\.\d{1,3}){3}, an IP-octet group, is safe.
        const outerUnbounded = bounds.hi === Infinity;
        if (outerUnbounded && leftGroupExpands === true) {
          return {
            safe: false,
            reason: `nested unbounded quantifier {${src.slice(i + 1, close)}} on a quantified group (star height >= 2) at index ${i}`,
          };
        }
        // A brace makes its group length-VARIABLE (risky to unbounded-quantify) only
        // when the range is open or hi > lo; a fixed {n} does not (`a{3}+` is linear).
        const givesChoice = bounds.hi === Infinity || bounds.hi > bounds.lo;
        if (givesChoice) {
          const braceTop = groupStack.at(-1);
          if (braceTop) braceTop.expands = true;
        }
        i = close;
      }
      leftGroupExpands = null;
      continue;
    }

    // '?' (optional / lazy modifier — bounded 0..1, never adds star height) and any
    // other literal atom.
    leftGroupExpands = null;
  }

  return { safe: true };
}

/** The self-test battery: known-dangerous patterns that MUST be refused, and
 *  ordinary patterns that MUST be allowed. Returns the failures (empty = pass).
 *  Baselined by test/regex-guard.test.ts (fix + detector ship as one unit). */
export function selfTest(): { failures: string[] } {
  const mustRefuse = ["(a+)+", "(a*)*", "(a+)*", "(.*)+", "((ab)+)*", "(a+)+$", "(\\d+)+", "(a{1,3})+", "(\\d+){2,}", "a{5000}", "(ab){1000,}"];
  const mustAllow = ["foo", "a+", "a+b+", "(abc)+", "(a|b)*", "\\bword\\b", "colou?r", "[a-z]+\\d{1,4}", "^import\\s+", "\\(a+\\)+", "[(+]*", "(a+){3}", "(a{3})+", "\\d{1,3}(\\.\\d{1,3}){3}"];
  const failures: string[] = [];
  for (const p of mustRefuse) if (assessRegexSafety(p).safe) failures.push(`FALSE-NEGATIVE (should refuse): ${p}`);
  for (const p of mustAllow) if (!assessRegexSafety(p).safe) failures.push(`FALSE-POSITIVE (should allow): ${p}`);
  return { failures };
}
