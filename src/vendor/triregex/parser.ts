// =============================================================================
// TriRegex parser — pattern → AST, FAIL-CLOSED.
// Anything outside the certified-linear subset is a compile-time SECURITY_VETO
// with a named reason — never a silent literal, never a slow run:
//   * backreferences (\1..\9, \k<…>)      — non-regular; forces backtracking
//   * lookaround ((?=  (?!  (?<=  (?<!)   — out of scope, refused
//   * named groups / inline flags         — refused (no silent semantics)
// Supported zero-width assertions: ^ $ (position) and \b \B (word boundary,
// ASCII \w — resolved per-position in the engine, still no-rewind).
//   * unknown escapes                     — refused (fail-closed, no guessing)
// Non-backtracking discipline in the parser itself: single forward pass,
// no regexes, code-point aware (astral-safe via codePointAt).
// Contact hello@trithypha.dev · Apache-2.0.
// =============================================================================
import type { AstNode, Budget, CompileVeto, Ranges } from "./types.ts";

const MAX_CP = 0x10ffff;

// shorthand classes (ASCII-scoped v0.1 — declared in the README honesty section)
const D: Ranges = [[0x30, 0x39]];
const W: Ranges = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
const S: Ranges = [[0x09, 0x0d], [0x20, 0x20]];

export function normalizeRanges(rs: Array<[number, number]>): Ranges {
  const sorted = rs.filter(([a, b]) => a <= b).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function complementRanges(rs: Ranges): Ranges {
  const out: Array<[number, number]> = [];
  let prev = 0;
  for (const [a, b] of rs) {
    if (a > prev) out.push([prev, a - 1]);
    prev = b + 1;
  }
  if (prev <= MAX_CP) out.push([prev, MAX_CP]);
  return out;
}

const one = (cp: number): Ranges => [[cp, cp]];

type ParseOk = { ok: true; ast: AstNode };
type Res = ParseOk | CompileVeto;
const veto = (code: CompileVeto["code"], reason: string, at?: number): CompileVeto => ({
  ok: false, verdict: -1, code, reason, at,
});

/** ASCII case-fold a set of ranges: every A-Z gains its a-z twin and vice
 *  versa. Done on POSITIVE ranges BEFORE any class negation, because `/[^a]/i`
 *  must exclude BOTH `a` and `A` — folding the complement would instead widen
 *  it to match everything. ASCII-scoped, matching the engine's \w scope. */
export function caseFoldAscii(ranges: Ranges): Ranges {
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of ranges) {
    out.push([lo, hi]);
    const uLo = Math.max(lo, 0x41), uHi = Math.min(hi, 0x5a); // A-Z → add a-z
    if (uLo <= uHi) out.push([uLo + 0x20, uHi + 0x20]);
    const lLo = Math.max(lo, 0x61), lHi = Math.min(hi, 0x7a); // a-z → add A-Z
    if (lLo <= lHi) out.push([lLo - 0x20, lHi - 0x20]);
  }
  return normalizeRanges(out);
}

class P {
  private i = 0;
  private readonly s: string;
  private readonly budget: Budget;
  private readonly ignoreCase: boolean;
  constructor(s: string, budget: Budget, ignoreCase: boolean) {
    this.s = s; this.budget = budget; this.ignoreCase = ignoreCase;
  }

  /** Fold a positive range set when the `i` flag is on; identity otherwise. */
  private fold(ranges: Ranges): Ranges {
    return this.ignoreCase ? caseFoldAscii(ranges) : ranges;
  }

  private atEnd(): boolean { return this.i >= this.s.length; }
  private peek(): number { return this.s.codePointAt(this.i) ?? -1; }
  private next(): number {
    const cp = this.s.codePointAt(this.i) ?? -1;
    this.i += cp > 0xffff ? 2 : 1;
    return cp;
  }
  private eat(ch: string): boolean {
    if (this.s.startsWith(ch, this.i)) { this.i += ch.length; return true; }
    return false;
  }
  pos(): number { return this.i; }

