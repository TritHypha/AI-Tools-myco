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

import { buildIndex, DEFAULT_INDEX_OPTIONS } from "./ingest/indexer.ts";
import type { IndexOptions } from "./ingest/indexer.ts";
import { loadGraph } from "./graph/store.ts";
import { buildPathFilter } from "./query/path-filter.ts";
import { search, searchFile, isError, detectRegexIntent } from "./query/search.ts";
import type { MatchMode, SearchOptions, SearchOutcome } from "./query/search.ts";
import { render, summaryLine } from "./output.ts";
import { VERSION } from "./index.ts";

const HELP = `myco ${VERSION} — grep, but it grows a graph.

USAGE
  myco <pattern> [path]        search file contents (smart-case, whole-word)
  myco search <pattern> [path] explicit search (when pattern is a command name)
  myco index [path]            build/refresh the graph index
  myco status [path]           show index statistics

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
  -n, --limit N     max results (default 200)
      --json        machine-readable JSON
      --no-color    disable ANSI color

INDEXING
      --no-refresh    search the existing index without refreshing first
      --no-gitignore  do not honour .gitignore
      --max-size N    skip files larger than N megabytes (default 5)
      --vendored      descend into vendored deps (node_modules; skipped + reported by default)

Exit codes: 0 = matches, 1 = no matches, 2 = error.`;

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
  const limit = Number.parseInt(String(values["limit"] ?? "200"), 10);
  const maxMb = Number.parseFloat(String(values["max-size"] ?? ""));

  return {
    search: {
      mode,
      caseSensitive,
      files: Boolean(values["files"]),
      limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
      context: Number.isFinite(context) && context > 0 ? context : 0,
    },
    index: {
      maxFileSize: Number.isFinite(maxMb) && maxMb > 0
        ? Math.floor(maxMb * 1024 * 1024)
        : DEFAULT_INDEX_OPTIONS.maxFileSize,
      useGitignore: !values["no-gitignore"],
      includeVendored: Boolean(values["vendored"]),
    },
  };
}

function useColor(values: Record<string, unknown>): boolean {
  if (values["no-color"] || values["json"]) return false;
  if (process.env["NO_COLOR"]) return false;
  return Boolean(process.stdout.isTTY);
}

async function cmdIndex(root: string, index: IndexOptions): Promise<number> {
  // Same fail-closed guard as cmdSearch: `myco index <nonexistent>` must not
  // mkdir `<root>/.myco` at a path that doesn't exist. Create nothing, exit 2.
  if (!(await fs.stat(root).catch(() => undefined))) {
    process.stderr.write(`myco: path not found: ${root}\n`);
    return 2;
  }
  const started = process.hrtime.bigint();
  const { stats, skippedLargePaths, skippedVendoredDirs } = await buildIndex(root, index);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Informational output → stdout. stderr is reserved for real errors (which all
  // exit non-zero), so a consumer can treat any stderr output — or a non-zero exit —
  // as a genuine failure, and this benign stat line can never be mistaken for one.
  process.stdout.write(
    `indexed ${stats.files} files ` +
      `(+${stats.added} ~${stats.updated} -${stats.removed}, ` +
      `${stats.unchanged} unchanged, ${stats.skippedBinary} binary skipped, ` +
      `${stats.skippedLarge} over-size skipped) ` +
      `in ${ms.toFixed(0)}ms\n`,
  );
  // No silent caps: name the files that fell outside the index, so a search that
  // returns nothing is never mistaken for "not present" (DESIGN §8/§10).
  if (skippedLargePaths.length > 0) {
    const mib = (index.maxFileSize / (1024 * 1024)).toFixed(0);
    process.stdout.write(
      `  ${skippedLargePaths.length} file(s) exceed --max-size (${mib} MiB) — NOT searchable:\n`,
    );
    for (const p of skippedLargePaths) process.stdout.write(`    ${p}\n`);
  }
  // Same no-silent-caps rule for vendored trees: name the pruned dirs and the
  // escape hatch, so a miss inside node_modules can never read as absence.
  if (skippedVendoredDirs.length > 0) {
    process.stdout.write(
      `  ${skippedVendoredDirs.length} vendored dir(s) skipped (NOT searchable; pass --vendored to include):\n`,
    );
    for (const p of skippedVendoredDirs) process.stdout.write(`    ${p}\n`);
  }
  return 0;
}

async function cmdStatus(root: string): Promise<number> {
  const loaded = await loadGraph(root);
  if (!loaded) {
    process.stderr.write(`no index at ${path.join(root, ".myco")} — run: myco index\n`);
    return 2;
  }
  let bytes = 0;
  try {
    bytes = (await fs.stat(path.join(root, ".myco", "index.json"))).size;
  } catch {
    /* ignore */
  }
  const when = new Date(loaded.meta.createdAt).toISOString();
  process.stdout.write(
    `files:  ${loaded.meta.fileCount}\n` +
      `terms:  ${loaded.meta.termCount}\n` +
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

  // --in is a coverage cap. If it cannot be honoured exactly as written, STOP —
  // never fall back to searching everything. A filter that silently widens is the
  // worst outcome available here: the user believes they scoped, the tool returns
  // tree-wide hits, and the extra results look like evidence rather than noise.
  const inPatterns = values["in"] as string[] | undefined;
  if (inPatterns !== undefined) {
    const built = buildPathFilter(inPatterns);
    if (typeof built === "string") {
      process.stderr.write(`myco: ${built}\n`);
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
    process.stderr.write(`myco: path not found: ${root}\n`);
    return 2;
  }
  let outcome: SearchOutcome;
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
      if ((await loadGraph(root)) === null) {
        // Informational note → stdout (stderr is errors only).
        process.stdout.write(`myco: indexing ${path.resolve(root)} (first run)…\n`);
      }
      const built = await buildIndex(root, iOpts);
      graph = built.graph;
      // Surface an over-size skip even on the search path — otherwise an oversized file
      // silently misses and a zero-result reads as "absent" (the recurring "we keep
      // missing things" failure). Informational → stdout: a skip is not a failure.
      if (!values["json"] && built.skippedLargePaths.length > 0) {
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
  }
  if (isError(outcome)) {
    process.stderr.write(`myco: ${outcome.error}\n`);
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
    outcome.regexLinesTruncated > 0
  ) return 2;
  return outcome.matches.length > 0 ? 0 : 1;
}

async function run(argv: string[]): Promise<number> {
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
      in: { type: "string", multiple: true },
      vendored: { type: "boolean" },
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

  switch (first) {
    case "index":
      return cmdIndex(path.resolve(rest[0] ?? "."), iOpts);
    case "status":
      return cmdStatus(path.resolve(rest[0] ?? "."));
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
    process.stderr.write(`myco: ${(e as Error).message}\n`);
    process.exitCode = 2;
  });
