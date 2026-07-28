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
import { applyPathFilter, type PathFilter } from "./path-filter.ts";
import { RegexExecutor } from "./regex-executor.ts";
import {
  assessRegexSafety,
  MAX_REGEX_LINE_LEN,
  REGEX_OPERATION_TIME_BUDGET_MS,
  SEARCH_TIME_BUDGET_MS,
} from "./regex-guard.ts";

export type MatchMode = "word" | "substring" | "regex";

export interface SearchOptions {
  mode: MatchMode;
  // "smart" => case-sensitive only if the query contains an upper-case letter.
  caseSensitive: boolean | "smart";
  files: boolean; // search file paths instead of file contents
  limit: number;
  context: number; // lines of context on each side (content search only)
  // Restrict the search to part of the tree (`--in`). A user-requested coverage
  // cap, so the result reports what it removed — see pathFilterExcluded below.
  pathFilter?: PathFilter;
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
  /** Output was capped by --limit or the internal bounded-collection path. */
  resultLimitExceeded: boolean;
  /** The whole-search wall-clock budget expired before every candidate was read. */
  searchTimeBudgetExceeded: boolean;
  /** An isolated JavaScript regex operation exceeded its deadline and was killed. */
  regexTimedOut: boolean;
  /** Lines whose suffix was not searched because it exceeded the regex input cap. */
  regexLinesTruncated: number;
  // Word-mode only: files that CONTAIN the pattern verbatim but produced no match
  // because the word-boundary test rejected them. Surfaced so a narrowed result can
  // never be mistaken for absence — the "no silent caps" contract (DESIGN §8/§10)
  // applied to the matcher itself, not just to the walker's size cap.
  wordBoundaryExcluded: number;
  // Content search only: phase-1 pruning intersected the query's word-terms and NO
  // file contained all of them, so zero files were even opened. Without this flag
  // the summary's "(0 searched)" is cryptic — and for a regex-intent pattern run
  // literally (e.g. `a|b` in word mode) it silently reads as absence (field report
  // 2026-07-25: two sessions independently misled in one day).
  prunedToZero: boolean;
  // `--in` only: how many candidate files the path filter removed before phase 2.
  // A cap the user asked for is still a cap — it is reported for the same reason
  // the over-size skip is (DESIGN §8/§10).
  pathFilterExcluded: number;
  // `--in` only: the filter matched NOTHING anywhere in the index. Almost always a
  // mistyped or wrongly-rooted glob, and it is the dangerous case — every result is
  // excluded, so the search returns a confident zero that looks exactly like a real
  // absence. Tested against the WHOLE index, not just this query's candidates: a
  // query that legitimately finds nothing in a valid scope must NOT raise this.
  pathFilterMatchedNothing: boolean;
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

// Does a NON-regex-mode query look like it was MEANT as a regex? Word/substring
// mode escapes metacharacters and runs the pattern literally — correct, but a user
// typing `fromCodePoint|fromCharCode` or `codePoint\(\)` gets a literal miss with
// no hint (field report 2026-07-25: a probe nearly logged a false "absent" against
// a string that WAS present). Deliberately NARROW — only the strong signals:
//   alternation `|` · an escape sequence `\w \d \b \s \( …` · `.*`/`.+` · a
//   leading `^` or trailing `$` anchor.
// A bare `(`, `.`, or `+` does NOT fire: `foo(`, `.fungi`, and `c++` are common
// honest literal queries (the per-edge boundary comment above exists for exactly
// the `foo(` case), and a note that cries wolf trains users to ignore it.
export function detectRegexIntent(query: string): boolean {
  if (query.includes("|")) return true;
  if (/\\[wdbsWDBS(){}[\]+*?.]/.test(query)) return true;
  if (/\.[*+]/.test(query)) return true;
  if (query.startsWith("^") || query.endsWith("$")) return true;
  return false;
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

async function matchFileRegex(
  absPath: string,
  relPath: string,
  executor: RegexExecutor,
  context: number,
  maxHits: number,
  operationTimeoutMs: number,
): Promise<{
  hits: Match[];
  regexLinesTruncated: number;
  regexTimedOut: boolean;
  hitLimitReached: boolean;
}> {
  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch {
    return {
      hits: [],
      regexLinesTruncated: 0,
      regexTimedOut: false,
      hitLimitReached: false,
    };
  }
  const lines = text.split("\n");
  const out: Match[] = [];
  let regexLinesTruncated = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const scanned = await executor.scan(
      line,
      MAX_REGEX_LINE_LEN,
      Math.max(1, maxHits - out.length),
      operationTimeoutMs,
    );
    if (scanned.lineTruncated) regexLinesTruncated++;
    if (scanned.timedOut) {
      return {
        hits: out,
        regexLinesTruncated,
        regexTimedOut: true,
        hitLimitReached: false,
      };
    }
    for (const hit of scanned.hits) {
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
    if (scanned.hitLimitReached || out.length >= maxHits) {
      return {
        hits: out,
        regexLinesTruncated,
        regexTimedOut: false,
        hitLimitReached: true,
      };
    }
  }
  return {
    hits: out,
    regexLinesTruncated,
    regexTimedOut: false,
    hitLimitReached: false,
  };
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
  pathFilter?: PathFilter,
): SearchResult {
  const matches: Match[] = [];
  let searched = 0;
  let excluded = 0;
  const { kept, excluded: filtered } = applyPathFilter([...graph.files()], pathFilter);
  for (const rec of kept) {
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
    resultLimitExceeded: ranked.length > limit,
    searchTimeBudgetExceeded: false,
    regexTimedOut: false,
    regexLinesTruncated: 0,
    wordBoundaryExcluded: excluded,
    prunedToZero: false, // name search scans every indexed path — nothing is pruned
    pathFilterExcluded: filtered,
    // Name search already covers the whole index, so "kept nothing" IS "matched
    // nothing anywhere" — no second pass needed to tell the two apart.
    pathFilterMatchedNothing: pathFilter !== undefined && kept.length === 0,
  };
}

async function searchNamesRegex(
  graph: SearchGraph,
  executor: RegexExecutor,
  limit: number,
  pathFilter?: PathFilter,
): Promise<SearchResult> {
  const matches: Match[] = [];
  let searched = 0;
  let resultLimitExceeded = false;
  let searchTimeBudgetExceeded = false;
  let regexTimedOut = false;
  const { kept, excluded: filtered } = applyPathFilter([...graph.files()], pathFilter);
  const startedAt = Date.now();

  for (const rec of kept) {
    const remaining = SEARCH_TIME_BUDGET_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      searchTimeBudgetExceeded = true;
      break;
    }
    searched++;
    const scanned = await executor.scan(
      rec.path,
      MAX_REGEX_LINE_LEN,
      Math.max(1, limit + 1 - matches.length),
      Math.min(REGEX_OPERATION_TIME_BUDGET_MS, remaining),
    );
    if (scanned.timedOut) {
      regexTimedOut = true;
      break;
    }
    for (const hit of scanned.hits) {
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
    if (scanned.hitLimitReached || matches.length > limit) {
      resultLimitExceeded = true;
      break;
    }
  }

  const ranked = matches.sort((a, b) =>
    a.path.length !== b.path.length
      ? a.path.length - b.path.length
      : a.path < b.path
        ? -1
        : 1,
  );
  return {
    matches: ranked.slice(0, limit),
    filesSearched: searched,
    filesMatched: new Set(ranked.map((m) => m.path)).size,
    truncated: resultLimitExceeded || searchTimeBudgetExceeded || regexTimedOut,
    resultLimitExceeded,
    searchTimeBudgetExceeded,
    regexTimedOut,
    regexLinesTruncated: 0,
    wordBoundaryExcluded: 0,
    prunedToZero: false,
    pathFilterExcluded: filtered,
    pathFilterMatchedNothing: pathFilter !== undefined && kept.length === 0,
  };
}

export async function search(
  root: string,
  graph: SearchGraph,
  query: string,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  if (query === "") return { error: "empty query" };
  // Refuse known exponential shapes before compilation. This is only a first
  // filter: every accepted raw regex still runs in the killable worker below.
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

  if (opts.files) {
    if (opts.mode !== "regex") {
      return searchNames(graph, matcher, opts.limit, loose, opts.pathFilter);
    }
    const executor = new RegexExecutor(query, matcher.flags);
    try {
      return await searchNamesRegex(graph, executor, opts.limit, opts.pathFilter);
    } finally {
      await executor.close();
    }
  }

  const ids = candidates(graph, queryTerms(query), opts.mode);
  const unfiltered =
    ids === null
      ? [...graph.files()]
      : ids.map((id) => graph.file(id)).filter((r) => r !== undefined);

  // Scope AFTER the prune and BEFORE phase 2, so the filter also saves file reads.
  const { kept: records, excluded: pathExcluded } = applyPathFilter(unfiltered, opts.pathFilter);
  // Does the filter match anything AT ALL in the index? Answered against the whole
  // index rather than this query's candidates, because the two failures need
  // different words: "nothing here matches your query" is a normal result, while
  // "your --in matches no file in this tree" is a broken query dressed as one.
  // Costs one string test per indexed path, and only when --in was passed.
  const filterMatchedNothing =
    opts.pathFilter !== undefined &&
    ![...graph.files()].some((r) => opts.pathFilter?.test(r.path));

  const all: Match[] = [];
  const filesMatched = new Set<string>();
  const startedAt = Date.now();
  let budgetExceeded = false;
  let regexTimedOut = false;
  let regexLinesTruncated = 0;
  let resultLimitExceeded = false;
  let searched = 0;
  let excluded = 0;
  const regexExecutor =
    opts.mode === "regex" ? new RegexExecutor(query, matcher.flags) : undefined;
  try {
    for (const rec of records) {
      // Whole-search ceiling in addition to the worker's per-operation deadline.
      // Reporting the exact reason keeps a partial result from reading as absence.
    if (Date.now() - startedAt > SEARCH_TIME_BUDGET_MS) {
      budgetExceeded = true;
      break;
    }
      searched++;
      const abs = path.join(root, rec.path);
      let hits: Match[];
      let excludedByBoundary = false;
      if (regexExecutor !== undefined) {
        const remaining = SEARCH_TIME_BUDGET_MS - (Date.now() - startedAt);
        if (remaining <= 0) {
          budgetExceeded = true;
          break;
        }
        const scanned = await matchFileRegex(
          abs,
          rec.path,
          regexExecutor,
          opts.context,
          Math.max(1, opts.limit + 1 - all.length),
          Math.min(REGEX_OPERATION_TIME_BUDGET_MS, remaining),
        );
        hits = scanned.hits;
        regexLinesTruncated += scanned.regexLinesTruncated;
        if (scanned.regexTimedOut) {
          regexTimedOut = true;
          all.push(...hits);
          if (hits.length > 0) filesMatched.add(rec.path);
          break;
        }
        if (scanned.hitLimitReached) resultLimitExceeded = true;
      } else {
        const matchedFile = await matchFile(
          abs,
          rec.path,
          matcher,
          opts.context,
          loose,
        );
        hits = matchedFile.hits;
        excludedByBoundary = matchedFile.excludedByBoundary;
      }
    if (hits.length > 0) {
      filesMatched.add(rec.path);
      all.push(...hits);
    } else if (excludedByBoundary) {
      excluded++;
    }
      if (resultLimitExceeded || all.length > opts.limit) {
        resultLimitExceeded = true;
        break;
      }
    }
  } finally {
    if (regexExecutor !== undefined) await regexExecutor.close();
  }

  const ranked = rank(all);
  resultLimitExceeded ||= ranked.length > opts.limit;
  return {
    matches: ranked.slice(0, opts.limit),
    filesSearched: searched,
    filesMatched: filesMatched.size,
    truncated:
      resultLimitExceeded ||
      budgetExceeded ||
      regexTimedOut ||
      regexLinesTruncated > 0,
    resultLimitExceeded,
    searchTimeBudgetExceeded: budgetExceeded,
    regexTimedOut,
    regexLinesTruncated,
    wordBoundaryExcluded: excluded,
    // The index pruned to an EMPTY candidate set (multi-term AND with no common
    // file) — surfaced so "(0 searched)" explains itself instead of reading as absence.
    // Measured on `unfiltered`, not `records`: with --in in play, an empty candidate
    // set caused by the FILTER must not be reported as the INDEX having pruned it,
    // or the summary blames the wrong mechanism and sends the user to fix a query
    // that was fine.
    prunedToZero: ids !== null && unfiltered.length === 0,
    pathFilterExcluded: pathExcluded,
    pathFilterMatchedNothing: filterMatchedNothing,
  };
}

// Search a SINGLE file directly, with NO index — used when the path argument is a
// file, not a directory (`myco -s foo path/to/file.ts`). The graph index is
// per-directory (it mkdir's `<root>/.myco`), so a file root previously died with
// `ENOTDIR: not a directory, mkdir <file>`. A lone file needs no prune anyway, so
// read-and-match it directly and reuse the same precise matcher.
export async function searchFile(
  absFile: string,
  query: string,
  opts: SearchOptions,
): Promise<SearchOutcome> {
  if (query === "") return { error: "empty query" };
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
  const loose = opts.mode === "word" ? buildLooseProbe(query, sensitive) : undefined;
  const rel = path.basename(absFile);

  if (opts.files) {
    const hits = scanLine(rel, matcher).map((h) => ({
      path: rel, line: 0, col: h.col, length: h.length, text: rel, before: [], after: [],
    }));
    return {
      matches: hits.slice(0, opts.limit),
      filesSearched: 1,
      filesMatched: hits.length > 0 ? 1 : 0,
      truncated: hits.length > opts.limit,
      resultLimitExceeded: hits.length > opts.limit,
      searchTimeBudgetExceeded: false,
      regexTimedOut: false,
      regexLinesTruncated: 0,
      wordBoundaryExcluded: hits.length === 0 && loose !== undefined && loose.test(rel) ? 1 : 0,
      prunedToZero: false, // single-file search has no index to prune
      // --in scopes a tree; an explicit single-file target IS the scope. The CLI
      // refuses the combination rather than silently ignoring the flag.
      pathFilterExcluded: 0,
      pathFilterMatchedNothing: false,
    };
  }

  let hits: Match[];
  let excludedByBoundary = false;
  let regexTimedOut = false;
  let regexLinesTruncated = 0;
  let resultLimitExceeded = false;
  if (opts.mode === "regex") {
    const executor = new RegexExecutor(query, matcher.flags);
    try {
      const scanned = await matchFileRegex(
        absFile,
        rel,
        executor,
        opts.context,
        Math.max(1, opts.limit + 1),
        REGEX_OPERATION_TIME_BUDGET_MS,
      );
      hits = scanned.hits;
      regexTimedOut = scanned.regexTimedOut;
      regexLinesTruncated = scanned.regexLinesTruncated;
      resultLimitExceeded = scanned.hitLimitReached;
    } finally {
      await executor.close();
    }
  } else {
    const matchedFile = await matchFile(absFile, rel, matcher, opts.context, loose);
    hits = matchedFile.hits;
    excludedByBoundary = matchedFile.excludedByBoundary;
  }
  const ranked = rank(hits);
  resultLimitExceeded ||= ranked.length > opts.limit;
  return {
    matches: ranked.slice(0, opts.limit),
    filesSearched: 1,
    filesMatched: hits.length > 0 ? 1 : 0,
    truncated: resultLimitExceeded || regexTimedOut || regexLinesTruncated > 0,
    resultLimitExceeded,
    searchTimeBudgetExceeded: false,
    regexTimedOut,
    regexLinesTruncated,
    wordBoundaryExcluded: excludedByBoundary ? 1 : 0,
    prunedToZero: false, // single-file search has no index to prune
    pathFilterExcluded: 0,
    pathFilterMatchedNothing: false,
  };
}
