import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildIndex, search, isError } from "../src/index.ts";
import type { Match, SearchOptions } from "../src/index.ts";

const FIXTURES: Record<string, string> = {
  "a.txt": "the cat sat\nconcatenate the category\n",
  "b.md": "Cat and dog\nCATALOG\n",
  "sub/c.js": "function graph() {}\nconst searchGraph = 1\n",
  // extension-query fixtures: ordinary stems (word char before the dot — the
  // shape word boundaries could never match), a decoy DIRECTORY named like the
  // extension, and a decoy suffix that only a sloppy substring would take.
  "gate/cold-boot.fungi": "flow x\n",
  "gate/power.fungi": "flow y\n",
  "fungi/notes.txt": "about\n",
  "gate/notes.fungi.bak": "z\n",
  // call-site fixtures: the shape that whole-word matching silently discarded.
  // Every REAL call site passes a variable, so `assembleWAT(w…` is the case that
  // must match; the string-literal and empty-arg forms survived even when broken,
  // which is exactly why the defect looked like a small under-count instead of a
  // total one. `reassembleWAT(` is the decoy the LEFT edge must still reject.
  "call/a.ts": 'const r = assembleWAT(cleanWat);\nconst s = assembleWAT("(module)");\n',
  "call/b.ts": "await assembleWAT(wat);\nassembleWAT();\n",
  "call/decoy.ts": "reassembleWAT(wat);\n",
};

