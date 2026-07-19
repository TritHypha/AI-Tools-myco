// search.ts — run a query against the graph.
//
// Two-phase, and this is the whole performance story:
//   1. PRUNE  — use the inverted index (the graph edges) to find the small set
//               of files that could possibly match. No file I/O.
//   2. VERIFY — read only those candidate files and confirm real matches with a
//               precise matcher (word boundaries / substring / regex).
//
// grep does phase 2 against *every* file. myco does phase 2 against only the
// files an edge points at, so a selective query touches a handful of files
// instead of the whole tree.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { FileId, SearchGraph } from "../graph/model.ts";
import { foldCase, hasUpper, wordScanner } from "../util/normalize.ts";
import { assessRegexSafety, MAX_REGEX_LINE_LEN, SEARCH_TIME_BUDGET_MS } from "./regex-guard.ts";

export type MatchMode = "word" | "substring" | "regex";

export interface SearchOptions {
  mode: MatchMode;
  // "smart" => case-sensitive only if the query contains an upper-case letter.
  caseSensitive: boolean | "smart";
  files: boolean; // search file paths instead of file contents
  limit: number;
  context: number; // lines of context on each side (content search only)
}

export interface Match {
  path: string;
  line: number; // 1-based; 0 for a filename match
  col: number; // 1-based
  length: number;
  text: string; // the whole line (or the path, for filename matches)
  before: string[];
  after: string[];
}

export interface SearchResult {
  matches: Match[];
  filesSearched: number;
  filesMatched: number;
  truncated: boolean;
  // Word-mode only: files that CONTAIN the pattern verbatim but produced no match
  // because the word-boundary test rejected them. Surfaced so a narrowed result can
  // never be mistaken for absence — the "no silent caps" contract (DESIGN §8/§10)
  // applied to the matcher itself, not just to the walker's size cap.
  wordBoundaryExcluded: number;
}

export interface SearchError {
  error: string;
}

export type SearchOutcome = SearchResult | SearchError;

export function isError(o: SearchOutcome): o is SearchError {
  return (o as SearchError).error !== undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveSensitivity(query: string, opt: boolean | "smart"): boolean {
  return opt === "smart" ? hasUpper(query) : opt;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

// Compile the precise matcher used in phase 2.
function buildMatcher(query: string, mode: MatchMode, sensitive: boolean): RegExp {
  if (mode === "regex") {
    // No `u` flag: arbitrary user regexes are not always Unicode-valid.
    return new RegExp(query, sensitive ? "g" : "gi");
  }
  const esc = escapeRegExp(query);
  const flags = sensitive ? "gu" : "giu";
  if (mode === "word") {
    // PER-EDGE boundary test: apply a lookaround ONLY where the pattern's own edge
    // character is a word constituent.
    //
    // Applying both edges unconditionally is the bug this replaces. For a pattern
    // that already ENDS in punctuation — `foo(`, `foo.`, `foo[`, `#include <`, `-> `
    // — the trailing test lands on the character AFTER the punctuation and demands
    // it be a non-word char. So `foo(bar)` is rejected while `foo("x")` and `foo()`
    // survive: every call site passing a VARIABLE disappears, which is precisely the
    // query a developer types to enumerate call sites before changing a contract.
    // Measured in the field on a real API: 5 files returned where a full walk finds
    // ~90, and `assembleWAT(c` returned zero while a file contained
    // `assembleWAT(cleanWat)`. A miss reads as absence, so this was silent and wrong.
    //
    // `foo(` keeps whole-word protection on its LEFT edge (no match inside
    // `refoo(`), and simply stops filtering on its right.
    //
    // Deliberate divergence from `grep -w`, which applies both edges unconditionally
    // — but grep's DEFAULT is not `-w`, so a grep user never trips over it, while
    // myco's default IS whole-word. Same semantics, different blast radius.
    const lead = WORD_CHAR.test(query[0] ?? "") ? "(?<![\\p{L}\\p{N}_])" : "";
    const trail = WORD_CHAR.test(query[query.length - 1] ?? "")
      ? "(?![\\p{L}\\p{N}_])"
      : "";
    return new RegExp(`${lead}${esc}${trail}`, flags);
  }
  return new RegExp(esc, flags);
}

// A non-global, verbatim matcher for the same query — used ONLY to detect files the
// word-boundary test discarded, so the summary can say so rather than imply absence.
// Non-global on purpose: `.test()` on a /g/ regex is stateful and would alternate.
function buildLooseProbe(query: string, sensitive: boolean): RegExp {
  return new RegExp(escapeRegExp(query), sensitive ? "u" : "iu");
}

// The word-terms of the query, folded — the keys we traverse in phase 1.
function queryTerms(query: string): string[] {
  const set = new Set<string>();
  const re = wordScanner();
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) set.add(foldCase(m[0]));
  return [...set];
}

function intersect(a: Set<FileId>, b: Set<FileId>): Set<FileId> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<FileId>();
  for (const id of small) if (large.has(id)) out.add(id);
  return out;
}

