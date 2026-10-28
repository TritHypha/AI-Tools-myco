// =============================================================================
// TriRegex engine — non-backtracking streaming state-set simulation.
//   * Per-char work is a fixed bitset-union bound (the certificate's unit) —
//     input content can change WHICH states are active, never HOW MUCH work a
//     character may cost. That is the ReDoS immunity, by construction.
//   * Verdicts are ternary: feed() returns +1 (proven match, latched),
//     0 (indeterminate — not yet decidable), or -1 (proven impossible).
//     end() COLLAPSES indeterminate to -1 — fail-closed at the boundary.
//   * No rewind: each code point is examined once; memory is the fixed
//     state arrays regardless of stream length.
// Contact hello@trithypha.dev · Apache-2.0.
// =============================================================================
import type { Compiled } from "./compile.ts";
import { inRangesWithCost, isWordCodePoint, resolveAssertions } from "./compile.ts";
import type { EngineStats, MatchOutcome, TriVerdict } from "./types.ts";

const INF = 0x7fffffff;

export interface TriStream {
  /** Feed a chunk; returns the latched verdict so far: +1 / 0 / -1. */
  feed(chunk: string): TriVerdict;
  /** End of stream: 0 collapses — the result is +1 or -1, never indeterminate. */
  end(): MatchOutcome;
  stats(): EngineStats;
}

export class TriMatcher {
  private readonly c: Compiled;
  private readonly uniformScan: boolean;
  constructor(c: Compiled, uniformScan: boolean) {
    this.c = c;
    this.uniformScan = uniformScan;
  }

  /** Whole-input convenience — literally stream + end (chunk-invariance by construction). */
  test(input: string): MatchOutcome & { stats: EngineStats } {
    const s = this.stream();
    s.feed(input);
    const out = s.end();
    return { ...out, stats: s.stats() };
  }

