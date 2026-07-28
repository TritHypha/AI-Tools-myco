// output.ts — render search results for humans (colored, grep-style) or machines.
//
// Human output coalesces multiple hits on the same line into one printed line
// with every hit highlighted, the way grep --color does. Match lines use ":"
// separators; context lines use "-", so the two are visually distinguishable
// and still pipe-friendly.

import type { Match, SearchResult } from "./query/search.ts";
import { MAX_REGEX_LINE_LEN } from "./query/regex-guard.ts";

export interface RenderOptions {
  color: boolean;
  json: boolean;
}

const C = {
  reset: "\x1b[0m",
  path: "\x1b[35m", // magenta
  line: "\x1b[32m", // green
  col: "\x1b[36m", // cyan
  hit: "\x1b[1;31m", // bold red
  dim: "\x1b[2m",
};

function paint(on: boolean, code: string, s: string): string {
  return on ? code + s + C.reset : s;
}

interface LineGroup {
  path: string;
  line: number;
  text: string;
  spans: Array<{ col: number; length: number }>;
  before: string[];
  after: string[];
}

// Coalesce the ranked, already-sorted matches into one group per (path, line).
function group(matches: Match[]): LineGroup[] {
  const groups: LineGroup[] = [];
  let cur: LineGroup | undefined;
  for (const m of matches) {
    if (cur && cur.path === m.path && cur.line === m.line) {
      cur.spans.push({ col: m.col, length: m.length });
      continue;
    }
    cur = {
      path: m.path,
      line: m.line,
      text: m.text,
      spans: [{ col: m.col, length: m.length }],
      before: m.before,
      after: m.after,
    };
    groups.push(cur);
  }
  return groups;
}

function highlight(text: string, spans: Array<{ col: number; length: number }>, color: boolean): string {
  if (!color) return text;
  const sorted = spans.slice().sort((a, b) => a.col - b.col);
  let out = "";
  let cursor = 0;
  for (const s of sorted) {
    const start = s.col - 1;
    if (start < cursor) continue; // overlapping hit already covered
    out += text.slice(cursor, start);
    out += paint(true, C.hit, text.slice(start, start + s.length));
    cursor = start + s.length;
  }
  out += text.slice(cursor);
  return out;
}

function renderContent(result: SearchResult, color: boolean): string {
  const out: string[] = [];
  const groups = group(result.matches);
  let lastPath: string | null = null;
  for (const g of groups) {
    if (color && lastPath !== null && lastPath !== g.path) out.push("");
    lastPath = g.path;

    const loc =
      paint(color, C.path, g.path) +
      ":" +
      paint(color, C.line, String(g.line)) +
      ":" +
      paint(color, C.col, String(g.spans[0]?.col ?? 1));

    for (let k = 0; k < g.before.length; k++) {
      const ln = g.line - g.before.length + k;
      out.push(paint(color, C.dim, `${g.path}-${ln}- ${g.before[k]}`));
    }
    out.push(`${loc}: ${highlight(g.text, g.spans, color)}`);
    for (let k = 0; k < g.after.length; k++) {
      out.push(paint(color, C.dim, `${g.path}-${g.line + k + 1}- ${g.after[k]}`));
    }
  }
  return out.join("\n");
}

function renderNames(result: SearchResult, color: boolean): string {
  return result.matches
    .map((m) => highlight(m.path, [{ col: m.col, length: m.length }], color))
    .join("\n");
}

export function render(
  result: SearchResult,
  filesMode: boolean,
  opts: RenderOptions,
): string {
  if (opts.json) {
    return JSON.stringify(
      {
        matches: result.matches.map((m) => ({
          path: m.path,
          line: m.line,
          col: m.col,
          length: m.length,
          text: m.text,
        })),
        summary: {
          filesSearched: result.filesSearched,
          filesMatched: result.filesMatched,
          hits: result.matches.length,
          truncated: result.truncated,
          resultLimitExceeded: result.resultLimitExceeded,
          searchTimeBudgetExceeded: result.searchTimeBudgetExceeded,
          regexTimedOut: result.regexTimedOut,
          regexLinesTruncated: result.regexLinesTruncated,
          wordBoundaryExcluded: result.wordBoundaryExcluded,
          prunedToZero: result.prunedToZero,
          pathFilterExcluded: result.pathFilterExcluded,
          pathFilterMatchedNothing: result.pathFilterMatchedNothing,
        },
      },
      null,
      2,
    );
  }
  const body = filesMode
    ? renderNames(result, opts.color)
    : renderContent(result, opts.color);
  return body;
}

// A short one-line summary printed to stderr so it never pollutes piped output.
export function summaryLine(result: SearchResult): string {
  const bits = [
    `${result.matches.length} hit${result.matches.length === 1 ? "" : "s"}`,
    `${result.filesMatched} file${result.filesMatched === 1 ? "" : "s"}`,
    `(${result.filesSearched} searched)`,
  ];
  if (result.resultLimitExceeded) bits.push("[truncated — raise --limit]");
  if (result.searchTimeBudgetExceeded) {
    bits.push("[incomplete — search time budget expired]");
  }
  if (result.regexTimedOut) {
    bits.push("[incomplete — regex operation exceeded its deadline and was terminated]");
  }
  if (result.regexLinesTruncated > 0) {
    const n = result.regexLinesTruncated;
    bits.push(
      `[incomplete — ${n} over-size regex line${n === 1 ? "" : "s"} searched only to the ${MAX_REGEX_LINE_LEN}-UTF-16-code-unit cap]`,
    );
  }
  // Never let a narrowed result read as absence. If whole-word matching threw away
  // files that DO contain the pattern, say so and name the escape hatch — the same
  // "no silent caps" rule the over-size skip note already follows.
  if (result.wordBoundaryExcluded > 0) {
    const n = result.wordBoundaryExcluded;
    bits.push(
      `${n} file${n === 1 ? "" : "s"} contain${n === 1 ? "s" : ""} the pattern but ${n === 1 ? "was" : "were"} excluded by whole-word matching — try -s`,
    );
  }
  // "(0 searched)" must explain itself: the index AND-intersects the query's word
  // terms, so a multi-word (or regex-meant-as-literal) pattern can prune every
  // candidate. Cryptic zero reads as absence — the exact misread this line closes.
  if (result.prunedToZero) {
    bits.push("index pruned all candidates: no file contains ALL the query's words — miss ≠ absent (regex? use -e)");
  }
  // A scope the user asked for is still a scope. Report what it removed, so a
  // narrowed count is never read as a tree-wide one.
  if (result.pathFilterExcluded > 0) {
    const n = result.pathFilterExcluded;
    bits.push(`${n} candidate${n === 1 ? "" : "s"} outside --in (not searched)`);
  }
  // The dangerous case, and the reason this flag exists separately from the count
  // above: the filter excluded the ENTIRE index, so every possible result was
  // removed before matching and the zero below means "you scoped to nowhere", not
  // "it is not here". Those are opposite conclusions from identical output.
  if (result.pathFilterMatchedNothing) {
    bits.push("⚠ --in matched NO indexed path — the scope is empty, so this zero says nothing about the tree (check the glob; paths are root-relative)");
  }
  return bits.join(" · ");
}