// Phase 1: candidate file ids, or null meaning "no usable prune — scan all".
function candidates(
  graph: SearchGraph,
  terms: string[],
  mode: MatchMode,
): FileId[] | null {
  if (mode === "regex" || terms.length === 0) return null;

  let acc: Set<FileId> | null = null;
  for (const tok of terms) {
    const fileSet = new Set<FileId>();
    if (mode === "word") {
      const files = graph.filesWithTerm(tok);
      if (files) for (const id of files.keys()) fileSet.add(id);
    } else {
      // substring: any dictionary term that contains the token contributes.
      for (const dictTerm of graph.terms()) {
        if (dictTerm.includes(tok)) {
          const files = graph.filesWithTerm(dictTerm);
          if (files) for (const id of files.keys()) fileSet.add(id);
        }
      }
    }
    acc = acc === null ? fileSet : intersect(acc, fileSet);
    if (acc.size === 0) return [];
  }
  return acc === null ? [] : [...acc];
}

function scanLine(
  line: string,
  matcher: RegExp,
): Array<{ col: number; length: number }> {
  const hits: Array<{ col: number; length: number }> = [];
  // Bound the input to any single exec — the ReDoS input-size guard. Positions in
  // the prefix are identical to the original line, so reported columns stay valid.
  const hay = line.length > MAX_REGEX_LINE_LEN ? line.slice(0, MAX_REGEX_LINE_LEN) : line;
  matcher.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(hay)) !== null) {
    hits.push({ col: m.index + 1, length: m[0].length });
    if (m[0].length === 0) matcher.lastIndex++; // guard against zero-width loops
  }
  return hits;
}

// Phase 2 for one file: read it and collect line matches.
async function matchFile(
  absPath: string,
  relPath: string,
  matcher: RegExp,
  context: number,
  loose?: RegExp,
): Promise<{ hits: Match[]; excludedByBoundary: boolean }> {
  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch {
    return { hits: [], excludedByBoundary: false };
  }
  const lines = text.split("\n");
  const out: Match[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const hit of scanLine(line, matcher)) {
      out.push({
        path: relPath,
        line: i + 1,
        col: hit.col,
        length: hit.length,
        text: line,
        before: context > 0 ? lines.slice(Math.max(0, i - context), i) : [],
        after: context > 0 ? lines.slice(i + 1, i + 1 + context) : [],
      });
    }
  }
  // Nothing matched, but the file DOES contain the pattern verbatim ⟹ the boundary
  // test discarded it. We already hold the text, so this costs one extra scan on
  // zero-hit candidates only.
  const excludedByBoundary =
    out.length === 0 && loose !== undefined && loose.test(text);
  return { hits: out, excludedByBoundary };
}

// Rank: files with more hits first, then shorter paths, then alphabetical;
// lines ascending within a file. Keeps the most relevant file at the top.
function rank(matches: Match[]): Match[] {
  const perFile = new Map<string, number>();
  for (const m of matches) perFile.set(m.path, (perFile.get(m.path) ?? 0) + 1);
  return matches.slice().sort((a, b) => {
    if (a.path !== b.path) {
      const ca = perFile.get(a.path) ?? 0;
      const cb = perFile.get(b.path) ?? 0;
      if (ca !== cb) return cb - ca;
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      return a.path < b.path ? -1 : 1;
    }
    if (a.line !== b.line) return a.line - b.line;
    return a.col - b.col;
  });
}

