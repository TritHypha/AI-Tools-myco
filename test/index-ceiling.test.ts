// index-ceiling.test.ts — the writer must refuse what the reader refuses, and a
// refusal must never be reported as an absence.
//
// Regression cover for the defect found on 2026-08-02: `810058c` introduced a
// reader-side term-edge ceiling with no writer-side counterpart, so an index
// written before that commit (or by any larger tree) was rejected on load,
// re-created identically, and rejected again — a cache that could never hit,
// reported to the user as "(first run)" every single time.

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  MAX_INDEX_TERM_LENGTH,
  validateStoredIndex,
} from "../src/graph/index-contract.ts";
import { SearchGraph } from "../src/graph/model.ts";
import {
  INDEX_DIR,
  INDEX_FILE,
  loadGraphOutcome,
  saveGraph,
} from "../src/graph/store.ts";
import { buildIndex, DEFAULT_INDEX_OPTIONS } from "../src/ingest/indexer.ts";

async function tempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "myco-ceiling-"));
}

function graphWithEdges(edgeCount: number): SearchGraph {
  const graph = new SearchGraph();
  const counts = new Map<string, number>();
  for (let i = 0; i < edgeCount; i += 1) counts.set(`term${i}`, 1);
  graph.setFile("a.txt", 1, 1, counts);
  return graph;
}

test("termEdgeCount tracks forward edges across add, replace and remove", () => {
  const graph = new SearchGraph();
  assert.equal(graph.termEdgeCount(), 0);

  graph.setFile("a.txt", 1, 1, new Map([["x", 1], ["y", 2]]));
  assert.equal(graph.termEdgeCount(), 2);

  graph.setFile("b.txt", 1, 1, new Map([["z", 1]]));
  assert.equal(graph.termEdgeCount(), 3);

  // Replacing a file must not double-count: setFile removes the old node first.
  graph.setFile("a.txt", 2, 2, new Map([["x", 1]]));
  assert.equal(graph.termEdgeCount(), 2);

  graph.removeFile("b.txt");
  assert.equal(graph.termEdgeCount(), 1);

  graph.removeFile("a.txt");
  assert.equal(graph.termEdgeCount(), 0);
});

test("stored-index validation has no fixed aggregate file or term-edge ceiling", () => {
  const files = Array.from({ length: 250_001 }, (_unused, index) => ({
    p: `file-${index}.txt`,
    m: 1,
    s: 0,
    t: [],
  }));
  const manyFiles = validateStoredIndex({ format: 1, createdAt: 1, files });
  assert.equal(manyFiles?.files.length, 250_001);

  const terms = Array.from({ length: 100_000 }, (_unused, index) => [`term-${index}`, 1] as [string, number]);
  const manyEdges = validateStoredIndex({
    format: 1,
    createdAt: 1,
    files: Array.from({ length: 21 }, (_unused, index) => ({
      p: `edge-${index}.txt`,
      m: 1,
      s: 0,
      t: terms,
    })),
  });
  assert.equal(manyEdges?.files.length, 21);
  assert.equal(manyEdges?.files.reduce((sum, file) => sum + file.t.length, 0), 2_100_000);
});

test("saveGraph persists and reloads more than the historical aggregate edge ceiling", async () => {
  const root = await tempRoot();
  const graph = new SearchGraph();
  const terms = new Map<string, number>();
  for (let index = 0; index < 100_000; index += 1) terms.set(`term-${index}`, 1);
  for (let index = 0; index < 21; index += 1) {
    graph.setFile(`edge-${index}.txt`, 1, 0, terms);
  }

  const saved = await saveGraph(root, graph);
  assert.deepEqual(saved, { written: true });
  const loaded = await loadGraphOutcome(root);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("unreachable — narrowing for types");
  assert.equal(loaded.meta.termCount, 100_000);
  assert.equal(loaded.graph.termEdgeCount(), 2_100_000);
});

