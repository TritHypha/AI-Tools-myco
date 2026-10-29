// pinned-index.test.ts - MYCO-HARD-1 item 1 (2026-10-28): `index --at REV` builds the
// index from ONE commit's tree in git objects (never the working folder) and never
// follows symlinks, in pinned mode or in the normal walk. Synthetic repos only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLsTreeLong, pinnedListing, resolvePinnedCommit, PinnedIndexError } from "../src/ingest/pinned.ts";
import { buildIndex, DEFAULT_INDEX_OPTIONS } from "../src/ingest/indexer.ts";
import { walk } from "../src/ingest/walk.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function repo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myco-hard1-pin-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "synthetic@example.invalid");
  git(dir, "config", "user.name", "Synthetic");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "core.symlinks", "true");
  return dir;
}

function myco(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], { encoding: "utf8" });
}

async function trySymlink(target: string, at: string): Promise<boolean> {
  try {
    await fs.symlink(target, at);
    return true;
  } catch {
    return false; // e.g. Windows without symlink privilege - the test skips, never passes vacuously
  }
}

test("PIN-01 parseLsTreeLong sorts modes and keeps odd names verbatim", () => {
  const blob = "a".repeat(40);
  const raw = [
    `100644 blob ${blob}      12\tsrc/a b.txt`,
    `100755 blob ${blob}       3\t-leading dash.sh`,
    `120000 blob ${blob}      10\tlink-to-etc`,
    `160000 commit ${blob}       -\tvendor/sub`,
    `100644 blob ${blob}       5\tline\nbreak.txt`,
    `100644 blob ${blob}       5\tüñï\tcode.md`,
    "",
  ].join("\0");
  const r = parseLsTreeLong(raw);
  assert.deepEqual(r.entries.map((e) => e.relPath), ["src/a b.txt", "-leading dash.sh", "line\nbreak.txt", "üñï\tcode.md"]);
  assert.equal(r.entries[0].size, 12);
  assert.equal(r.entries[1].mode, "100755");
  assert.deepEqual(r.symlinks, ["link-to-etc"]);
  assert.deepEqual(r.submodules, ["vendor/sub"]);
  assert.deepEqual(r.other, []);
});

test("PIN-02 parseLsTreeLong fails closed on malformed records", () => {
  const blob = "b".repeat(40);
  assert.throws(() => parseLsTreeLong(`100644 blob ${blob} 12 no-tab-here\0`), PinnedIndexError);
  assert.throws(() => parseLsTreeLong(`100644 blob ${blob}\tmissing-size\0`), PinnedIndexError);
  assert.throws(() => parseLsTreeLong(`100644 blob ${blob} 12\t\0`), PinnedIndexError);
  assert.throws(() => parseLsTreeLong(`100644 blob ${blob} -1\tneg\0`), PinnedIndexError);
  assert.throws(() => parseLsTreeLong(`100644 blob ${blob} 1.5\tfrac\0`), PinnedIndexError);
  // An unknown mode is reported, not indexed and not dropped.
  assert.deepEqual(parseLsTreeLong(`040000 tree ${blob} -\todd\0`).other, ["odd"]);
});

test("PIN-03 --at indexes the commit, not the dirty working folder", async (t) => {
  const dir = await repo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "a.txt"), "committed narwhal\n");
  await fs.writeFile(path.join(dir, "name with space.txt"), "spaced okapi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c1");
  const c1 = git(dir, "rev-parse", "HEAD");
  // Dirty the working folder in every way: edit, delete, untracked add.
  await fs.writeFile(path.join(dir, "a.txt"), "working axolotl\n");
  await fs.rm(path.join(dir, "name with space.txt"));
  await fs.writeFile(path.join(dir, "untracked.txt"), "untracked pangolin\n");

  const r = await buildIndex(dir, { ...DEFAULT_INDEX_OPTIONS, atCommit: "HEAD" });
  assert.equal(r.stats.pinnedCommit, c1);
  assert.deepEqual([...r.graph.files()].map((f) => f.path).sort(), ["a.txt", "name with space.txt"]);
  assert.ok(r.graph.filesWithTerm("narwhal"), "commit content indexed");
  assert.ok(r.graph.filesWithTerm("okapi"), "file deleted from working folder still indexed from commit");
  assert.equal(r.graph.filesWithTerm("axolotl"), undefined, "working edit NOT indexed");
  assert.equal(r.graph.filesWithTerm("pangolin"), undefined, "untracked file NOT indexed");

  // Re-pinning to a later commit replaces content (no stale reuse: mtime is 0 in pinned mode).
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c2");
  const r2 = await buildIndex(dir, { ...DEFAULT_INDEX_OPTIONS, atCommit: "HEAD" });
  assert.ok(r2.graph.filesWithTerm("axolotl"));
  assert.equal(r2.graph.filesWithTerm("narwhal"), undefined);
  assert.equal(r2.graph.fileByPath("name with space.txt"), undefined, "removed in c2 -> removed from index");
  assert.ok(r2.graph.fileByPath("untracked.txt"));
  // Pinning back to c1 by full SHA works too.
  const r3 = await buildIndex(dir, { ...DEFAULT_INDEX_OPTIONS, atCommit: c1 });
  assert.ok(r3.graph.filesWithTerm("narwhal"));
  assert.equal(r3.graph.filesWithTerm("axolotl"), undefined);
});

