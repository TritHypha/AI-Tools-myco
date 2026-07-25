// path-filter.test.ts — `--in` scoping, and the reporting that makes it safe.
//
// A path filter is the only coverage cap myco has that the USER asks for, which makes
// it the easiest one to trust wrongly: a mistyped glob excludes the whole index and
// returns a confident zero that is byte-identical to a genuine absence. So the tests
// that matter here are not the glob-translation ones — they are the pair that keeps
// those two outcomes distinguishable:
//
//   "your query found nothing in a valid scope"   (normal, quiet)
//   "your scope contains nothing at all"          (broken query, must be loud)
//
// Every narrowing assertion is paired with a control that must NOT narrow, because a
// filter that excluded everything would otherwise pass most of these by accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildIndex } from "../src/ingest/indexer.ts";
import { search, isError } from "../src/query/search.ts";
import type { SearchOptions, SearchResult } from "../src/query/search.ts";
import { buildPathFilter, applyPathFilter } from "../src/query/path-filter.ts";
import { summaryLine } from "../src/output.ts";

/** Compile or fail the test — most cases below are about behaviour, not construction. */
function filter(...patterns: string[]) {
  const f = buildPathFilter(patterns);
  assert.ok(typeof f !== "string", `expected a filter, got error: ${String(f)}`);
  return f;
}

// ---------------------------------------------------------------- glob semantics

test("a metacharacter-free pattern is a SEGMENT-aware prefix, not a string prefix", () => {
  const f = filter("src");
  assert.equal(f.test("src/a.ts"), true, "everything under it is in scope");
  assert.equal(f.test("src"), true, "the path itself is in scope");
  // THE CONTROL. A raw string prefix would accept this, and it is a different
  // project — `packages-galerina` vs `packages-galerina-enterprise` is the live case.
  assert.equal(f.test("srcfoo/a.ts"), false, "a sibling sharing the prefix is OUT of scope");
  assert.equal(f.test("other/src/a.ts"), false, "the prefix is anchored at the root");
});

test("* stays inside one segment; ** crosses segments", () => {
  const star = filter("src/*.ts");
  assert.equal(star.test("src/a.ts"), true);
  assert.equal(star.test("src/deep/a.ts"), false, "CONTROL: * must not cross a separator");

  const dstar = filter("packages/**/src");
  assert.equal(dstar.test("packages/a/b/src/x.ts"), true, "many segments between");
  assert.equal(dstar.test("packages/src/x.ts"), true, "ZERO segments between — **/ must be optional");
  assert.equal(dstar.test("other/a/src/x.ts"), false, "CONTROL: still anchored at the root");
});

test("? matches exactly one non-separator character", () => {
  const f = filter("v?/a.ts");
  assert.equal(f.test("v1/a.ts"), true);
  assert.equal(f.test("v10/a.ts"), false, "CONTROL: ? is one char, not many");
  assert.equal(f.test("v/a.ts"), false, "CONTROL: ? is not optional");
});

test("shell-shaped inputs normalise: trailing slash, leading ./, Windows separators", () => {
  for (const p of ["src/", "./src", "src\\"]) {
    assert.equal(filter(p).test("src/a.ts"), true, `${p} should behave as "src"`);
  }
  // Indexed paths are POSIX (walk.ts:27), but a caller passing an OS path must not
  // silently match nothing — that is the exact failure this whole file guards.
  assert.equal(filter("src").test("src\\a.ts"), true, "an OS-separator path still tests true");
});

test("multiple patterns OR together", () => {
  const f = filter("src", "docs");
  assert.equal(f.test("src/a.ts"), true);
  assert.equal(f.test("docs/b.md"), true);
  assert.equal(f.test("test/c.ts"), false, "CONTROL: unlisted trees stay out");
});

test("an unusable filter is an ERROR, never a silently-absent filter", () => {
  // Fail-closed: the alternative is searching the whole tree while the user believes
  // they scoped, which turns unrelated hits into apparent evidence.
  assert.equal(typeof buildPathFilter([]), "string");
  assert.equal(typeof buildPathFilter(["   "]), "string");
});

test("applyPathFilter counts what it removed, and NO filter removes nothing", () => {
  const recs = [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "docs/c.md" }];
  const scoped = applyPathFilter(recs, filter("src"));
  assert.equal(scoped.kept.length, 2);
  assert.equal(scoped.excluded, 1, "the removal must be counted, not just performed");
  // CONTROL: the no-filter path must be identity. If this ever narrows, every
  // unscoped search in the tool is quietly lying.
  const none = applyPathFilter(recs, undefined);
  assert.equal(none.kept.length, 3);
  assert.equal(none.excluded, 0);
});