// Filename search: match the query against every indexed path. Path lists are
// small, so a direct scan is fine and keeps behavior obvious.
function searchNames(
  graph: SearchGraph,
  matcher: RegExp,
  limit: number,
  loose?: RegExp,
): SearchResult {
  const matches: Match[] = [];
  let searched = 0;
  let excluded = 0;
  for (const rec of graph.files()) {
    searched++;
    const nameHits = scanLine(rec.path, matcher);
    if (nameHits.length === 0) {
      if (loose !== undefined && loose.test(rec.path)) excluded++;
      continue;
    }
    for (const hit of nameHits) {
      matches.push({
        path: rec.path,
        line: 0,
        col: hit.col,
        length: hit.length,
        text: rec.path,
        before: [],
        after: [],
      });
    }
  }
  const ranked = matches.sort((a, b) =>
    a.path.length !== b.path.length
      ? a.path.length - b.path.length
      : a.path < b.path
        ? -1
        : 1,
  );
  const matched = new Set(ranked.map((m) => m.path)).size;
  return {
    matches: ranked.slice(0, limit),
    filesSearched: searched,
    filesMatched: matched,
    truncated: ranked.length > limit,
    wordBoundaryExcluded: excluded,
  };
}

export async function search(
  root: string,
  graph: SearchGraph,
  query: string,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  if (query === "") return { error: "empty query" };
  // ReDoS guard: refuse an exponential-by-construction pattern BEFORE it is compiled
  // or run (fail-closed). Ordinary patterns pass; the input cap + time budget below
  // bound whatever the static check conservatively allows.
  if (opts.mode === "regex") {
    const verdict = assessRegexSafety(query);
    if (!verdict.safe) return { error: `unsafe regex refused (ReDoS guard): ${verdict.reason}` };
  }
  const sensitive = resolveSensitivity(query, opts.caseSensitive);

  let matcher: RegExp;
  try {
    matcher = buildMatcher(query, opts.mode, sensitive);
  } catch (e) {
    return { error: `invalid ${opts.mode} pattern: ${(e as Error).message}` };
  }

  // Filename search: a leading-dot, slash-free WORD query is an EXTENSION query.
  // Word boundaries can never express ".fungi" against "cold-boot.fungi" — the
  // lookbehind at the dot demands a non-word char, but a stem's last char is a
  // word char, so the dotted query silently under-matches (found in the field:
  // 283/447 .fungi files). "-f .ext" therefore means "path ends with .ext".
  if (
    opts.files &&
    opts.mode === "word" &&
    query.length > 1 &&
    query.startsWith(".") &&
    !query.includes("/")
  ) {
    matcher = new RegExp(`${escapeRegExp(query)}$`, sensitive ? "gu" : "giu");
  }

  // Only word mode can discard a verbatim occurrence, so only word mode needs the probe.
  const loose =
    opts.mode === "word" ? buildLooseProbe(query, sensitive) : undefined;

  if (opts.files) return searchNames(graph, matcher, opts.limit, loose);

  const ids = candidates(graph, queryTerms(query), opts.mode);
  const records =
    ids === null
      ? [...graph.files()]
      : ids.map((id) => graph.file(id)).filter((r) => r !== undefined);

  const all: Match[] = [];
  const filesMatched = new Set<string>();
  const startedAt = Date.now();
  let budgetExceeded = false;
  let searched = 0;
  let excluded = 0;
  for (const rec of records) {
    // Wall-clock ceiling — a slow-but-not-refused pattern cannot run forever. We
    // stop between files (a single exec is already bounded by scanLine's input cap).
    // Reporting the real `searched` count + `truncated` keeps myco's "never mistake
    // nothing for absent" contract honest (DESIGN §8/§10).
    if (Date.now() - startedAt > SEARCH_TIME_BUDGET_MS) {
      budgetExceeded = true;
      break;
    }
    searched++;
    const abs = path.join(root, rec.path);
    const { hits, excludedByBoundary } = await matchFile(
      abs,
      rec.path,
      matcher,
      opts.context,
      loose,
    );
    if (hits.length > 0) {
      filesMatched.add(rec.path);
      all.push(...hits);
    } else if (excludedByBoundary) {
      excluded++;
    }
  }

  const ranked = rank(all);
  return {
    matches: ranked.slice(0, opts.limit),
    filesSearched: searched,
    filesMatched: filesMatched.size,
    truncated: ranked.length > opts.limit || budgetExceeded,
    wordBoundaryExcluded: excluded,
  };
}