test("PIN-04 a committed symlink is reported and never followed", async (t) => {
  const dir = await repo();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "myco-hard1-outside-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, "secret.txt"), "outside wolverine\n");
  await fs.writeFile(path.join(dir, "real.txt"), "inside lemur\n");
  if (!(await trySymlink(path.join(outside, "secret.txt"), path.join(dir, "ln.txt")))) {
    t.skip("symlinks unavailable on this host");
    return;
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "with symlink");
  const listing = pinnedListing(dir, "HEAD");
  assert.deepEqual(listing.symlinks, ["ln.txt"]);
  const r = await buildIndex(dir, { ...DEFAULT_INDEX_OPTIONS, atCommit: "HEAD" });
  assert.deepEqual(r.skippedSymlinkPaths, ["ln.txt"]);
  assert.equal(r.graph.fileByPath("ln.txt"), undefined);
  assert.equal(r.graph.filesWithTerm("wolverine"), undefined, "target content never read");
  assert.ok(r.graph.filesWithTerm("lemur"));
});

test("PIN-05 the working-folder walk never follows symlinks either", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myco-hard1-walk-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "myco-hard1-outside-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, "f.txt"), "outside badger\n");
  await fs.mkdir(path.join(outside, "d"));
  await fs.writeFile(path.join(outside, "d", "g.txt"), "outside heron\n");
  await fs.writeFile(path.join(dir, "keep.txt"), "inside tapir\n");
  const a = await trySymlink(path.join(outside, "f.txt"), path.join(dir, "file-link"));
  const b = await trySymlink(path.join(outside, "d"), path.join(dir, "dir-link"));
  if (!a || !b) {
    t.skip("symlinks unavailable on this host");
    return;
  }
  const skipped: string[] = [];
  const metas = await walk(dir, { maxFileSize: 1 << 20, useGitignore: false }, [], [], [], skipped);
  assert.deepEqual(metas.map((m) => m.relPath), ["keep.txt"]);
  assert.deepEqual(skipped.sort(), ["dir-link", "file-link"]);
  const r = await buildIndex(dir, { ...DEFAULT_INDEX_OPTIONS, useGitignore: false });
  assert.equal(r.graph.filesWithTerm("badger"), undefined);
  assert.equal(r.graph.filesWithTerm("heron"), undefined);
  assert.deepEqual(r.skippedSymlinkPaths.sort(), ["dir-link", "file-link"]);
});

test("PIN-06 bad, option-like and non-commit revisions fail closed before writing", async (t) => {
  const dir = await repo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "a.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c1");
  const blob = git(dir, "rev-parse", "HEAD:a.txt");
  for (const rev of ["no-such-branch", "", "-h", "--output=/tmp/x", blob, "HEAD~5"]) {
    assert.throws(() => resolvePinnedCommit(dir, rev), PinnedIndexError, `rev ${JSON.stringify(rev)}`);
  }
  assert.throws(() => resolvePinnedCommit(dir, "-h"), /option-like/, "refused before git ever sees it");
  await assert.rejects(buildIndex(dir, { ...DEFAULT_INDEX_OPTIONS, atCommit: "no-such-branch" }), PinnedIndexError);
  await assert.rejects(fs.stat(path.join(dir, ".myco")), "nothing written on a refused pin");
});

test("PIN-07 a subdirectory root is refused (paths would mis-map)", async (t) => {
  const dir = await repo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "sub"));
  await fs.writeFile(path.join(dir, "sub", "a.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c1");
  assert.throws(() => pinnedListing(path.join(dir, "sub"), "HEAD"), /repository top/);
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "myco-hard1-norepo-"));
  t.after(() => fs.rm(plain, { recursive: true, force: true }));
  assert.throws(() => pinnedListing(plain, "HEAD"), PinnedIndexError);
});

test("PIN-08 CLI: index --at reports the pin; misuse exits 2", async (t) => {
  const dir = await repo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "a.txt"), "cli quetzal\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c1");
  const sha = git(dir, "rev-parse", "HEAD");
  const ok = myco("index", dir, "--at", "main");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`pinned commit ${sha}`));
  const bad = myco("index", dir, "--at", "nope");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /does not resolve to a commit/);
  const wrongCmd = myco("quetzal", dir, "--at", "main", "--no-branches");
  assert.equal(wrongCmd.status, 2);
  assert.match(wrongCmd.stderr, /--at is only valid with `myco index`/);
  const mixed = myco("index", dir, "--at", "main", "--worktree", dir);
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /cannot be combined/);
});

test("PIN-09 re-pinning to a same-size, different-content commit re-reads the blob", async (t) => {
  const dir = await repo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "a.txt"), "alpha kiwi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c1");
  const c1 = git(dir, "rev-parse", "HEAD");
  await fs.writeFile(path.join(dir, "a.txt"), "bravo kiwi\n"); // same byte size
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "c2");
  await buildIndex(dir, { ...DEFAULT_INDEX_OPTIONS, atCommit: c1 });
  const r = await buildIndex(dir, { ...DEFAULT_INDEX_OPTIONS, atCommit: "HEAD" });
  assert.ok(r.graph.filesWithTerm("bravo"), "new content indexed");
  assert.equal(r.graph.filesWithTerm("alpha"), undefined, "no stale reuse by size in pinned mode");
});