test("loadGraphOutcome tells ABSENT apart from REJECTED", async () => {
  const root = await tempRoot();

  // Nothing written yet — a genuine first run.
  assert.equal((await loadGraphOutcome(root)).status, "absent");

  // A file that exists but is not a valid index is a refusal, NOT an absence.
  await fs.mkdir(path.join(root, INDEX_DIR), { recursive: true });
  await fs.writeFile(path.join(root, INDEX_DIR, INDEX_FILE), "{ not json", "utf8");
  assert.equal((await loadGraphOutcome(root)).status, "rejected");

  // A structurally invalid index is refused, not absent.
  const invalidIndex = {
    format: 1,
    createdAt: 1,
    files: [
      {
        p: "a.txt",
        m: 1,
        s: 1,
        t: Array.from({ length: 4 }, (_v, i) => [`t${i}`, 1]),
      },
    ],
  };
  invalidIndex.files[0].t[0][1] = 0;
  await fs.writeFile(
    path.join(root, INDEX_DIR, INDEX_FILE),
    JSON.stringify(invalidIndex),
    "utf8",
  );
  invalidIndex.files[0].t[0][1] = 0;
  const refused = await loadGraphOutcome(root);
  assert.equal(refused.status, "rejected", "a malformed index is refused, not absent");
});

test("loadGraphOutcome reads a valid index beyond the historical 64 MiB ceiling", async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, INDEX_DIR), { recursive: true });
  const payload = JSON.stringify({
    format: 1,
    createdAt: 1,
    files: [{ p: "a.txt", m: 1, s: 1, t: [] }],
  });
  const paddingBytes = 64 * 1024 * 1024 + 1;
  await fs.writeFile(path.join(root, INDEX_DIR, INDEX_FILE), `${" ".repeat(paddingBytes)}${payload}`, "utf8");

  const loaded = await loadGraphOutcome(root);
  assert.equal(loaded.status, "ok");
});

test("loadGraphOutcome treats a non-ENOENT filesystem failure as REJECTED", async () => {
  // An embedded NUL is rejected by the filesystem API before lookup. It is a
  // deterministic cross-platform stand-in for permission and I/O failures:
  // only ENOENT may mean that an index is genuinely absent.
  const outcome = await loadGraphOutcome(`invalid\0root`);
  assert.equal(outcome.status, "rejected");
});

test("CONTROL: a well-formed index loads as ok", async () => {
  const root = await tempRoot();
  await saveGraph(root, graphWithEdges(3));
  const outcome = await loadGraphOutcome(root);
  assert.equal(outcome.status, "ok");
});

test("buildIndex accepts a tree beyond a caller's former aggregate ceiling", async () => {
  const root = await tempRoot();
  // Two files whose combined distinct terms exceed the tightened ceiling.
  await fs.writeFile(path.join(root, "a.txt"), "alpha bravo charlie delta", "utf8");
  await fs.writeFile(path.join(root, "b.txt"), "echo foxtrot golf hotel", "utf8");

  const built = await buildIndex(root, DEFAULT_INDEX_OPTIONS);
  assert.equal(built.stats.files, 2);
  assert.equal(built.graph.termEdgeCount(), 8);
  assert.deepEqual(built.saved, { written: true });
});

test("CONTROL: a normal tree still indexes cleanly", async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, "a.txt"), "alpha bravo charlie delta", "utf8");
  await fs.writeFile(path.join(root, "b.txt"), "echo foxtrot golf hotel", "utf8");

  const built = await buildIndex(root, DEFAULT_INDEX_OPTIONS);
  assert.equal(built.stats.files, 2);
  assert.equal(built.saved.written, true);
});

test("buildIndex persists a searchable marker when overlong terms are omitted", async () => {
  const root = await tempRoot();
  const overlong = "x".repeat(MAX_INDEX_TERM_LENGTH + 1);
  await fs.writeFile(path.join(root, "a.txt"), `keep ${overlong}`, "utf8");

  const built = await buildIndex(root, DEFAULT_INDEX_OPTIONS);

  assert.equal(built.saved.written, true);
  assert.equal(built.stats.omittedOverlongTerms, 1);
  assert.equal(built.stats.filesWithOmittedOverlongTerms, 1);
  assert.deepEqual(built.omittedOverlongTermPaths, ["a.txt"]);
  assert.equal(built.graph.filesWithTerm("keep")?.size, 1);
  assert.equal(built.graph.fileByPath("a.txt")?.omittedOverlongTerms, 1);

  const loaded = await loadGraphOutcome(root);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("unreachable — narrowing for types");
  assert.equal(loaded.graph.fileByPath("a.txt")?.omittedOverlongTerms, 1);
  assert.equal(loaded.meta.omittedOverlongTerms, 1);
  assert.equal(loaded.meta.filesWithOmittedOverlongTerms, 1);
});