async function fixtureTree(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myco-search-"));
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

async function run(
  dir: string,
  query: string,
  opts: Partial<SearchOptions>,
): Promise<Match[]> {
  const { graph } = await buildIndex(dir, {
    maxFileSize: 1 << 20,
    useGitignore: false,
  });
  const outcome = await search(dir, graph, query, {
    mode: "word",
    caseSensitive: "smart",
    files: false,
    limit: 1000,
    context: 0,
    ...opts,
  });
  assert.ok(!isError(outcome), "search should not error");
  return isError(outcome) ? [] : outcome.matches;
}

test("word search matches whole words only (the precision claim)", async () => {
  const dir = await fixtureTree();
  try {
    const word = await run(dir, "cat", { mode: "word" });
    // "cat" and "Cat" — NOT concatenate / category / CATALOG
    assert.equal(word.length, 2);
    const sub = await run(dir, "cat", { mode: "substring" });
    // adds concatenate, category, CATALOG
    assert.equal(sub.length, 5);
    assert.ok(sub.length > word.length, "substring is a superset of word");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Returns the whole result, not just matches — the excluded-count is a summary field.
async function runFull(
  dir: string,
  query: string,
  opts: Partial<SearchOptions>,
): Promise<import("../src/index.ts").SearchResult> {
  const { graph } = await buildIndex(dir, {
    maxFileSize: 1 << 20,
    useGitignore: false,
  });
  const outcome = await search(dir, graph, query, {
    mode: "word",
    caseSensitive: "smart",
    files: false,
    limit: 1000,
    context: 0,
    ...opts,
  });
  assert.ok(!isError(outcome), "search should not error");
  if (isError(outcome)) throw new Error("unreachable");
  return outcome;
}

test("★ call-site search: a pattern ending in punctuation matches sites passing a VARIABLE", async () => {
  const dir = await fixtureTree();
  try {
    // The field defect: the trailing word-boundary test was applied even though the
    // pattern already ends in '(' — so it landed on the char AFTER the paren and
    // rejected every call site passing a variable. `foo("x")` and `foo()` survived,
    // which made a total failure look like a small under-count.
    const hits = await run(dir, "assembleWAT(", { mode: "word" });
    const paths = [...new Set(hits.map((m) => m.path))].sort();
    assert.deepEqual(paths, ["call/a.ts", "call/b.ts"]);
    // a.ts: assembleWAT(cleanWat) + assembleWAT("(module)")  b.ts: (wat) + ()
    assert.equal(hits.length, 4);
    // the variable-passing form is the one that used to vanish
    assert.ok(
      hits.some((m) => m.text.includes("assembleWAT(cleanWat)")),
      "the variable call site must be found",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("★ the LEFT edge still filters: `assembleWAT(` must not match `reassembleWAT(`", async () => {
  const dir = await fixtureTree();
  try {
    const hits = await run(dir, "assembleWAT(", { mode: "word" });
    assert.ok(
      !hits.some((m) => m.path.includes("decoy")),
      "whole-word protection on the leading edge must survive the fix",
    );
    // and the substring mode, which never filtered, still sees it
    const sub = await run(dir, "assembleWAT(", { mode: "substring" });
    assert.ok(sub.some((m) => m.path.includes("decoy")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("★ a boundary-narrowed result reports what it discarded (never reads as absence)", async () => {
  const dir = await fixtureTree();
  try {
    // "all" occurs verbatim inside "call/…" but never as a whole word. Zero hits is
    // CORRECT here — the defect would be reporting zero without saying that files
    // containing the pattern were thrown away.
    const res = await runFull(dir, "all", { files: true, mode: "word" });
    assert.equal(res.matches.length, 0);
    assert.ok(
      res.wordBoundaryExcluded >= 3,
      `expected the discarded candidates to be counted, got ${res.wordBoundaryExcluded}`,
    );
    // a genuinely absent pattern must NOT claim exclusions
    const absent = await runFull(dir, "zzznotpresent", { files: true, mode: "word" });
    assert.equal(absent.matches.length, 0);
    assert.equal(absent.wordBoundaryExcluded, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("smart-case: a capital in the query forces case-sensitivity", async () => {
  const dir = await fixtureTree();
  try {
    const cap = await run(dir, "Cat", { mode: "word" });
    assert.equal(cap.length, 1);
    assert.ok(cap[0]?.path.endsWith("b.md"));
    const lower = await run(dir, "cat", { mode: "word" });
    assert.equal(lower.length, 2); // lower-case -> case-insensitive
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("filename search finds paths, not contents", async () => {
  const dir = await fixtureTree();
  try {
    const hits = await run(dir, "c", { files: true, mode: "word" });
    assert.equal(hits.length, 1);
    assert.ok(hits[0]?.path.endsWith("sub/c.js"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("regex search scans all files and matches a pattern", async () => {
  const dir = await fixtureTree();
  try {
    const hits = await run(dir, "gr\\w+ph", { mode: "regex" });
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((m) => m.path.endsWith("c.js")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a query with no matches returns nothing", async () => {
  const dir = await fixtureTree();
  try {
    const hits = await run(dir, "zzznotpresent", { mode: "word" });
    assert.equal(hits.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("filename search: a leading-dot query is an extension match (the .fungi fix)", async () => {
  const dir = await fixtureTree();
  try {
    // The field defect: '-f .fungi' in word mode matched ~0 ordinary stems,
    // because the word-boundary lookbehind at the dot demands a non-word char
    // and a stem's last char is a word char. Leading-dot => endsWith semantics.
    const hits = await run(dir, ".fungi", { files: true, mode: "word" });
    const paths = hits.map((m) => m.path).sort();
    assert.deepEqual(paths, ["gate/cold-boot.fungi", "gate/power.fungi"]);
    // decoys excluded: a DIRECTORY named 'fungi' and a '.fungi.bak' suffix.
    assert.ok(!paths.some((p) => p.startsWith("fungi/")));
    assert.ok(!paths.some((p) => p.endsWith(".bak")));
    // multi-dot suffixes work the same way (endsWith, not token match)
    const bak = await run(dir, ".fungi.bak", { files: true, mode: "word" });
    assert.equal(bak.length, 1);
    assert.ok(bak[0]?.path.endsWith("notes.fungi.bak"));
    // smart-case still applies: a capital forces sensitivity => no hits
    const caps = await run(dir, ".FUNGI", { files: true, mode: "word" });
    assert.equal(caps.length, 0);
    // content search is untouched by the special case
    const content = await run(dir, ".fungi", { files: false, mode: "word" });
    assert.equal(content.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