  stream(): TriStream {
    const c = this.c;
    const words = c.words;
    let cur = new Uint32Array(words);
    let nxt = new Uint32Array(words);
    let curStart = new Int32Array(c.slots).fill(INF);
    let nxtStart = new Int32Array(c.slots).fill(INF);
    let pos = 0;
    let matched = false;
    let matchStart = INF;
    let matchEnd = -1;
    let curMinStart = INF;
    let impossible = false;
    // isWord of the last consumed code point (false before position 0) — one
    // register of lookbehind, all a word boundary needs and no rewind.
    let prevWord = false;
    const resolved = new Uint8Array(c.slots); // scratch for assertion resolution
    const stats: EngineStats = { chars: 0, steps: 0, maxActive: 0 };
    let ended: MatchOutcome | undefined;

    // position 0: the atStart closure
    cur.set(c.initStart.bits);
    stats.steps += words;
    for (let s = 0; s < c.slots; s++) {
      stats.steps++;
      if ((cur[s >> 5]! >>> (s & 31)) & 1) { curStart[s] = 0; curMinStart = 0; }
    }
    if (c.initStart.matched) { matched = true; matchStart = 0; matchEnd = 0; }

    // leftmost-longest: an earlier start always wins; at the same start, the
    // longer end wins. (Declared span semantics — matches user expectation.)
    const latch = (st: number, en: number): void => {
      if (!matched || st < matchStart || (st === matchStart && en > matchEnd)) {
        matched = true; matchStart = st; matchEnd = en;
      }
    };

    const feedChar = (cp: number): void => {
      const wordNext = isWordCodePoint(cp);
      // early exit: a held match is FINAL once no active thread can beat it
      // (all remaining starts are later; fresh starts would be later still)
      if (matched && !this.uniformScan && curMinStart > matchStart) { pos++; stats.chars++; prevWord = wordNext; return; }
      // fresh unanchored start for a match beginning AT this position (pos>0;
      // position 0 is covered by the initStart closure). Once matched, a fresh
      // start is strictly later than matchStart and can never win — skip.
      if (pos > 0 && !c.anchoredStart && !matched) {
        const im = c.initMid;
        for (let w = 0; w < words; w++) {
          cur[w] = (cur[w]! | im.bits[w]!) >>> 0;
          stats.steps++;
        }
        for (let s = 0; s < c.slots; s++) {
          stats.steps++;
          if ((im.bits[s >> 5]! >>> (s & 31)) & 1 && curStart[s]! > pos) curStart[s] = pos;
        }
        if (im.matched) latch(pos, pos); // pattern matches empty at this position
      }
      // Resolve \b/\B at THIS position (between prev and next=cp), before
      // consuming: assertion threads pass or die on the boundary truth.
      stats.steps += resolveAssertions(c, cur, curStart, prevWord !== wordNext, pos, resolved, latch);
      nxt.fill(0);
      nxtStart.fill(INF);
      let active = 0;
      let minNext = INF;
      for (let s = 0; s < c.slots; s++) {
        stats.steps++;
        if (!((cur[s >> 5]! >>> (s & 31)) & 1)) continue;
        active++;
        const instr = c.prog[c.slotToInstr[s]!]!;
        if (instr.op !== "char") continue; // an eol assertion dies on a consumed char
        const rangeResult = inRangesWithCost(cp, instr.ranges);
        stats.steps += rangeResult.comparisons;
        if (!rangeResult.matched) continue;
        const row = c.rows[s]!;
        for (let w = 0; w < words; w++) {
          nxt[w] = (nxt[w]! | row[w]!) >>> 0;
          stats.steps++;
        }
        const st = curStart[s]!;
        for (let t = 0; t < c.slots; t++) {
          stats.steps++;
          if ((row[t >> 5]! >>> (t & 31)) & 1 && nxtStart[t]! > st) nxtStart[t] = st;
        }
        if (st < minNext) minNext = st;
        if (c.matchOnConsume[s]) latch(st, pos + 1);
      }
      if (active > stats.maxActive) stats.maxActive = active;
      const t1 = cur; cur = nxt; nxt = t1;
      const t2 = curStart; curStart = nxtStart; nxtStart = t2;
      curMinStart = minNext;
      prevWord = wordNext; // this consumed cp becomes the next boundary's LEFT side
      pos++;
      stats.chars++;
      if (!matched && c.anchoredStart && cur.every((w) => w === 0)) impossible = true;
    };

    return {
      feed: (chunk: string): TriVerdict => {
        if (ended !== undefined) {
          throw new Error("TPRX-STREAM: feed() called after end()");
        }
        for (const ch of chunk) feedChar(ch.codePointAt(0)!);
        return matched ? 1 : impossible ? -1 : 0;
      },
      end: (): MatchOutcome => {
        if (ended !== undefined) return ended;
        // Resolve parked \b/\B at the true end (next = none = non-word) — a
        // trailing boundary like `foo\b`, or a fresh `\b`/`\B` at end. A fresh
        // unanchored start is seeded first so a boundary that BEGINS a match at
        // end (e.g. `\B` on "") can fire.
        if (c.hasAssertions) {
          if (!matched && (pos === 0 || !c.anchoredStart)) {
            const im = c.initMid;
            for (let w = 0; w < words; w++) { cur[w] = (cur[w]! | im.bits[w]!) >>> 0; stats.steps++; }
            for (let s = 0; s < c.slots; s++) {
              stats.steps++;
              if ((im.bits[s >> 5]! >>> (s & 31)) & 1 && curStart[s]! > pos) curStart[s] = pos;
            }
            if (im.matched) latch(pos, pos);
          }
          stats.steps += resolveAssertions(c, cur, curStart, prevWord !== false, pos, resolved, latch);
        }
        // resolve parked end-of-line assertions at the true boundary
        for (let s = 0; s < c.slots; s++) {
          stats.steps++;
          if (!((cur[s >> 5]! >>> (s & 31)) & 1)) continue;
          const instr = c.prog[c.slotToInstr[s]!]!;
          if (instr.op === "eol" && c.eolResolves[s]) latch(curStart[s]!, pos);
        }
        // a fresh empty match AT end-of-input (e.g. `$`, `a*$` tails)
        if (
          !matched &&
          (pos === 0 || !c.anchoredStart) &&
          c.endFreshMatches[pos === 0 ? 1 : 0]
        ) latch(pos, pos);
        // K3 collapse at the boundary: indeterminate becomes refuse
        ended = matched ? { verdict: 1, span: [matchStart, matchEnd] } : { verdict: -1 };
        return ended;
      },
      stats: () => ({ ...stats }),
    };
  }
}