  parse(): Res {
    const r = this.alt();
    if (!r.ok) return r;
    if (!this.atEnd()) return veto("TPRX-PARSE", `unexpected '${this.s[this.i]}'`, this.i);
    return r;
  }

  private alt(): Res {
    const items: AstNode[] = [];
    for (;;) {
      const c = this.concat();
      if (!c.ok) return c;
      items.push(c.ast);
      if (!this.eat("|")) break;
    }
    return { ok: true, ast: items.length === 1 ? items[0]! : { kind: "alt", items } };
  }

  private concat(): Res {
    const items: AstNode[] = [];
    while (!this.atEnd() && this.peek() !== 0x7c /* | */ && this.peek() !== 0x29 /* ) */) {
      const r = this.repeated();
      if (!r.ok) return r;
      items.push(r.ast);
    }
    if (items.length === 0) return { ok: true, ast: { kind: "empty" } };
    return { ok: true, ast: items.length === 1 ? items[0]! : { kind: "concat", items } };
  }

  private repeated(): Res {
    const at = this.i;
    const a = this.atom();
    if (!a.ok) return a;
    let node = a.ast;
    let min = -1;
    let max = -1;
    if (this.eat("*")) { min = 0; max = Infinity; }
    else if (this.eat("+")) { min = 1; max = Infinity; }
    else if (this.eat("?")) { min = 0; max = 1; }
    else if (this.peek() === 0x7b /* { */) {
      const q = this.quant(at);
      if (!q.ok) return q;
      const r = q.ast as { kind: "rep"; min: number; max: number };
      min = r.min; max = r.max;
    }
    if (min !== -1) {
      if (node.kind === "bol" || node.kind === "eol" || node.kind === "wb" || node.kind === "nwb")
        return veto("TPRX-PARSE", "quantifier on an anchor", at);
      node = { kind: "rep", item: node, min, max };
      const next = this.peek();
      if (
        next === 0x2a /* * */ ||
        next === 0x2b /* + */ ||
        next === 0x3f /* ? */ ||
        next === 0x7b /* { */
      ) {
        return veto(
          "TPRX-UNSUPPORTED",
          "stacked, lazy, and possessive quantifier modifiers are refused; group explicitly if repetition is intended",
          this.i,
        );
      }
    }
    return { ok: true, ast: node };
  }

  /** {n} {n,} {n,m} — digits only, capped by budget.maxRepetition (VETO beyond). */
  private quant(at: number): Res {
    const save = this.i;
    this.eat("{");
    let n = "";
    while (!this.atEnd() && this.peek() >= 0x30 && this.peek() <= 0x39) n += String.fromCodePoint(this.next());
    if (n === "") { this.i = save; return veto("TPRX-PARSE", "bare '{' — quantifier braces must be numeric (escape as \\{ for a literal)", at); }
    let m = n;
    let ranged = false;
    if (this.eat(",")) {
      ranged = true;
      m = "";
      while (!this.atEnd() && this.peek() >= 0x30 && this.peek() <= 0x39) m += String.fromCodePoint(this.next());
    }
    if (!this.eat("}")) return veto("TPRX-PARSE", "unterminated {n,m} quantifier", at);
    const min = Number(n);
    const max = ranged ? (m === "" ? Infinity : Number(m)) : min;
    if (max !== Infinity && max < min) return veto("TPRX-PARSE", `{${min},${max}}: max < min`, at);
    const cap = this.budget.maxRepetition;
    if (min > cap || (max !== Infinity && max > cap))
      return veto("TPRX-BUDGET", `repetition bound exceeds budget.maxRepetition (${cap})`, at);
    return { ok: true, ast: { kind: "rep", item: { kind: "empty" }, min, max } };
  }

