#!/usr/bin/env node
// cli.ts — the `myco` command-line interface.
//
// A thin layer over the library in index.ts. Commands:
//   myco <pattern> [path]     search file contents (default)
//   myco search <pattern> ..  explicit form (use when the pattern is a command)
//   myco index [path]         (re)build the graph index
//   myco status [path]        show index stats
//
// By default a search does a cheap incremental refresh first, so results are
// never stale — unchanged files are only stat()'d, not re-read. Pass
// --no-refresh to search the existing index as-is for maximum speed.

import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { buildIndex, DEFAULT_INDEX_OPTIONS, UNLIMITED_FILE_SIZE } from "./ingest/indexer.ts";
import type { IndexOptions } from "./ingest/indexer.ts";
import { loadGraph, loadGraphOutcome, storedIndexBytes, storedIndexLayout } from "./graph/store.ts";
import type { SaveOutcome } from "./graph/store.ts";
import { buildPathFilter } from "./query/path-filter.ts";
import { search, searchFile, isError, detectRegexIntent } from "./query/search.ts";
import type { MatchMode, SearchOptions, SearchOutcome } from "./query/search.ts";
import { render, summaryLine } from "./output.ts";
import { VERSION } from "./index.ts";
import { linksCommand } from "./links.ts";
import { compareTree, filterActive, listTargets, renderCoverage, repoTop, searchTree } from "./query/branches.ts";
import type { Coverage, TargetFilter } from "./query/branches.ts";
import { terminalData, terminalJson } from "./util/terminal.ts";
import { writeIndexCoverage } from "./review/coverage-file.ts";
import { loadRules, renderReviewText, reviewRepo } from "./review/check.ts";
import { runAll } from "./review/run-all.ts";

const HELP = `myco ${VERSION} — grep, but it grows a graph.

USAGE
  myco <pattern> [path]        search file contents (smart-case, whole-word)
  myco search <pattern> [path] explicit search (when pattern is a command name)
  myco index [path]            build/refresh the graph index
  myco status [path]           show index statistics
  myco compare <path> [root]   compare one file across every branch + worktree vs main HEAD
  myco links watch <root> --snapshot <file>   foreground link monitor (links --help)
  myco check [path]            review the index + .myco/results with fixed rules (alias: review)
  myco run-all --config FILE   index + check every repo in FILE; combined status + history

REVIEW (deterministic, no AI)
      --rules FILE    review rules JSON (default: .myco/review-rules.json, then
                      myco.config.json "review", then built-in defaults)
      --out DIR       check: review dir (default .myco/review); run-all: status dir
      --config FILE   run-all: repos config ({"repos":[{"path":".."}]})
      --no-index      run-all: review only, skip the index step
  check writes review.md, review.json and baseline.json. Exit: 0 PASS, 1 WARN, 2 FAIL.

MATCHING
  (default)        whole-word match  (search "cat" ignores "concatenate")
  -s, --substring  match anywhere    (grep-like)
  -e, --regex      regular expression
  -f, --files      search file names / paths instead of contents

CASE
  (default)             smart-case: case-sensitive only if the pattern has a capital
  -i, --ignore-case     force case-insensitive
  -S, --case-sensitive  force case-sensitive

SCOPE
      --in <glob>   search only under this path; repeatable (patterns OR together).
                    Root-relative and POSIX. A plain path means "and everything
                    under it" (--in src matches src/a.ts, never srcfoo/a.ts).
                    Globs: * within a segment · ** across segments · ? one char.
                    Excluded candidates are COUNTED in the summary, and a glob that
                    matches nothing is called out — a scoped zero must never read
                    as a tree-wide absence.

OUTPUT
  -C, --context N   show N lines of context (content search)
  -n, --limit N     max results (default 1000)
      --json        machine-readable JSON
      --no-color    disable ANSI color

GIT APPS (results tree)
  In a git repo, a directory search ALSO searches every local branch (read from
  git objects at the branch commit — nothing is checked out) and every worktree,
  writing .myco/results/<query-token>/<branch__name | worktree__path>/hits.txt
  (repo@commit:path:line:text) plus summary.json. Unreadable targets are reported.
      --no-branches   skip the branch/worktree results tree
      --branch NAME   limit search/compare to this local branch; repeatable
      --worktree P    limit index/search/compare to this worktree (path or name); repeatable
                      Default: ALL branches and worktrees. A limited run says so in its
                      coverage summary; a filter matching nothing is an error (exit 2).
                      (index --branch is refused: branches are read from git objects at
                      query time and are never indexed on disk.)
  Every index/search/compare run prints a coverage summary (branches, worktrees,
  files, shards, skipped / unreadable / refused) and writes summary.md into
  .myco/results/<query-token>/. compare writes git's own unified diff per target
  (diff.patch) and thread.md: every version of the file ordered by commit time
  across branches, naming which branch changed which lines.

INDEXING
      --no-refresh    search the existing index without refreshing first
      --no-gitignore  do not honour .gitignore
      --max-size N    optional content cap (default: no cap; tree scans keep names,
                      direct-file searches report over-cap content as unknown)
      --no-tracked-ignored  do not index git-tracked files that match .gitignore
                      (default: tracked files are indexed anyway, and listed)
      --hash-oversize stream-hash over-size files (default off; never tokenized)
      --vendored      descend into vendored deps (node_modules; skipped + reported by default)
      --at REV        (index only) index the tree of commit REV from git objects, not the
                      working folder; symlinks and submodules are listed, never followed.
                      REV must resolve to a commit or the run fails (exit 2)
      --no-secret-guard  store secret-looking terms in the index (default: withheld from
                      .myco, reported by path; search still finds them by re-reading)

Exit codes: 0 = matches, 1 = no matches, 2 = error.`;

