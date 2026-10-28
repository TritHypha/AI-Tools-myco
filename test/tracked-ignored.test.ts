// tracked-ignored.test.ts - MYCO-FULL-1 (2026-10-28): index everything, miss nothing.
// Pins four behaviours:
//   F1  no default size cap: a file well over the old 5 MiB default is content-indexed.
//   F2  git-tracked files that .gitignore matches are indexed AND reported; untracked
//       ignored files (and untracked files under an ignored dir) stay out.
//   F3  .mycoignore still wins over tracking; --no-tracked-ignored and a non-git root
//       keep the old behaviour; --no-gitignore needs no tracked report.
//   F4  CLI defaults: --limit 1000, the help names --no-tracked-ignored and "no cap".
// Synthetic fixtures only, in an OS temp folder that is always removed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { walk, gitTrackedPaths } from "../src/ingest/walk.ts";
import { buildIndex, DEFAULT_INDEX_OPTIONS, UNLIMITED_FILE_SIZE } from "../src/ingest/indexer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const MIB = 1024 * 1024;
const hasGit = spawnSync("git", ["--version"]).status === 0;

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "myco-full1-"));
}

function git(root: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
}

async function write(root: string, rel: string, body: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}

// A repo where .gitignore matches tracked and untracked files alike.
async function fixture(): Promise<string> {
  const r = await scratch();
  git(r, "init", "-q");
  await write(r, ".gitignore", "*.log\nbuild/\n/generated.txt\n");
  await write(r, "src/main.txt", "alpha main\n");
  await write(r, "keep.log", "tracked log zebrafish\n");          // tracked, matches *.log
  await write(r, "noise.log", "untracked log\n");                 // untracked, matches *.log
  await write(r, "build/out/pinned.txt", "pinned quokka\n");      // tracked, under ignored dir
  await write(r, "build/out/temp.txt", "temp artefact\n");        // untracked, under ignored dir
  await write(r, "build/other/x.txt", "untracked other\n");       // untracked dir, ignored
  await write(r, "generated.txt", "anchored tracked\n");          // tracked, anchored rule
  git(r, "add", "-f", ".gitignore", "src/main.txt", "keep.log", "build/out/pinned.txt", "generated.txt");
  return r;
}

const walkOpts = { maxFileSize: UNLIMITED_FILE_SIZE, useGitignore: true };

test("F1 default index options carry no size cap", () => {
  assert.equal(DEFAULT_INDEX_OPTIONS.maxFileSize, UNLIMITED_FILE_SIZE);
  assert.equal(DEFAULT_INDEX_OPTIONS.includeTrackedIgnored, true);
  assert.ok(UNLIMITED_FILE_SIZE >= Number.MAX_SAFE_INTEGER);
});