  private atom(): Res {
    const at = this.i;
    const cp = this.next();
    switch (cp) {
      case 0x28: { // (
        if (this.eat("?")) {
          if (this.eat(":")) { /* non-capturing — fine */ }
          else {
            const nx = this.s.slice(this.i, this.i + 2);
            const name =
              nx.startsWith("=") ? "lookahead (?=)" :
              nx.startsWith("!") ? "negative lookahead (?!)" :
              nx.startsWith("<=") ? "lookbehind (?<=)" :
              nx.startsWith("<!") ? "negative lookbehind (?<!)" :
              nx.startsWith("<") ? "named group (?<name>)" : `inline construct (?${nx}`;
            return veto("TPRX-UNSUPPORTED", `${name} is refused by design (non-backtracking subset)`, at);
          }
        }
        const inner = this.alt();
        if (!inner.ok) return inner;
        if (!this.eat(")")) return veto("TPRX-PARSE", "unterminated group '('", at);
        return inner;
      }
      case 0x29: return veto("TPRX-PARSE", "unmatched ')'", at);
      case 0x5b: return this.charClass(at); // [
      case 0x5c: return this.escape(at);    // \
      case 0x2e: return { ok: true, ast: { kind: "any" } }; // .
      case 0x5e: return { ok: true, ast: { kind: "bol" } }; // ^
      case 0x24: return { ok: true, ast: { kind: "eol" } }; // $
      case 0x2a: case 0x2b: case 0x3f:
        return veto("TPRX-PARSE", `quantifier '${String.fromCodePoint(cp)}' with nothing to repeat`, at);
      default:
        return { ok: true, ast: { kind: "class", ranges: this.fold(one(cp)) } };
    }
  }