// ------------------------------------------------------------- reporting, live

const FIXTURES: Record<string, string> = {
  "src/a.ts": "const marker = 1\n",
  "src/b.ts": "const marker = 2\n",
  "docs/c.md": "marker in the docs\n",
  "test/d.ts": "nothing relevant here\n",
};

async function tree(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myco-pathfilter-"));
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

async function run(dir: string, query: string, patterns?: string[]): Promise<SearchResult> {
  const { graph } = await buildIndex(dir, { maxFileSize: 1 << 20, useGitignore: false });
  const opts: SearchOptions = {
    mode: "word", caseSensitive: "smart", files: false, limit: 200, context: 0,
    pathFilter: patterns ? filter(...patterns) : undefined,
  };
  const out = await search(dir, graph, query, opts);
  assert.ok(!isError(out), `search errored: ${JSON.stringify(out)}`);
  return out;
}

test("scoping narrows the result AND reports the count it removed", async () => {
  const dir = await tree();
  const wide = await run(dir, "marker");
  // Non-vacuity: without a filter the query must genuinely reach all three files,
  // or the narrowing below proves nothing.
  assert.equal(wide.filesMatched, 3, "control: unscoped search finds all three");
  assert.equal(wide.pathFilterExcluded, 0);
  assert.equal(wide.pathFilterMatchedNothing, false);

  const narrow = await run(dir, "marker", ["src"]);
  assert.equal(narrow.filesMatched, 2, "scoped to src/");
  assert.equal(narrow.pathFilterExcluded, 1, "the docs candidate was removed — and counted");
  assert.ok(summaryLine(narrow).includes("outside --in"), "the summary must say so");
});

test("★ a glob matching NO indexed path is called out — the zero must not read as absence", async () => {
  const dir = await tree();
  const typo = await run(dir, "marker", ["srcc"]); // one keystroke wrong
  assert.equal(typo.matches.length, 0);
  assert.equal(typo.pathFilterMatchedNothing, true, "an empty scope must announce itself");
  const line = summaryLine(typo);
  assert.ok(line.includes("--in matched NO indexed path"), `summary must warn, got: ${line}`);
});

test("★ CONTROL — a VALID scope that simply has no hits must stay QUIET", async () => {
  const dir = await tree();
  // `test/` exists and is indexed; the query legitimately is not in it. This is a
  // normal empty result and must NOT raise the broken-scope warning, or the warning
  // fires on every honest miss and stops meaning anything.
  const honest = await run(dir, "marker", ["test"]);
  assert.equal(honest.matches.length, 0, "no hits, as expected");
  assert.equal(honest.pathFilterMatchedNothing, false,
    "the scope is real — only the query missed");
  assert.ok(!summaryLine(honest).includes("--in matched NO indexed path"));
});

test("★ when the FILTER empties the candidate set, the INDEX is not blamed for it", async () => {
  const dir = await tree();
  const scoped = await run(dir, "marker", ["test"]);
  // prunedToZero means "no file contains all the query's words" and sends the reader
  // to fix their query. Here the query was fine and the scope excluded the hits, so
  // attributing it to the index would point at the wrong mechanism.
  assert.equal(scoped.prunedToZero, false, "the filter emptied it, not the prune");

  // CONTROL: a genuinely unprunable query still reports prunedToZero, so the flag
  // above is not just permanently off.
  const real = await run(dir, "wordthatappearsnowhere");
  assert.equal(real.prunedToZero, true, "control: the index really does prune to zero here");
});

test("filename search (-f) honours the scope and reports identically", async () => {
  const dir = await tree();
  const { graph } = await buildIndex(dir, { maxFileSize: 1 << 20, useGitignore: false });
  const base: SearchOptions = {
    mode: "substring", caseSensitive: "smart", files: true, limit: 200, context: 0,
  };
  const wide = await search(dir, graph, ".ts", base);
  const narrow = await search(dir, graph, ".ts", { ...base, pathFilter: filter("src") });
  assert.ok(!isError(wide) && !isError(narrow));
  assert.equal((wide as SearchResult).matches.length, 3, "control: a.ts, b.ts, d.ts unscoped");
  assert.equal((narrow as SearchResult).matches.length, 2, "scoped to src/");
  assert.ok((narrow as SearchResult).pathFilterExcluded > 0, "and it says what it dropped");
});
