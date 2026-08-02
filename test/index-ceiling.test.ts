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

import { MAX_INDEX_TERM_EDGES } from "../src/graph/index-contract.ts";
import { SearchGraph } from "../src/graph/model.ts";
import {
  clampTermEdgeCeiling,
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

test("a caller cannot RAISE the term-edge ceiling, only tighten it", () => {
  assert.equal(clampTermEdgeCeiling(undefined), MAX_INDEX_TERM_EDGES);
  assert.equal(clampTermEdgeCeiling(10), 10);
  // The whole point: an attempt to lift the contract limit is clamped back down,
  // so no writer can put a file on disk that the reader is obliged to reject.
  assert.equal(clampTermEdgeCeiling(MAX_INDEX_TERM_EDGES * 10), MAX_INDEX_TERM_EDGES);
  assert.equal(clampTermEdgeCeiling(-1), MAX_INDEX_TERM_EDGES);
  assert.equal(clampTermEdgeCeiling(1.5), MAX_INDEX_TERM_EDGES);
});

test("saveGraph DECLINES to write an index the reader would refuse, and writes no file", async () => {
  const root = await tempRoot();
  const graph = graphWithEdges(12);

  const outcome = await saveGraph(root, graph, { maxTermEdges: 5 });
  assert.equal(outcome.written, false);
  if (outcome.written) throw new Error("unreachable — narrowing for types");
  assert.equal(outcome.reason, "term-edge-ceiling");
  assert.equal(outcome.edges, 12);
  assert.equal(outcome.limit, 5);

  // No poisoned artifact left behind: the refusal must not create a file that a
  // later run would read, reject, and rewrite.
  const onDisk = await fs
    .stat(path.join(root, INDEX_DIR, INDEX_FILE))
    .catch(() => undefined);
  assert.equal(onDisk, undefined, "a declined save must leave no index file");
});

test("CONTROL: the same save succeeds when the graph is within the ceiling", async () => {
  // Without this row the test above would pass even if saveGraph were broken
  // into never writing anything — it must exercise the axis that distinguishes
  // refusal from failure.
  const root = await tempRoot();
  const outcome = await saveGraph(root, graphWithEdges(3), { maxTermEdges: 5 });
  assert.equal(outcome.written, true);

  const onDisk = await fs.stat(path.join(root, INDEX_DIR, INDEX_FILE));
  assert.ok(onDisk.isFile(), "a permitted save must write the index");
});

test("loadGraphOutcome tells ABSENT apart from REJECTED", async () => {
  const root = await tempRoot();

  // Nothing written yet — a genuine first run.
  assert.equal((await loadGraphOutcome(root)).status, "absent");

  // A file that exists but is not a valid index is a refusal, NOT an absence.
  await fs.mkdir(path.join(root, INDEX_DIR), { recursive: true });
  await fs.writeFile(path.join(root, INDEX_DIR, INDEX_FILE), "{ not json", "utf8");
  assert.equal((await loadGraphOutcome(root)).status, "rejected");

  // An index over a collection budget is likewise refused, not absent — this is
  // the exact shape of the 40 MB GitHub-root index that triggered the defect.
  const overLimit = {
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
  await fs.writeFile(
    path.join(root, INDEX_DIR, INDEX_FILE),
    JSON.stringify(overLimit),
    "utf8",
  );
  const refused = await loadGraphOutcome(root, { maxIndexBytes: 8 });
  assert.equal(refused.status, "rejected", "an over-size index is refused, not absent");
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

test("buildIndex REFUSES a tree past the ceiling instead of building what cannot be saved", async () => {
  const root = await tempRoot();
  // Two files whose combined distinct terms exceed the tightened ceiling.
  await fs.writeFile(path.join(root, "a.txt"), "alpha bravo charlie delta", "utf8");
  await fs.writeFile(path.join(root, "b.txt"), "echo foxtrot golf hotel", "utf8");

  await assert.rejects(
    () => buildIndex(root, { ...DEFAULT_INDEX_OPTIONS, maxTermEdges: 3 }),
    (err: Error) => {
      assert.match(err.message, /MYCO-INDEX-TOO-LARGE/);
      // The message must name the remedy, not just the failure.
      assert.match(err.message, /narrower root/);
      return true;
    },
  );
});

test("CONTROL: the same tree indexes cleanly under a ceiling that fits", async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, "a.txt"), "alpha bravo charlie delta", "utf8");
  await fs.writeFile(path.join(root, "b.txt"), "echo foxtrot golf hotel", "utf8");

  const built = await buildIndex(root, { ...DEFAULT_INDEX_OPTIONS, maxTermEdges: 100 });
  assert.equal(built.stats.files, 2);
  assert.equal(built.saved.written, true);
});
