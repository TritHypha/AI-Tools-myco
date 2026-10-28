// =============================================================================
// TriRegex compiler — AST → Thompson NFA → precomputed epsilon-closure rows +
// the cost certificate. All quantifiers are expanded BOUNDED (budget-vetoed),
// so the automaton size — and therefore the per-char work bound — is fixed at
// compile time. No DFA determinization (no state explosion), no backtracking.
//
// Resting states = char instrs + eol instrs (a thread only ever "waits" at a
// char to consume, or at an eol to be resolved at end-of-input). For each char
// resting state we precompute the epsilon-closure row of resting states reached
// after consuming — the hot loop is then pure bitset unions with a hard bound.
// Contact hello@trithypha.dev · Apache-2.0.
// =============================================================================
import type { AstNode, Budget, CompileVeto, CostCertificate, Instr, Ranges } from "./types.ts";

class VetoError extends Error {
  readonly v: CompileVeto;
  constructor(v: CompileVeto) { super(v.reason); this.v = v; }
}
const budgetVeto = (reason: string): VetoError =>
  new VetoError({ ok: false, verdict: -1, code: "TPRX-BUDGET", reason });

// ── Thompson emission (sequential, fallthrough continuation) ─────────────────
class Emitter {
  prog: Instr[] = [];
  private readonly budget: Budget;
  constructor(budget: Budget) { this.budget = budget; }

  private push(i: Instr): number {
    this.prog.push(i);
    if (this.prog.length > this.budget.maxInstructions)
      throw budgetVeto(`expanded automaton exceeds budget.maxInstructions (${this.budget.maxInstructions}) — pattern refused, not run slowly`);
    return this.prog.length - 1;
  }

  finish(): void {
    this.push({ op: "match" });
  }

  emit(n: AstNode): void {
    switch (n.kind) {
      case "empty": return;
      case "bol": this.push({ op: "bol" }); return;
      case "eol": this.push({ op: "eol" }); return;
      case "wb": this.push({ op: "wb" }); return;
      case "nwb": this.push({ op: "nwb" }); return;
      case "any": this.push({ op: "char", ranges: [[0x00, 0x09], [0x0b, 0x10ffff]] }); return; // all but \n
      case "class": this.push({ op: "char", ranges: n.ranges }); return;
      case "concat": for (const c of n.items) this.emit(c); return;
      case "alt": this.emitAlt(n.items); return;
      case "rep": this.emitRep(n); return;
    }
  }

  private emitAlt(items: AstNode[]): void {
    if (items.length === 0) return;
    if (items.length === 1) { this.emit(items[0]!); return; }
    const [head, ...rest] = items;
    const s = this.push({ op: "split", x: -1, y: -1 });
    (this.prog[s] as { x: number }).x = this.prog.length;
    this.emit(head!);
    const j = this.push({ op: "jmp", x: -1 });
    (this.prog[s] as { y: number }).y = this.prog.length;
    this.emitAlt(rest);
    (this.prog[j] as { x: number }).x = this.prog.length;
  }

  private emitRep(n: { item: AstNode; min: number; max: number }): void {
    const { item, min, max } = n;
    for (let k = 0; k < min; k++) this.emit(item);
    if (max === Infinity) {
      // star: S: split(body, out); body; jmp S; out:
      const s = this.push({ op: "split", x: -1, y: -1 });
      (this.prog[s] as { x: number }).x = this.prog.length;
      this.emit(item);
      this.push({ op: "jmp", x: s });
      (this.prog[s] as { y: number }).y = this.prog.length;
      return;
    }
    // finite tail: (max-min) optionals — language-equivalent flat expansion
    for (let k = min; k < max; k++) {
      const s = this.push({ op: "split", x: -1, y: -1 });
      (this.prog[s] as { x: number }).x = this.prog.length;
      this.emit(item);
      (this.prog[s] as { y: number }).y = this.prog.length;
    }
  }
}

