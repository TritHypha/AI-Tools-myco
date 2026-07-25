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

test("walk honours NESTED .gitignore, scoped to its own subtree (the dss-host /target class)", async () => {
  const dir = await tmpTree({
    // a subproject with its OWN .gitignore ignoring its build output
    "sub/.gitignore": "/target\n*.tmp\n",
    "sub/keep.rs": "keep",
    "sub/target/debug/artifact.bin": "drop", // ignored by sub/.gitignore `/target`
    "sub/scratch.tmp": "drop", // ignored by sub/.gitignore `*.tmp`
    // a SIBLING with the same-named dir but NO gitignore — must NOT be affected (scoping)
    "other/target/keep.bin": "keep",
    "other/notes.tmp": "keep",
    "root.txt": "keep",
  });
  try {
    const metas = await walk(dir, { maxFileSize: 1 << 20, useGitignore: true });
    const rels = new Set(metas.map((m) => m.relPath));
    // nested .gitignore is honoured within its subtree
    assert.ok(rels.has("sub/keep.rs"), "a non-ignored file in the subproject is kept");
    assert.ok(
      !rels.has("sub/target/debug/artifact.bin"),
      "sub/.gitignore `/target` prunes the build tree (the 28k-file timeout fix)",
    );
    assert.ok(!rels.has("sub/scratch.tmp"), "sub/.gitignore `*.tmp` is honoured");
    // scoping: the nested rule must NOT leak to a sibling subtree
    assert.ok(
      rels.has("other/target/keep.bin"),
      "a sibling 'target' with no .gitignore is NOT ignored by sub's rule",
    );
    assert.ok(rels.has("other/notes.tmp"), "a sibling '*.tmp' is NOT ignored by sub's rule");
    assert.ok(rels.has("root.txt"));
    // non-vacuity control: with gitignore OFF, the "ignored" files ARE walked — so the
    // exclusions above are a real effect of reading the nested file, not an empty tree.
    const relsNoGi = new Set(
      (await walk(dir, { maxFileSize: 1 << 20, useGitignore: false })).map((m) => m.relPath),
    );
    assert.ok(
      relsNoGi.has("sub/target/debug/artifact.bin"),
      "control: with useGitignore:false the build artifact IS walked (non-vacuous)",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("walk honours a leading `**/` ignore rule as match-at-any-depth", async () => {
  const dir = await tmpTree({
    "keep.txt": "keep",
    "pkg/src/main.ts": "keep",
    "pkg/build/.fungi-cache/x.egraph.json": "drop", // nested build cache
    "deep/a/b/build/.fungi-cache/y.egraph.json": "drop", // deeper still
    ".gitignore": "**/.fungi-cache/\n",
  });
  try {
    const rels = new Set(
      (await walk(dir, { maxFileSize: 1 << 20, useGitignore: true })).map((m) => m.relPath),
    );
    assert.ok(rels.has("keep.txt") && rels.has("pkg/src/main.ts"), "real source is kept");
    assert.ok(
      !rels.has("pkg/build/.fungi-cache/x.egraph.json"),
      "`**/.fungi-cache/` prunes a nested build cache (previously indexed — git honoured it, myco did not)",
    );
    assert.ok(
      !rels.has("deep/a/b/build/.fungi-cache/y.egraph.json"),
      "`**/` matches at ANY depth, not just one segment",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("walk skips files over the size cap AND reports them (no silent drop)", async () => {
  const dir = await tmpTree({ "small.txt": "x", "big.txt": "y".repeat(1000) });
  try {
    const skippedLarge: string[] = [];
    const metas = await walk(dir, { maxFileSize: 100, useGitignore: false }, skippedLarge);
    const rels = new Set(metas.map((m) => m.relPath));
    assert.ok(rels.has("small.txt"));
    assert.ok(!rels.has("big.txt"), "big.txt exceeds the cap");
    // The cap must be VISIBLE, not silent — the over-size file is named in the out-list
    // so a caller (index/search) can tell the user what fell outside the index.
    assert.deepEqual(skippedLarge, ["big.txt"], "over-size file is reported, never silently dropped");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("walk leaves the skip-list empty when nothing exceeds the cap", async () => {
  const dir = await tmpTree({ "a.txt": "x", "b.txt": "yy" });
  try {
    const skippedLarge: string[] = [];
    await walk(dir, { maxFileSize: 1 << 20, useGitignore: false }, skippedLarge);
    assert.deepEqual(skippedLarge, [], "no false positives when every file fits");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("walk skips node_modules by default, REPORTS the skip, and --vendored includes it", async () => {
  const dir = await tmpTree({
    "app.ts": "keep",
    "node_modules/dep/index.js": "vendored",
    "node_modules/dep2/lib/x.js": "vendored",
    "sub/node_modules/dep3/y.js": "vendored nested",
    "sub/own.ts": "keep",
  });
  try {
    // Default: vendored trees pruned, each pruned dir REPORTED (no silent caps).
    const skippedVendored: string[] = [];
    const metas = await walk(
      dir,
      { maxFileSize: 1 << 20, useGitignore: false },
      undefined,
      skippedVendored,
    );
    const rels = new Set(metas.map((m) => m.relPath));
    assert.ok(rels.has("app.ts"));
    assert.ok(rels.has("sub/own.ts"));
    assert.ok(!rels.has("node_modules/dep/index.js"), "root node_modules pruned by default");
    assert.ok(!rels.has("sub/node_modules/dep3/y.js"), "nested node_modules pruned too");
    assert.deepEqual(
      skippedVendored.sort(),
      ["node_modules", "sub/node_modules"],
      "every pruned vendored dir is reported — the skip is visible, not silent",
    );

    // Escape hatch: includeVendored restores full coverage and reports nothing.
    const none: string[] = [];
    const all = await walk(
      dir,
      { maxFileSize: 1 << 20, useGitignore: false, includeVendored: true },
      undefined,
      none,
    );
    const allRels = new Set(all.map((m) => m.relPath));
    assert.ok(allRels.has("node_modules/dep/index.js"), "--vendored includes the tree");
    assert.ok(allRels.has("sub/node_modules/dep3/y.js"));
    assert.deepEqual(none, [], "nothing reported skipped when vendored dirs are included");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