  /** One escape → class ranges or a refusal. Shared by atom + class body. */
  private escapeRanges(at: number): { ok: true; ranges: Ranges } | CompileVeto {
    if (this.atEnd()) return veto("TPRX-PARSE", "dangling '\\' at end of pattern", at);
    const cp = this.next();
    const c = String.fromCodePoint(cp);
    switch (c) {
      case "d": return { ok: true, ranges: D };
      case "D": return { ok: true, ranges: complementRanges(D) };
      case "w": return { ok: true, ranges: W };
      case "W": return { ok: true, ranges: complementRanges(W) };
      case "s": return { ok: true, ranges: S };
      case "S": return { ok: true, ranges: complementRanges(S) };
      case "n": return { ok: true, ranges: one(0x0a) };
      case "r": return { ok: true, ranges: one(0x0d) };
      case "t": return { ok: true, ranges: one(0x09) };
      case "f": return { ok: true, ranges: one(0x0c) };
      case "v": return { ok: true, ranges: one(0x0b) };
      case "0": return { ok: true, ranges: one(0x00) };
      case "x": {
        const h = this.s.slice(this.i, this.i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) return veto("TPRX-PARSE", "\\x expects two hex digits", at);
        this.i += 2;
        return { ok: true, ranges: one(parseInt(h, 16)) };
      }
      case "u": {
        if (this.eat("{")) {
          let h = "";
          while (!this.atEnd() && this.peek() !== 0x7d) h += String.fromCodePoint(this.next());
          if (!this.eat("}") || !/^[0-9a-fA-F]{1,6}$/.test(h)) return veto("TPRX-PARSE", "\\u{…} expects 1-6 hex digits", at);
          const v = parseInt(h, 16);
          if (v > MAX_CP) return veto("TPRX-PARSE", "\\u{…} beyond U+10FFFF", at);
          return { ok: true, ranges: one(v) };
        }
        const h = this.s.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) return veto("TPRX-PARSE", "\\u expects four hex digits", at);
        this.i += 4;
        return { ok: true, ranges: one(parseInt(h, 16)) };
      }
      // Class context only (atom-context \b/\B are handled in escape() as
      // assertions and never reach here): \b = backspace U+0008, as in JS
      // /[\b]/. \B has no class meaning — fail-closed rather than guess.
      case "b": return { ok: true, ranges: one(0x08) };
      case "B": return veto("TPRX-UNSUPPORTED", "\\B has no meaning inside a character class", at);
      case "k":
        return veto("TPRX-UNSUPPORTED", "\\k<…> backreference is refused by design (non-regular)", at);
      default: {
        if (c >= "1" && c <= "9")
          return veto("TPRX-UNSUPPORTED", `\\${c} backreference is refused by design (non-regular; forces backtracking)`, at);
        // punctuation escapes: identity for non-alphanumerics (fail-closed on unknown alpha)
        if (/[a-zA-Z]/.test(c))
          return veto("TPRX-UNSUPPORTED", `unknown escape \\${c} is refused (fail-closed — no silent literal)`, at);
        return { ok: true, ranges: one(cp) };
      }
    }
  }

  private escape(at: number): Res {
    // Atom context: \b / \B are ZERO-WIDTH ASSERTIONS (word / non-word boundary).
    // (Inside a character class the same bytes mean backspace — see escapeRanges;
    // JS does the same: /\b/ is a boundary, /[\b]/ is U+0008.)
    if (this.peek() === 0x62 /* b */) { this.next(); return { ok: true, ast: { kind: "wb" } }; }
    if (this.peek() === 0x42 /* B */) { this.next(); return { ok: true, ast: { kind: "nwb" } }; }
    const r = this.escapeRanges(at);
    if (!r.ok) return r;
    return { ok: true, ast: { kind: "class", ranges: this.fold(r.ranges) } };
  }

  /** [ … ] with ranges, negation, escapes. ']' must be escaped inside (strict). */
  private charClass(at: number): Res {
    const negated = this.eat("^");
    const acc: Array<[number, number]> = [];
    if (this.atEnd()) return veto("TPRX-PARSE", "unterminated character class", at);
    for (;;) {
      if (this.atEnd()) return veto("TPRX-PARSE", "unterminated character class", at);
      if (this.peek() === 0x5d) { this.next(); break; } // ]
      // one class item → ranges (single cp or shorthand set)
      let lo: number;
      let loSet: Ranges | null = null;
      if (this.peek() === 0x5c) {
        this.next();
        const e = this.escapeRanges(this.i - 1);
        if (!e.ok) return e;
        if (e.ranges.length === 1 && e.ranges[0]![0] === e.ranges[0]![1]) lo = e.ranges[0]![0];
        else { loSet = e.ranges; lo = -1; }
      } else lo = this.next();

      if (loSet) { for (const r of loSet) acc.push([r[0], r[1]]); continue; }

      // range a-b (only when both ends are single cps and '-' isn't final)
      if (this.peek() === 0x2d && this.s.codePointAt(this.i + 1) !== 0x5d && this.i + 1 < this.s.length) {
        this.next(); // -
        let hi: number;
        if (this.peek() === 0x5c) {
          this.next();
          const e = this.escapeRanges(this.i - 1);
          if (!e.ok) return e;
          if (!(e.ranges.length === 1 && e.ranges[0]![0] === e.ranges[0]![1]))
            return veto("TPRX-PARSE", "class range end must be a single character", at);
          hi = e.ranges[0]![0];
        } else hi = this.next();
        if (hi < lo) return veto("TPRX-PARSE", "class range out of order (hi < lo)", at);
        acc.push([lo, hi]);
      } else acc.push([lo, lo]);
    }
    let ranges = normalizeRanges(acc);
    if (ranges.length === 0 && !negated) return veto("TPRX-PARSE", "empty character class", at);
    ranges = this.fold(ranges);                 // fold the POSITIVE set, before negation
    if (negated) ranges = complementRanges(ranges);
    return { ok: true, ast: { kind: "class", ranges } };
  }
}

export function parsePattern(pattern: string, budget: Budget, ignoreCase = false): Res {
  if (pattern.length > budget.maxPatternLength)
    return veto("TPRX-BUDGET", `pattern length ${pattern.length} exceeds budget.maxPatternLength (${budget.maxPatternLength})`);
  return new P(pattern, budget, ignoreCase).parse();
}