// ── closure machinery ────────────────────────────────────────────────────────
export interface Closure {
  /** bitset over resting slots */
  bits: Uint32Array;
  matched: boolean;
}

export interface Compiled {
  prog: Instr[];
  /** resting-slot maps */
  slotToInstr: Int32Array;
  instrToSlot: Int32Array;
  slots: number;
  words: number;
  /** per char-slot: closure row after consuming (bits over slots) */
  rows: Uint32Array[]; // rows[slot] — zero-length array for non-char slots
  /** per char-slot: consuming reaches MATCH */
  matchOnConsume: Uint8Array;
  /** per slot: 0=char, 1=eol, 2=wb (\b), 3=nwb (\B). */
  slotKind: Uint8Array;
  /** per assertion slot (wb/nwb): the closure reached by PASSING it (bits over
   *  slots, further assertions parked). Empty array for non-assertion slots. */
  assertPass: Uint32Array[];
  /** per assertion slot: passing it reaches MATCH. */
  assertPassMatched: Uint8Array;
  /** true when the pattern contains any \b / \B (enables the resolution phase). */
  hasAssertions: boolean;
  /** closure from instr 0 at position 0 (atStart) */
  initStart: Closure;
  /** closure from instr 0 mid-input (fresh unanchored start) */
  initMid: Closure;
  anchoredStart: boolean;
  certificate: CostCertificate;
  /** Precomputed: resolving this eol resting slot at end reaches MATCH. */
  eolResolves: Uint8Array;
  /** Precomputed fresh empty match at end: index 0 = mid-input, 1 = at start. */
  endFreshMatches: readonly [boolean, boolean];
}

