import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { walk } from "../src/ingest/walk.ts";

async function tmpTree(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myco-walk-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

test("walk honours .mycoignore basename globs and directory rules", async () => {
  const dir = await tmpTree({
    "a.txt": "keep",
    "b.log": "drop",
    "skip/c.txt": "drop",
    "keep/d.txt": "keep",
    ".mycoignore": "*.log\nskip/\n",
  });
  try {
    const metas = await walk(dir, { maxFileSize: 1 << 20, useGitignore: false });
    const rels = new Set(metas.map((m) => m.relPath));
    assert.ok(rels.has("a.txt"));
    assert.ok(rels.has("keep/d.txt"));
    assert.ok(!rels.has("b.log"), "*.log should be ignored");
    assert.ok(!rels.has("skip/c.txt"), "skip/ directory should be pruned");
    // .mycoignore itself is a normal file and is walked (not special-cased).
    assert.ok(rels.has(".mycoignore"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("walk skips files over the size cap", async () => {
  const dir = await tmpTree({ "small.txt": "x", "big.txt": "y".repeat(1000) });
  try {
    const metas = await walk(dir, { maxFileSize: 100, useGitignore: false });
    const rels = new Set(metas.map((m) => m.relPath));
    assert.ok(rels.has("small.txt"));
    assert.ok(!rels.has("big.txt"), "big.txt exceeds the cap");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
