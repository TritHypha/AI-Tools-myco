// oversize-marker-n1.test.ts — test-only follow-up to the INDEXED_UNKNOWN
// oversize marker (Grok check vmym N1). Guards three behaviours that the
// marker suite did not pin, each tied to a mutant that previously survived:
//   N1a (VM5)  the incremental fast path never reuses a marker recorded
//              under a different size cap; the new cap is re-recorded and
//              persisted.
//   N1b (VM7)  unknown[] honours the --in path scope (in scope: reported and
//              complete:false; out of scope: not reported, complete:true).
//   N1c (VM14) the plain-text CLI summary carries the INDEXED_UNKNOWN note
//              naming the file, and the process exits 2.
// Synthetic fixtures only, built in a scratch folder that is always removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGraph } from "../src/graph/store.ts";
import { buildIndex, DEFAULT_INDEX_OPTIONS } from "../src/ingest/indexer.ts";
import { search, isError } from "../src/query/search.ts";
import { buildPathFilter } from "../src/query/path-filter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const MIB = 1024 * 1024;
const opts = (max: number) => ({ ...DEFAULT_INDEX_OPTIONS, maxFileSize: max, hashOversize: false });
const sopts: any = { mode: "word", limit: 50, caseSensitive: undefined, files: false, context: 0 };

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(repoRoot, ".tmp-n1-"));
}

test("N1a fast path re-records the marker when the size cap changes (VM5)", async () => {
  const r = await scratch();
  try {
    await fs.writeFile(path.join(r, "big.bin"), Buffer.alloc(3 * MIB, 0x61));
    let b = await buildIndex(r, opts(MIB));
    assert.equal(b.graph.fileByPath("big.bin")?.unknown?.thresholdBytes, MIB);
    // Same file (size and mtime unchanged), cap raised but still under the size:
    // still oversize, so the marker must carry the NEW cap, not the stale one.
    b = await buildIndex(r, opts(2 * MIB));
    assert.equal(b.graph.fileByPath("big.bin")?.contentSkip, "large");
    assert.equal(b.graph.fileByPath("big.bin")?.unknown?.thresholdBytes, 2 * MIB);
    let l = await loadGraph(r);
    assert.equal(l?.graph.fileByPath("big.bin")?.unknown?.thresholdBytes, 2 * MIB);
    // Cap lowered again: re-recorded again.
    b = await buildIndex(r, opts(MIB));
    assert.equal(b.graph.fileByPath("big.bin")?.unknown?.thresholdBytes, MIB);
    l = await loadGraph(r);
    assert.equal(l?.graph.fileByPath("big.bin")?.unknown?.thresholdBytes, MIB);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("N1b unknown[] is scoped by --in (VM7)", async () => {
  const r = await scratch();
  try {
    await fs.mkdir(path.join(r, "a"));
    await fs.mkdir(path.join(r, "b"));
    await fs.writeFile(path.join(r, "a", "x.txt"), "needle\n");
    await fs.writeFile(path.join(r, "b", "big.txt"), Buffer.alloc(MIB + 1, 0x61));
    const b = await buildIndex(r, opts(MIB));
    const inA = buildPathFilter(["a/**"]);
    const inB = buildPathFilter(["b/**"]);
    assert.ok(typeof inA !== "string" && typeof inB !== "string");
    let res = await search(r, b.graph, "needle", { ...sopts, pathFilter: inA });
    assert.ok(!isError(res));
    assert.deepEqual(res.unknown, []);
    assert.equal(res.complete, true);
    res = await search(r, b.graph, "needle", { ...sopts, pathFilter: inB });
    assert.ok(!isError(res));
    assert.equal(res.unknown.length, 1);
    assert.equal(res.unknown[0].path, "b/big.txt");
    assert.equal(res.complete, false);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("N1c text output carries the INDEXED_UNKNOWN note and exits 2 (VM14)", async () => {
  const r = await scratch();
  try {
    await fs.writeFile(path.join(r, "small.txt"), "needle\n");
    await fs.writeFile(path.join(r, "big.txt"), Buffer.alloc(2 * MIB, 0x61));
    const cli = path.join(repoRoot, "src", "cli.ts");
    const p = spawnSync(process.execPath, ["--experimental-strip-types", cli, "needle", ".", "--max-size", "1"], { cwd: r, encoding: "utf8" });
    assert.equal(p.status, 2, p.stdout + p.stderr);
    assert.match(p.stdout, /INDEXED_UNKNOWN/);
    assert.match(p.stdout, /big\.txt/);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});