export function compileAst(ast: AstNode, budget: Budget, patternLength: number): Compiled | CompileVeto {
  const em = new Emitter(budget);
  try {
    em.emit(ast);
    em.finish();
  } catch (e) {
    if (e instanceof VetoError) return e.v;
    throw e;
  }
  const prog = em.prog;
  const n = prog.length;

  // resting slots: char + eol + wb + nwb (every state a thread can WAIT at:
  // a char to consume, or a zero-width assertion to be resolved by context).
  const instrToSlot = new Int32Array(n).fill(-1);
  const slotList: number[] = [];
  for (let i = 0; i < n; i++) {
    const op = prog[i]!.op;
    if (op === "char" || op === "eol" || op === "wb" || op === "nwb") {
      instrToSlot[i] = slotList.length; slotList.push(i);
    }
  }
  const slotToInstr = Int32Array.from(slotList);
  const slots = slotList.length;
  const words = Math.max(1, Math.ceil(slots / 32));
  const setBit = (bits: Uint32Array, slot: number): void => {
    bits[slot >> 5] = (bits[slot >> 5]! | (1 << (slot & 31))) >>> 0;
  };

  /** epsilon walk. parkAssert: treat eol/wb/nwb as resting stops (the runtime
   *  mid-stream semantics — they are resolved later by position context).
   *  When parkAssert is false, eol passes iff atEnd and wb/nwb are NOT crossed
   *  (they have no static truth — used only by the end/reachability probes,
   *  which pass the boundary in explicitly via the resolver, not here). */
  function walk(from: number[], atStart: boolean, atEnd: boolean, parkAssert: boolean): Closure {
    const bits = new Uint32Array(words);
    let matched = false;
    const visited = new Uint8Array(n);
    const stack = [...from];
    while (stack.length) {
      const i = stack.pop()!;
      if (i < 0 || i >= n || visited[i]) continue;
      visited[i] = 1;
      const ins = prog[i]!;
      switch (ins.op) {
        case "char": setBit(bits, instrToSlot[i]!); break;
        case "eol":
          if (parkAssert) setBit(bits, instrToSlot[i]!);
          else if (atEnd) stack.push(i + 1);
          break;
        case "wb": case "nwb":
          // Always park: the boundary truth is only known at run time. The
          // reachability probes below never walk THROUGH an assertion.
          setBit(bits, instrToSlot[i]!);
          break;
        case "bol": if (atStart) stack.push(i + 1); break;
        case "split": stack.push(ins.x, ins.y); break;
        case "jmp": stack.push(ins.x); break;
        case "match": matched = true; break;
      }
    }
    return { bits, matched };
  }

  const rows: Uint32Array[] = new Array(slots);
  const matchOnConsume = new Uint8Array(slots);
  // slotKind: 0=char, 1=eol, 2=wb(\b), 3=nwb(\B). assertPass[s] = the closure
  // reached by PASSING an assertion slot (further assertions parked), so the
  // engine can resolve \b/\B at run time by unioning this in and propagating
  // the thread's start. hasAssertions gates the whole resolution phase off for
  // patterns without \b/\B (zero added cost, identical behaviour to before).
  const slotKind = new Uint8Array(slots);
  const assertPass: Uint32Array[] = new Array(slots);
  const assertPassMatched = new Uint8Array(slots);
  let hasAssertions = false;
  let assertionStates = 0;
  for (let s = 0; s < slots; s++) {
    const i = slotToInstr[s]!;
    const op = prog[i]!.op;
    slotKind[s] = op === "char" ? 0 : op === "eol" ? 1 : op === "wb" ? 2 : 3;
    if (op === "char") {
      const c = walk([i + 1], false, false, true);
      rows[s] = c.bits;
      matchOnConsume[s] = c.matched ? 1 : 0;
    } else rows[s] = new Uint32Array(0); // eol/wb/nwb — resolved by context, not by consuming
    if (op === "wb" || op === "nwb") {
      hasAssertions = true;
      assertionStates++;
      const c = walk([i + 1], false, false, true); // ⚠ atStart=false: an assertion
      assertPass[s] = c.bits;                       //   immediately followed by ^ (e.g. \b^)
      assertPassMatched[s] = c.matched ? 1 : 0;     //   is unsupported (documented); $ parks fine
    } else assertPass[s] = new Uint32Array(0);
  }

  const initStart = walk([0], true, false, true);
  const initMid = walk([0], false, false, true);
  const anchoredStart = !initMid.matched && initMid.bits.every((w) => w === 0);

  const eolResolves = new Uint8Array(slots);
  for (let s = 0; s < slots; s++) {
    const i = slotToInstr[s]!;
    if (prog[i]!.op === "eol") {
      eolResolves[s] = walk([i + 1], false, true, false).matched ? 1 : 0;
    }
  }
  const endFreshMatches: readonly [boolean, boolean] = [
    walk([0], false, true, false).matched,
    walk([0], true, true, false).matched,
  ];

  let maxRangeComparisons = 0;
  for (const ins of prog) {
    if (ins.op !== "char" || ins.ranges.length === 0) continue;
    maxRangeComparisons = Math.max(
      maxRangeComparisons,
      Math.floor(Math.log2(ins.ranges.length)) + 1,
    );
  }
  // Word-boundary resolution (only when the pattern has \b/\B): a fixpoint over
  // assertion slots. Each slot is resolved at most once per position (a
  // resolved-this-step guard breaks zero-width cycles like (\b)*), doing one
  // passClosure union (words) + start propagation (slots). Worst case: every
  // slot an assertion → slots iterations. Plus the per-step guard clear (slots).
  // This is BOUNDED and input-independent — the ReDoS immunity is preserved;
  // the constant is simply larger for assertion patterns.
  const assertResolveBound = hasAssertions ? slots + slots * (words + slots) : 0;
  // One character:
  //   optional fresh-start merge: words + slots
  //   word-boundary resolution: assertResolveBound
  //   active-set scan: slots
  //   worst case for every slot: range search + row union + start propagation.
  const perCharWorkBound =
    words + slots +
    assertResolveBound +
    slots +
    slots * (maxRangeComparisons + words + slots);
  // Stream construction initialises one bitset and scans its slots; end() scans
  // each slot once and resolves assertions once. EOL/fresh-end reachability is
  // precomputed above.
  const boundaryWorkBound = words + 2 * slots + assertResolveBound;

  const certificate: CostCertificate = {
    instructions: n,
    restingStates: slots,
    perCharWorkBound,
    boundaryWorkBound,
    maxRangeComparisons,
    assertionStates,
    memoryBoundBytes: slots * words * 4 + n * 24 + words * 8 + slots * 8,
    patternLength,
    anchoredStart,
  };

  return {
    prog, slotToInstr, instrToSlot, slots, words, rows, matchOnConsume,
    slotKind, assertPass, assertPassMatched, hasAssertions,
    initStart, initMid, anchoredStart, certificate, eolResolves, endFreshMatches,
  };
}