export const DEFAULT_SEARCH_LIMIT = 1000;

function toOptions(values: Record<string, unknown>): {
  search: SearchOptions;
  index: IndexOptions;
} {
  let mode: MatchMode = "word";
  if (values["regex"]) mode = "regex";
  else if (values["substring"]) mode = "substring";

  let caseSensitive: boolean | "smart" = "smart";
  if (values["ignore-case"]) caseSensitive = false;
  else if (values["case-sensitive"]) caseSensitive = true;

  const context = Number.parseInt(String(values["context"] ?? "0"), 10);
  const limit = Number.parseInt(String(values["limit"] ?? String(DEFAULT_SEARCH_LIMIT)), 10);
  const maxMb = Number.parseFloat(String(values["max-size"] ?? ""));

  return {
    search: {
      mode,
      caseSensitive,
      files: Boolean(values["files"]),
      limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SEARCH_LIMIT,
      context: Number.isFinite(context) && context > 0 ? context : 0,
    },
    index: {
      maxFileSize: Number.isFinite(maxMb) && maxMb > 0
        ? Math.floor(maxMb * 1024 * 1024)
        : DEFAULT_INDEX_OPTIONS.maxFileSize,
      useGitignore: !values["no-gitignore"],
      includeVendored: Boolean(values["vendored"]),
      hashOversize: Boolean(values["hash-oversize"]),
      includeTrackedIgnored: !values["no-tracked-ignored"],
      withholdSecrets: !values["no-secret-guard"],
    },
  };
}

function useColor(values: Record<string, unknown>): boolean {
  if (values["no-color"] || values["json"]) return false;
  if (process.env["NO_COLOR"]) return false;
  return Boolean(process.stdout.isTTY);
}

function filterFrom(values: Record<string, unknown>): TargetFilter {
  const arr = (k: string): string[] => (Array.isArray(values[k]) ? (values[k] as string[]) : []);
  return { branches: arr("branch"), worktrees: arr("worktree") };
}

async function cmdIndexFiltered(root: string, index: IndexOptions, filter: TargetFilter): Promise<number> {
  if ((filter.branches?.length ?? 0) > 0) {
    process.stderr.write(
      "myco: index --branch is refused: branches are read straight from git objects at search/compare time "
        + "and are never indexed on disk. Use `myco <pattern> --branch NAME` or `myco compare <path> --branch NAME`.\n",
    );
    return 2;
  }
  const top = await repoTop(root);
  if (top === null) {
    process.stderr.write(`myco: --worktree needs a git repo: ${terminalData(root)}\n`);
    return 2;
  }
  const { targets, filterErrors } = await listTargets(top, filter);
  if (filterErrors.length > 0) {
    for (const e of filterErrors) process.stderr.write(`myco: ${terminalData(e)}\n`);
    return 2;
  }
  let worst = 0;
  for (const t of targets) {
    process.stdout.write(`== worktree ${terminalData(t.name)} (${terminalData(t.dir ?? "")}) ==\n`);
    const code = await cmdIndex(t.dir!, index, filter);
    worst = Math.max(worst, code);
  }
  return worst;
}