test("F1 a 6 MiB text file is content-indexed under the defaults (old cap was 5 MiB)", async () => {
  const r = await scratch();
  try {
    const line = "wombat ".repeat(15) + "\n";
    await write(r, "big.txt", line.repeat(Math.ceil((6 * MIB) / line.length)));
    const b = await buildIndex(r, DEFAULT_INDEX_OPTIONS);
    const rec = b.graph.fileByPath("big.txt");
    assert.ok(rec, "big.txt must be in the index");
    assert.equal(rec.contentSkip, undefined);
    assert.equal(rec.unknown, undefined);
    assert.ok(rec.size > 5 * MIB);
    assert.deepEqual(b.skippedLargePaths, []);
    assert.equal(b.stats.skippedLarge, 0);
    assert.deepEqual(b.unreadablePaths, []);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F1 an explicit --max-size still caps and still reports", async () => {
  const r = await scratch();
  try {
    await write(r, "big.txt", Buffer.alloc(2 * MIB, 0x61));
    const b = await buildIndex(r, { ...DEFAULT_INDEX_OPTIONS, maxFileSize: MIB });
    assert.deepEqual(b.skippedLargePaths, ["big.txt"]);
    assert.equal(b.graph.fileByPath("big.txt")?.contentSkip, "large");
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F2 gitTrackedPaths lists index entries relative to root, undefined outside git", { skip: !hasGit }, async () => {
  const r = await fixture();
  const plain = await scratch();
  try {
    const t = gitTrackedPaths(r);
    assert.ok(t);
    assert.deepEqual([...t].sort(), [".gitignore", "build/out/pinned.txt", "generated.txt", "keep.log", "src/main.txt"]);
    assert.equal(gitTrackedPaths(plain), undefined);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
    await fs.rm(plain, { recursive: true, force: true });
  }
});

test("F2 tracked-but-ignored files are walked and reported; untracked ignored stay out", { skip: !hasGit }, async () => {
  const r = await fixture();
  try {
    const reported: string[] = [];
    const metas = await walk(r, walkOpts, [], [], reported);
    const paths = metas.map((m) => m.relPath).sort();
    assert.deepEqual(paths, [".gitignore", "build/out/pinned.txt", "generated.txt", "keep.log", "src/main.txt"]);
    assert.deepEqual(reported.sort(), ["build/out/pinned.txt", "generated.txt", "keep.log"]);
    assert.ok(!paths.includes("noise.log"));
    assert.ok(!paths.includes("build/out/temp.txt"));
    assert.ok(!paths.includes("build/other/x.txt"));
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F2 buildIndex content-indexes tracked-ignored files and counts them", { skip: !hasGit }, async () => {
  const r = await fixture();
  try {
    const b = await buildIndex(r, DEFAULT_INDEX_OPTIONS);
    assert.equal(b.stats.trackedIgnored, 3);
    assert.deepEqual([...b.trackedIgnoredPaths].sort(), ["build/out/pinned.txt", "generated.txt", "keep.log"]);
    for (const p of b.trackedIgnoredPaths) {
      const rec = b.graph.fileByPath(p);
      assert.ok(rec, `${p} indexed`);
      assert.equal(rec.contentSkip, undefined);
    }
    assert.equal(b.graph.fileByPath("noise.log"), undefined);
    // Untracking the file drops it again on the next incremental run.
    git(r, "rm", "-q", "--cached", "keep.log");
    const b2 = await buildIndex(r, DEFAULT_INDEX_OPTIONS);
    assert.equal(b2.graph.fileByPath("keep.log"), undefined);
    assert.equal(b2.stats.trackedIgnored, 2);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F3 .mycoignore wins over git tracking", { skip: !hasGit }, async () => {
  const r = await fixture();
  try {
    await write(r, ".mycoignore", "keep.log\nbuild/\n");
    const reported: string[] = [];
    const metas = await walk(r, walkOpts, [], [], reported);
    const paths = metas.map((m) => m.relPath);
    assert.ok(!paths.includes("keep.log"));
    assert.ok(!paths.includes("build/out/pinned.txt"));
    assert.deepEqual(reported, ["generated.txt"]);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F3 includeTrackedIgnored:false restores the ignore-only walk", { skip: !hasGit }, async () => {
  const r = await fixture();
  try {
    const reported: string[] = [];
    const metas = await walk(r, { ...walkOpts, includeTrackedIgnored: false }, [], [], reported);
    assert.deepEqual(metas.map((m) => m.relPath).sort(), [".gitignore", "src/main.txt"]);
    assert.deepEqual(reported, []);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F3 a non-git root keeps the old behaviour (ignored files out, nothing reported)", async () => {
  const r = await scratch();
  try {
    await write(r, ".gitignore", "*.log\n");
    await write(r, "a.txt", "a\n");
    await write(r, "b.log", "b\n");
    const reported: string[] = [];
    const metas = await walk(r, walkOpts, [], [], reported);
    assert.deepEqual(metas.map((m) => m.relPath).sort(), [".gitignore", "a.txt"]);
    assert.deepEqual(reported, []);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F3 --no-gitignore includes everything and reports no tracked-ignored files", { skip: !hasGit }, async () => {
  const r = await fixture();
  try {
    const reported: string[] = [];
    const metas = await walk(r, { ...walkOpts, useGitignore: false }, [], [], reported);
    const paths = metas.map((m) => m.relPath);
    for (const p of ["noise.log", "build/out/temp.txt", "build/other/x.txt", "keep.log"]) {
      assert.ok(paths.includes(p), `${p} walked`);
    }
    assert.deepEqual(reported, []);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F3 an unreadable file is reported, never silently dropped", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("needs POSIX permissions and a non-root user");
    return;
  }
  const r = await scratch();
  try {
    await write(r, "ok.txt", "fine\n");
    await write(r, "locked.txt", "secretless synthetic\n");
    await fs.chmod(path.join(r, "locked.txt"), 0o000);
    const b = await buildIndex(r, DEFAULT_INDEX_OPTIONS);
    assert.deepEqual(b.unreadablePaths, ["locked.txt"]);
    assert.equal(b.stats.unreadable, 1);
  } finally {
    await fs.chmod(path.join(r, "locked.txt"), 0o644).catch(() => {});
    await fs.rm(r, { recursive: true, force: true });
  }
});

test("F4 CLI help shows the new defaults", () => {
  const res = spawnSync(process.execPath, ["--experimental-strip-types", path.join(repoRoot, "src", "cli.ts"), "--help"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /--limit N\s+max results \(default 1000\)/);
  assert.match(res.stdout, /--max-size N\s+.*default: no cap/);
  assert.match(res.stdout, /--no-tracked-ignored/);
});

test("F4 myco index lists tracked-ignored files on stdout", { skip: !hasGit }, async () => {
  const r = await fixture();
  try {
    const res = spawnSync(process.execPath, ["--experimental-strip-types", path.join(repoRoot, "src", "cli.ts"), "index", r], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /3 git-tracked file\(s\) matched \.gitignore and were indexed anyway/);
    assert.match(res.stdout, /^\s+keep\.log$/m);
    const off = spawnSync(process.execPath, ["--experimental-strip-types", path.join(repoRoot, "src", "cli.ts"), "index", "--no-tracked-ignored", r], {
      encoding: "utf8",
    });
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stdout, /git-tracked file\(s\) matched/);
  } finally {
    await fs.rm(r, { recursive: true, force: true });
  }
});