/** True iff `cp` is an ASCII word character (\w: [0-9A-Za-z_]) — the class JS
 *  \b uses even in /u mode. The single source of truth for boundary resolution. */
export function isWordCodePoint(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) ||
    cp === 0x5f || (cp >= 0x61 && cp <= 0x7a);
}

/**
 * Resolve every active \b/\B assertion at the current position IN PLACE.
 * `wb` is the boundary truth there (isWord(prev) XOR isWord(next)); a \b slot
 * passes iff wb, a \B slot iff !wb. Passing a slot clears it and unions its
 * precomputed passClosure into the active set, propagating the thread's start
 * (min) and latching (start, pos) on reaching MATCH. A resolved-this-step guard
 * breaks zero-width cycles. Returns the certified work units performed.
 *
 * Shared by the streaming engine and findAll so the semantics cannot drift.
 * `resolved` is a caller-owned scratch Uint8Array(slots), zeroed here.
 */
export function resolveAssertions(
  c: Compiled,
  cur: Uint32Array,
  curStart: Int32Array,
  wb: boolean,
  pos: number,
  resolved: Uint8Array,
  latch: (start: number, end: number) => void,
): number {
  if (!c.hasAssertions) return 0;
  const INF = 0x7fffffff;
  let steps = 0;
  resolved.fill(0);
  steps += c.slots;
  // Worklist of assertion slots to (re)examine. A fixpoint: passing one
  // assertion can activate another at the SAME position, which then resolves
  // under the same `wb`. Bounded by slots (each resolved at most once).
  for (let pass = 0; pass < c.slots; pass++) {
    let changed = false;
    for (let s = 0; s < c.slots; s++) {
      steps++;
      const kind = c.slotKind[s]!;
      if (kind < 2) continue;                         // char/eol — not our job
      if (resolved[s]) continue;
      if (!((cur[s >> 5]! >>> (s & 31)) & 1)) continue; // not active
      const passes = kind === 2 ? wb : !wb;           // \b iff wb, \B iff !wb
      resolved[s] = 1;
      const start = curStart[s]!;
      cur[s >> 5] = (cur[s >> 5]! & ~(1 << (s & 31))) >>> 0; // clear: resolved either way
      curStart[s] = INF;
      changed = true;
      if (!passes) continue;                          // assertion fails → thread dies here
      const pc = c.assertPass[s]!;
      for (let w = 0; w < c.words; w++) { cur[w] = (cur[w]! | pc[w]!) >>> 0; steps++; }
      for (let t = 0; t < c.slots; t++) {
        steps++;
        if ((pc[t >> 5]! >>> (t & 31)) & 1 && curStart[t]! > start) curStart[t] = start;
      }
      if (c.assertPassMatched[s]) latch(start, pos);
    }
    if (!changed) break;                              // fixpoint reached
  }
  return steps;
}

export function inRangesWithCost(
  cp: number,
  ranges: Ranges,
): { matched: boolean; comparisons: number } {
  let lo = 0;
  let hi = ranges.length - 1;
  let comparisons = 0;
  while (lo <= hi) {
    comparisons++;
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return { matched: true, comparisons };
  }
  return { matched: false, comparisons };
}

export function inRanges(cp: number, ranges: Ranges): boolean {
  return inRangesWithCost(cp, ranges).matched;
}