async function printIndexCoverage(
  root: string,
  files: number,
  skipped: string[],
  unreadable: string[],
  limited: TargetFilter | null,
): Promise<void> {
  const top = await repoTop(root);
  const layout = await storedIndexLayout(root);
  let branches = { searched: 0, total: 0 };
  let worktrees = { searched: 0, total: 0 };
  if (top !== null) {
    const { all } = await listTargets(top);
    // The on-disk index covers THIS working tree only; branches are covered at query time.
    branches = { searched: 0, total: all.branches };
    worktrees = { searched: 1, total: all.worktrees };
  }
  const coverage: Coverage = {
    command: "index",
    repo: top === null ? null : path.basename(top),
    limited,
    branches,
    worktrees,
    targets: [],
    index: { files, layout: layout.layout, shards: layout.shards },
    skipped,
    unreadable,
    refused: [],
  };
  process.stdout.write(renderCoverage(coverage) + "\n");
  if (top !== null) {
    process.stdout.write("  (branches are not indexed on disk; search/compare read every branch from git objects)\n");
  }
}

async function cmdIndex(root: string, index: IndexOptions, filter?: TargetFilter): Promise<number> {
  // Same fail-closed guard as cmdSearch: `myco index <nonexistent>` must not
  // mkdir `<root>/.myco` at a path that doesn't exist. Create nothing, exit 2.
  if (!(await fs.stat(root).catch(() => undefined))) {
    process.stderr.write(`myco: path not found: ${terminalData(root)}\n`);
    return 2;
  }
  const started = process.hrtime.bigint();
  const {
    stats,
    saved,
    skippedLargePaths,
    skippedVendoredDirs,
    omittedOverlongTermPaths,
    unreadablePaths,
    trackedIgnoredPaths,
    skippedSymlinkPaths,
    withheldSecretPaths,
    submodulePaths,
  } = await buildIndex(root, index);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Informational output → stdout. stderr is reserved for real errors (which all
  // exit non-zero), so a consumer can treat any stderr output — or a non-zero exit —
  // as a genuine failure, and this benign stat line can never be mistaken for one.
  process.stdout.write(
    `indexed ${stats.files} files ` +
      `(+${stats.added} ~${stats.updated} -${stats.removed}, ` +
      `${stats.unchanged} unchanged, ${stats.skippedBinary} binary skipped, ` +
      (stats.pinnedCommit ? `pinned commit ${stats.pinnedCommit}, ` : "") +
      `${stats.skippedLarge} over-size skipped` +
      (index.maxFileSize < UNLIMITED_FILE_SIZE ? `, --max-size ${(index.maxFileSize / (1024 * 1024)).toFixed(0)} MiB` : `, no size limit`) +
      `) ` +
      `in ${ms.toFixed(0)}ms\n`,
  );
  noteSaveOutcome(saved);
  if (stats.omittedOverlongTerms > 0) {
    process.stdout.write(
      `  ${stats.omittedOverlongTerms} overlong term(s) omitted from the term graph `
        + `in ${stats.filesWithOmittedOverlongTerms} file(s) `
        + `(this count includes secret-looking terms withheld by the secret guard); `
        + `those files are directly verified during content search:\n`,
    );
    for (const p of omittedOverlongTermPaths) process.stdout.write(`    ${terminalData(p)}\n`);
  }
  // No silent caps: name the files that fell outside the index, so a search that
  // returns nothing is never mistaken for "not present" (DESIGN §8/§10).
  if (skippedLargePaths.length > 0) {
    const cap = index.maxFileSize < UNLIMITED_FILE_SIZE
      ? `--max-size (${(index.maxFileSize / (1024 * 1024)).toFixed(0)} MiB) or the engine text limit`
      : "the engine text limit (no --max-size set)";
    process.stdout.write(
      `  ${skippedLargePaths.length} file(s) exceed ${cap} — name-indexed with an UNKNOWN marker, content NOT searchable:\n`,
    );
    for (const p of skippedLargePaths) process.stdout.write(`    ${terminalData(p)}\n`);
  }
  if (unreadablePaths.length > 0) {
    process.stdout.write(
      `  ${unreadablePaths.length} file(s) could not be read — NOT indexed:\n`,
    );
    for (const p of unreadablePaths) process.stdout.write(`    ${terminalData(p)}\n`);
  }
  // Same no-silent-caps rule for vendored trees: name the pruned dirs and the
  // escape hatch, so a miss inside node_modules can never read as absence.
  if (skippedVendoredDirs.length > 0) {
    process.stdout.write(
      `  ${skippedVendoredDirs.length} vendored dir(s) skipped (NOT searchable; pass --vendored to include):\n`,
    );
    for (const p of skippedVendoredDirs) process.stdout.write(`    ${terminalData(p)}\n`);
  }
  // MYCO-HARD-1: never silent about what the index does not hold.
  if (withheldSecretPaths.length > 0) {
    process.stdout.write(
      `  ${stats.withheldSecretTerms} secret-looking term(s) in ${withheldSecretPaths.length} file(s) `
        + `read this run were WITHHELD from the stored index (values never printed; search re-reads these files; `
        + `pass --no-secret-guard to store them):\n`,
    );
    for (const p of withheldSecretPaths) process.stdout.write(`    ${p}\n`);
  }
  if (skippedSymlinkPaths.length > 0) {
    process.stdout.write(
      `  ${skippedSymlinkPaths.length} symlink(s) not followed - target content NOT indexed:\n`,
    );
    for (const p of skippedSymlinkPaths) process.stdout.write(`    ${p}\n`);
  }
  if (submodulePaths.length > 0) {
    process.stdout.write(
      `  ${submodulePaths.length} submodule or non-file tree entr(y/ies) not indexed (other repos):\n`,
    );
    for (const p of submodulePaths) process.stdout.write(`    ${p}\n`);
  }
  if (trackedIgnoredPaths.length > 0) {
    process.stdout.write(
      `  ${trackedIgnoredPaths.length} git-tracked file(s) matched .gitignore and were indexed anyway `
        + `(pass --no-tracked-ignored to exclude):\n`,
    );
    for (const p of trackedIgnoredPaths) process.stdout.write(`    ${terminalData(p)}\n`);
  }
  // Persist the coverage facts for `myco check` (counts + paths only, never content).
  await writeIndexCoverage(root, {
    createdAt: Date.now(),
    pinnedCommit: stats.pinnedCommit ?? null,
    saved: saved.written,
    options: {
      useGitignore: index.useGitignore,
      includeVendored: Boolean(index.includeVendored),
      includeTrackedIgnored: index.includeTrackedIgnored !== false,
      withholdSecrets: index.withholdSecrets !== false,
      maxFileSize: index.maxFileSize < UNLIMITED_FILE_SIZE ? index.maxFileSize : null,
    },
    stats: {
      files: stats.files,
      skippedBinary: stats.skippedBinary,
      skippedLarge: stats.skippedLarge,
      withheldSecretTerms: stats.withheldSecretTerms,
      omittedOverlongTerms: stats.omittedOverlongTerms,
    },
    lists: {
      overSize: skippedLargePaths,
      unreadable: unreadablePaths,
      vendoredDirs: skippedVendoredDirs,
      symlinks: skippedSymlinkPaths,
      submodules: submodulePaths,
      withheldSecret: withheldSecretPaths,
      trackedIgnored: trackedIgnoredPaths,
      omittedOverlong: omittedOverlongTermPaths,
    },
  }).catch((e: unknown) => {
    process.stdout.write(`myco: note — coverage summary for \`myco check\` NOT written: ${terminalData((e as Error).message)}\n`);
  });
  await printIndexCoverage(
    root,
    stats.files,
    [
      ...skippedLargePaths.map((p) => `content (over-size, name-indexed): ${p}`),
      ...skippedVendoredDirs.map((p) => `vendored dir: ${p}`),
      ...skippedSymlinkPaths.map((p) => `symlink (not followed): ${p}`),
      ...submodulePaths.map((p) => `submodule / non-file entry: ${p}`),
      ...withheldSecretPaths.map((p) => `secret-looking terms withheld from index (search re-reads): ${p}`),
      ...(stats.skippedBinary > 0 ? [`${stats.skippedBinary} binary file(s) (name-indexed only)`] : []),
    ],
    unreadablePaths,
    filter && filterActive(filter) ? filter : null,
  );
  return 0;
}

// A structurally invalid generated payload must be reported if it could not be
// persisted. Informational → stdout; the search itself still succeeded.
function noteSaveOutcome(saved: SaveOutcome): void {
  if (saved.written) return;
  if (saved.reason === "resource-limit") {
    process.stdout.write(
      "myco: note — index NOT cached: the persisted-index resource limit was exceeded. "
        + "Results are still searched from the in-memory graph.\n",
    );
    return;
  }
  process.stdout.write(
    "myco: note — index NOT cached: generated graph violates the stored-index contract. "
      + "Results are correct, but the cache was refused before writing.\n",
  );
}

async function cmdStatus(root: string): Promise<number> {
  const outcome = await loadGraphOutcome(root);
  if (outcome.status !== "ok") {
    // "rejected" and "absent" are different problems with different remedies —
    // one needs a rebuild, the other needs the stale artifact removed. Reporting
    // both as "no index" sends the user to the wrong fix.
    process.stderr.write(
      outcome.status === "rejected"
        ? `index at ${terminalData(path.join(root, ".myco"))} exists but was REFUSED `
          + `(malformed or incompatible format) — `
          + `delete it and run: myco index\n`
        : `no index at ${terminalData(path.join(root, ".myco"))} — run: myco index\n`,
    );
    return 2;
  }
  const loaded = outcome;
  let bytes = 0;
  try {
    bytes = await storedIndexBytes(root);
  } catch {
    /* ignore */
  }
  const when = new Date(loaded.meta.createdAt).toISOString();
  process.stdout.write(
    `files:  ${loaded.meta.fileCount}\n` +
      `unique content terms:  ${loaded.meta.termCount} (case-folded; not occurrences; path-name terms are separate)\n` +
      `file-term links:  ${loaded.graph.termEdgeCount()} (distinct file/term pairs; repeats in one file count once)\n` +
      `omitted overlong terms:  ${loaded.meta.omittedOverlongTerms}\n` +
      `files requiring direct verification:  ${loaded.meta.filesWithOmittedOverlongTerms}\n` +
      `index:  ${(bytes / 1024).toFixed(1)} KiB\n` +
      `built:  ${when}\n`,
  );
  return 0;
}

async function cmdSearch(
  pattern: string | undefined,
  root: string,
  values: Record<string, unknown>,
): Promise<number> {
  if (pattern === undefined) {
    process.stderr.write("myco: missing search pattern\n\n" + HELP + "\n");
    return 2;
  }
  const { search: sOpts, index: iOpts } = toOptions(values);
  sOpts.maxFileSize = iOpts.maxFileSize;

  // --in is a coverage cap. If it cannot be honoured exactly as written, STOP —
  // never fall back to searching everything. A filter that silently widens is the
  // worst outcome available here: the user believes they scoped, the tool returns
  // tree-wide hits, and the extra results look like evidence rather than noise.
  const inPatterns = values["in"] as string[] | undefined;
  if (inPatterns !== undefined) {
    const built = buildPathFilter(inPatterns);
    if (typeof built === "string") {
    process.stderr.write(`myco: ${terminalData(built)}\n`);
      return 2;
    }
    sOpts.pathFilter = built;
  }

  // A regex-shaped pattern (`a|b`, `\(`, `.*`, anchors) outside regex mode runs as a
  // LITERAL — correct, but two zero-trust probes were misled by exactly this in one
  // day (2026-07-25): the literal miss read as "absent". Say so up front; stdout,
  // informational — the search still runs, semantics unchanged (fail-closed = keep
  // behavior, surface the trap).
  if (!values["json"] && sOpts.mode !== "regex" && detectRegexIntent(pattern)) {
    process.stdout.write(
      `myco: note — pattern looks like a regex but ran as a LITERAL ${sOpts.mode} match; pass -e for regex\n`,
    );
  }

  // A file path arg (not a directory) → search just that one file, no index. myco's
  // index is per-directory (it mkdir's `<root>/.myco`), so a file root previously died
  // with `ENOTDIR: not a directory, mkdir <file>`. A lone file needs no prune anyway.
  const targetStat = await fs.stat(root).catch(() => undefined);
  if (!targetStat) {
    // A missing (or unstattable) path must NOT fall through to the buildIndex branch:
    // buildIndex → saveGraph() mkdir's `<root>/.myco` RECURSIVELY, which would
    // MATERIALISE a directory tree at a path the user only queried — a read-only
    // search with a filesystem side effect (a typo'd path becomes a stray dir, and
    // the created dir can then be picked up by a test-runner glob → spurious failure).
    // Fail closed: report and create nothing.
    process.stderr.write(`myco: path not found: ${terminalData(root)}\n`);
    return 2;
  }
  let outcome: SearchOutcome;
  let unreadableDuringRefresh: string[] = [];
  let skippedLargeDuringRefresh: string[] = [];
  let skippedVendoredDuringRefresh: string[] = [];
  if (targetStat?.isFile()) {
    // --in scopes a TREE; the target here is one named file, so the flag can only
    // be a mistake — either the user meant a different root, or they expect a
    // filter that will never be consulted. Accepting it and ignoring it would
    // return that file's hits while the user believes a scope was applied.
    if (sOpts.pathFilter) {
      process.stderr.write("myco: --in scopes a directory tree, but the path given is a single file — drop --in, or point at the directory\n");
      return 2;
    }
    outcome = await searchFile(root, pattern, sOpts);
  } else {
    // Refresh (incremental) unless told not to, so results are never stale.
    let graph;
    if (values["no-refresh"]) {
      const loaded = await loadGraph(root);
      if (!loaded) {
        process.stderr.write("myco: no index yet — run `myco index` or drop --no-refresh\n");
        return 2;
      }
      graph = loaded.graph;
    } else {
      // Say WHICH of the two reasons applies. Reporting a refused index as a
      // "first run" is how a rejected cache stayed invisible: the message
      // was reassuring, identical every time, and pointed at nothing to fix.
      const prior = await loadGraphOutcome(root);
      if (prior.status === "rejected" && !values["json"]) {
        process.stdout.write(
          `myco: existing index at ${terminalData(path.join(path.resolve(root), ".myco"))} was REFUSED `
            + `(malformed or incompatible format) — re-indexing…\n`,
        );
      } else if (prior.status === "absent" && !values["json"]) {
        // Informational note → stdout (stderr is errors only).
        process.stdout.write(`myco: indexing ${terminalData(path.resolve(root))} (first run)…\n`);
      }
      const built = await buildIndex(root, iOpts);
      graph = built.graph;
      unreadableDuringRefresh = built.unreadablePaths;
      skippedLargeDuringRefresh = built.skippedLargePaths;
      skippedVendoredDuringRefresh = built.skippedVendoredDirs;
      if (!values["json"]) noteSaveOutcome(built.saved);
      // Surface an over-size skip even on the search path — otherwise an oversized file
      // silently misses and a zero-result reads as "absent" (the recurring "we keep
      // missing things" failure). Informational → stdout: a skip is not a failure.
      if (built.skippedLargePaths.length > 0 && !values["json"]) {
        process.stdout.write(
          `myco: note — ${built.skippedLargePaths.length} file(s) over --max-size ` +
            `not searched (run \`myco index\` to list them)\n`,
        );
      }
      // Vendored trees pruned on the search path get the same visibility as the
      // over-size skip — a node_modules miss must never read as absence.
      if (!values["json"] && built.skippedVendoredDirs.length > 0) {
        process.stdout.write(
          `myco: note — ${built.skippedVendoredDirs.length} vendored dir(s) (node_modules) ` +
            `not searched (pass --vendored to include)\n`,
        );
      }
    }
    outcome = await search(root, graph, pattern, sOpts);
    if (!isError(outcome) && unreadableDuringRefresh.length > 0) {
      const unreadablePaths = [...new Set([...(outcome.unreadablePaths ?? []), ...unreadableDuringRefresh])];
      outcome = { ...outcome, complete: false, unreadablePaths };
    }
    if (!isError(outcome) && (skippedLargeDuringRefresh.length > 0 || skippedVendoredDuringRefresh.length > 0)) {
      outcome = {
        ...outcome,
        complete: false,
        skippedCoverage: {
          largePaths: skippedLargeDuringRefresh,
          vendoredDirs: skippedVendoredDuringRefresh,
        },
      };
    }
    let coveragePrinted = false;
    if (!values["no-branches"] && !sOpts.files) {
      const top = await repoTop(root);
      if (top === null && filterActive(filterFrom(values))) {
      process.stderr.write(`myco: --branch/--worktree need a git repo: ${terminalData(root)}\n`);
        return 2;
      }
      if (top !== null) {
        coveragePrinted = !values["json"];
        const filter = filterFrom(values);
        const tree = await searchTree(root, top, pattern, { mode: sOpts.mode, caseSensitive: sOpts.caseSensitive, filter });
        if (tree.filterErrors.length > 0) {
          for (const e of tree.filterErrors) process.stderr.write(`myco: ${terminalData(e)}\n`);
          return 2;
        }
        if (!values["json"]) {
          const layout = await storedIndexLayout(root);
          tree.coverage.index = { files: [...graph.files()].length, layout: layout.layout, shards: layout.shards };
          if (!isError(outcome) && outcome.longLineRefusals.length > 0) {
            tree.coverage.refused.push(
              ...outcome.longLineRefusals.map((r) => `TriRegex ${r.code} at ${r.path}:${r.line}: ${r.reason}`),
            );
          }
          process.stdout.write(renderCoverage(tree.coverage) + "\n");
        }
        const failed = tree.results.filter((r) => r.status === "error");
        if (!values["json"]) {
          const total = tree.results.reduce((sum, r) => sum + r.hits, 0);
          process.stdout.write(
            `myco: results tree — ${tree.results.length} branch/worktree target(s), ${total} hit(s): ${tree.dir}\n`,
          );
          for (const r of tree.results) {
            process.stdout.write(`    ${terminalData(r.token)}  ${r.status === "ok" ? `${r.hits} hit(s)` : `UNREADABLE: ${terminalData(r.error ?? "")}`}\n`);
          }
          for (const e of tree.errors) process.stdout.write(`    UNREADABLE: ${terminalData(e)}\n`);
        }
        if (failed.length > 0 || tree.errors.length > 0) {
          process.stderr.write(`myco: ${failed.length + tree.errors.length} branch/worktree target(s) could not be read — see ${terminalData(tree.dir)}\n`);
        }
      }
    }
    if (!coveragePrinted && !values["json"]) {
      const layout = await storedIndexLayout(root);
      const top = await repoTop(root);
      const reason = values["no-branches"] ? "--no-branches" : sOpts.files ? "--files" : null;
      process.stdout.write(renderCoverage({
        command: "search",
        repo: top === null ? null : path.basename(top),
        limited: null,
        branches: { searched: 0, total: 0 },
        worktrees: { searched: top === null ? 0 : 1, total: top === null ? 0 : 1 },
        targets: [],
        index: { files: [...graph.files()].length, layout: layout.layout, shards: layout.shards },
        skipped: reason ? [`branches/other worktrees not searched (${reason})`] : [],
        unreadable: [],
        refused: !isError(outcome)
          ? outcome.longLineRefusals.map((r) => `TriRegex ${r.code} at ${r.path}:${r.line}: ${r.reason}`)
          : [],
      }) + "\n");
    }
  }
  if (isError(outcome)) {
    process.stderr.write(`myco: ${terminalData(outcome.error)}\n`);
    return 2;
  }

  const body = render(outcome, sOpts.files, {
    color: useColor(values),
    json: Boolean(values["json"]),
  });
  if (body) process.stdout.write(body + "\n");
  // Summary → stdout (informational). stderr stays empty on a successful search, so
  // stderr-non-empty is a trustworthy failure signal at the shell/tool boundary.
  if (!values["json"]) process.stdout.write(summaryLine(outcome) + "\n");

  // An incomplete coverage result is evidence, but never a successful proof of
  // presence or absence. Preserve the body/JSON for diagnosis and fail the
  // process boundary closed. A user-requested result limit is different: it
  // proves at least the returned matches and remains a normal capped result.
  if (
    outcome.searchTimeBudgetExceeded ||
    outcome.regexTimedOut ||
    outcome.regexLinesTruncated > 0 ||
    outcome.longLineRefusals.length > 0 ||
    !outcome.complete ||
    outcome.unknown.length > 0
  ) return 2;
  return outcome.matches.length > 0 ? 0 : 1;
}

async function cmdCompare(relPath: string | undefined, root: string, json: boolean, filter: TargetFilter): Promise<number> {
  if (relPath === undefined) {
    process.stderr.write("myco: compare needs a repo-relative <path>\n");
    return 2;
  }
  const top = await repoTop(root);
  if (top === null) {
    process.stderr.write(`myco: compare needs a git repo: ${terminalData(root)}\n`);
    return 2;
  }
  const result = await compareTree(root, top, relPath, filter);
  if (result.filterErrors.length > 0) {
    for (const e of result.filterErrors) process.stderr.write(`myco: ${terminalData(e)}\n`);
    return 2;
  }
  if (json) {
    process.stdout.write(terminalJson(result) + "\n");
  } else {
    process.stdout.write(
      `compare ${terminalData(relPath)} vs ${result.base ? `${terminalData(result.base.ref)}@${result.base.commit.slice(0, 12)}` : "(no base)"}`
        + `${result.baseMissing ? " (absent at base)" : ""} — ${terminalData(result.dir)}\n`,
    );
    for (const row of result.rows) {
      process.stdout.write(`  ${row.state.padEnd(9)} ${terminalData(row.token)}  ${row.commit.slice(0, 12)}${row.detail ? `  ${terminalData(row.detail)}` : ""}\n`);
    }
    for (const e of result.errors) process.stdout.write(`  UNREADABLE: ${terminalData(e)}\n`);
    process.stdout.write(`  thread: ${result.thread.length} version(s) by commit time — ${terminalData(path.join(result.dir, "thread.md"))}\n`);
    process.stdout.write(renderCoverage(result.coverage) + "\n");
  }
  const bad = result.rows.filter((r) => r.state === "error").length + result.errors.length;
  if (bad > 0) {
    process.stderr.write(`myco: ${bad} branch/worktree target(s) could not be read\n`);
    return 2;
  }
  return 0;
}

async function cmdCheck(root: string, values: Record<string, unknown>): Promise<number> {
  if (!(await fs.stat(root).catch(() => undefined))) {
    process.stderr.write(`myco: path not found: ${terminalData(root)}\n`);
    return 2;
  }
  let loaded;
  try {
    loaded = await loadRules(root, values["rules"] === undefined ? undefined : path.resolve(String(values["rules"])));
  } catch (e) {
    process.stderr.write(`myco: ${terminalData((e as Error).message)}\n`);
    return 2;
  }
  const result = await reviewRepo(root, {
    rules: loaded.rules,
    rulesSource: loaded.source,
    ...(values["out"] !== undefined ? { outDir: path.resolve(String(values["out"])) } : {}),
  });
  process.stdout.write((values["json"] ? terminalJson(result) : renderReviewText(result).split("\n").map((l) => terminalData(l)).join("\n")) + "\n");
  return result.exitCode;
}

async function cmdRunAll(values: Record<string, unknown>): Promise<number> {
  if (values["config"] === undefined) {
    process.stderr.write("myco: run-all needs --config <file>\n");
    return 2;
  }
  try {
    const r = await runAll(path.resolve(String(values["config"])), {
      ...(values["out"] !== undefined ? { outDir: path.resolve(String(values["out"])) } : {}),
      noIndex: Boolean(values["no-index"]),
    });
    process.stdout.write(`myco run-all: ${r.status} — ${r.repos.length} repo(s); status: ${terminalData(path.join(r.outDir, "status.md"))}\n`);
    for (const repo of r.repos) process.stdout.write(`  ${repo.status.padEnd(4)} ${terminalData(repo.name)}  ${terminalData(repo.reason)}\n`);
    return r.exitCode;
  } catch (e) {
    process.stderr.write(`myco: ${terminalData((e as Error).message)}\n`);
    return 2;
  }
}

async function run(argv: string[]): Promise<number> {
  if (argv[0] === 'links') return linksCommand(argv.slice(1));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      files: { type: "boolean", short: "f" },
      substring: { type: "boolean", short: "s" },
      regex: { type: "boolean", short: "e" },
      "ignore-case": { type: "boolean", short: "i" },
      "case-sensitive": { type: "boolean", short: "S" },
      context: { type: "string", short: "C" },
      limit: { type: "string", short: "n" },
      json: { type: "boolean" },
      "no-color": { type: "boolean" },
      "no-gitignore": { type: "boolean" },
      "no-refresh": { type: "boolean" },
      "max-size": { type: "string" },
      "hash-oversize": { type: "boolean" },
      "no-branches": { type: "boolean" },
      in: { type: "string", multiple: true },
      vendored: { type: "boolean" },
      "no-tracked-ignored": { type: "boolean" },
      at: { type: "string" },
      "no-secret-guard": { type: "boolean" },
      branch: { type: "string", multiple: true },
      worktree: { type: "string", multiple: true },
      rules: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      "no-index": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values["version"]) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (values["help"] || positionals.length === 0) {
    process.stdout.write(HELP + "\n");
    return values["help"] ? 0 : 1;
  }

  const [first, ...rest] = positionals;
  const { index: iOpts } = toOptions(values);
  if (values["at"] !== undefined && first !== "index") {
    // Never silently ignore a pin: search/compare read the working folder and branches.
    process.stderr.write("myco: --at is only valid with `myco index`\n");
    return 2;
  }

  switch (first) {
    case "index": {
      const filter = filterFrom(values);
      if (values["at"] !== undefined) {
        // Pinned-commit indexing reads ONE commit's tree; it does not combine with
        // worktree filters (each worktree is a working folder, the opposite mode).
        if (filterActive(filter)) {
          process.stderr.write("myco: --at cannot be combined with --branch/--worktree\n");
          return 2;
        }
        return cmdIndex(path.resolve(rest[0] ?? "."), { ...iOpts, atCommit: String(values["at"]) });
      }
      return filterActive(filter)
        ? cmdIndexFiltered(path.resolve(rest[0] ?? "."), iOpts, filter)
        : cmdIndex(path.resolve(rest[0] ?? "."), iOpts);
    }
    case "compare":
      return cmdCompare(rest[0], path.resolve(rest[1] ?? "."), Boolean(values["json"]), filterFrom(values));
    case "status":
      return cmdStatus(path.resolve(rest[0] ?? "."));
    case "check":
    case "review":
      return cmdCheck(path.resolve(rest[0] ?? "."), values);
    case "run-all":
      return cmdRunAll(values);
    case "help":
      process.stdout.write(HELP + "\n");
      return 0;
    case "version":
      process.stdout.write(VERSION + "\n");
      return 0;
    case "search":
      return cmdSearch(rest[0], path.resolve(rest[1] ?? "."), values);
    default:
      return cmdSearch(first, path.resolve(rest[0] ?? "."), values);
  }
}

// A downstream consumer that closes the pipe early — `myco … | head`, `| less`
// (quit before the end), a killed pager — makes stdout emit an async 'error'
// (EPIPE) that the promise chain below cannot catch: it would crash myco with a
// non-zero exit (255). A truncated pipe is normal use, not a failure — exit
// cleanly. Installed before any output so no write can race ahead of it.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`myco: ${terminalData((e as Error).message)}\n`);
    process.exitCode = 2;
  });
