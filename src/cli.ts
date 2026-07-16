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
import { search, isError } from "./query/search.ts";
import type { MatchMode, SearchOptions } from "./query/search.ts";
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

OUTPUT
  -C, --context N   show N lines of context (content search)
  -n, --limit N     max results (default 200)
      --json        machine-readable JSON
      --no-color    disable ANSI color

INDEXING
      --no-refresh    search the existing index without refreshing first
      --no-gitignore  do not honour .gitignore
      --max-size N    skip files larger than N megabytes (default 5)

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
    },
  };
}

function useColor(values: Record<string, unknown>): boolean {
  if (values["no-color"] || values["json"]) return false;
  if (process.env["NO_COLOR"]) return false;
  return Boolean(process.stdout.isTTY);
}

async function cmdIndex(root: string, index: IndexOptions): Promise<number> {
  const started = process.hrtime.bigint();
  const { stats, skippedLargePaths } = await buildIndex(root, index);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  process.stderr.write(
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
    process.stderr.write(
      `  ${skippedLargePaths.length} file(s) exceed --max-size (${mib} MiB) — NOT searchable:\n`,
    );
    for (const p of skippedLargePaths) process.stderr.write(`    ${p}\n`);
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
      process.stderr.write(`myco: indexing ${path.resolve(root)} (first run)…\n`);
    }
    const built = await buildIndex(root, iOpts);
    graph = built.graph;
    // Surface an over-size skip even on the search path — otherwise an oversized file
    // silently misses and a zero-result search reads as "absent" (the recurring
    // "we keep missing things" failure). stderr only, so JSON/piped stdout stays clean.
    if (!values["json"] && built.skippedLargePaths.length > 0) {
      process.stderr.write(
        `myco: note — ${built.skippedLargePaths.length} file(s) over --max-size ` +
          `not searched (run \`myco index\` to list them)\n`,
      );
    }
  }

  const outcome = await search(root, graph, pattern, sOpts);
  if (isError(outcome)) {
    process.stderr.write(`myco: ${outcome.error}\n`);
    return 2;
  }

  const body = render(outcome, sOpts.files, {
    color: useColor(values),
    json: Boolean(values["json"]),
  });
  if (body) process.stdout.write(body + "\n");
  if (!values["json"]) process.stderr.write(summaryLine(outcome) + "\n");

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

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`myco: ${(e as Error).message}\n`);
    process.exitCode = 2;
  });
