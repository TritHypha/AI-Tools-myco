// content-drift.test.ts - MYCO-HARD-1c: `myco check` compares the recorded per-file
// sha256 with the content that is there now (index.content-digest), refuses unsafe
// manifest paths, and `myco check --deep` catches length+mtime-preserving edits and
// rewritten digests. Synthetic temp repos only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { checkContentDrift, FILE_MANIFEST, isSafeManifestPath, readFileManifest } from "../src/review/file-manifest.ts";
import type { FileManifest } from "../src/review/file-manifest.ts";
import { contentDigestVerdict, mergeRules, reviewRepo } from "../src/review/check.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const hasGit = spawnSync("git", ["--version"]).status === 0;
const T0 = 1_700_000_000; // fixed whole-second mtime so recorded mtimeMs is exact

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function myco(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}
async function repo(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "myco-drift-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const r = path.join(parent, "driftrepo");
  await fs.mkdir(r);
  g(r, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(r, ".gitignore"), ".myco/\n");
  await fs.writeFile(path.join(r, "a.txt"), "alpha driftneedle\n");
  await fs.mkdir(path.join(r, "sub"));
  await fs.writeFile(path.join(r, "sub", "b.txt"), "beta driftneedle\n");
  for (const f of [".gitignore", "a.txt", "sub/b.txt"]) await fs.utimes(path.join(r, f), T0, T0);
  g(r, "add", "-A"); g(r, "commit", "-q", "-m", "base");
  return r;
}
const mpath = (r: string): string => path.join(r, ".myco", FILE_MANIFEST);
async function manifestOf(r: string): Promise<FileManifest> {
  const m = await readFileManifest(r);
  assert.ok(typeof m === "object", `manifest not readable: ${String(m)}`);
  return m;
}
async function editManifest(r: string, fn: (m: Record<string, any>) => void): Promise<void> {
  const m = JSON.parse(await fs.readFile(mpath(r), "utf8"));
  fn(m);
  await fs.writeFile(mpath(r), JSON.stringify(m));
}
async function digestCheck(r: string, deep = false, rules = mergeRules(undefined, "defaults")) {
  const res = await reviewRepo(r, { write: false, deep, rules });
  const c = res.checks.find((x) => x.id === "index.content-digest");
  assert.ok(c, `no index.content-digest check: ${res.checks.map((x) => x.id).join(",")}`);
  return { c, res };
}

test("isSafeManifestPath: plain relative paths only", () => {
  for (const ok of ["a.txt", "sub/b.txt", "a b/(c).md", "x..y", ".hidden/f", "a:b"]) assert.equal(isSafeManifestPath(ok), true, ok);
  for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "a/", "..\\x", "a\\..\\..\\x", "\\\\host\\share", "C:/x", "c:", "C:\\x", "a\u0000b", "x".repeat(4097)]) {
    assert.equal(isSafeManifestPath(bad), false, JSON.stringify(bad));
  }
});

test("a manifest listing an escaping path is malformed (UNUSABLE), never re-hashed", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await editManifest(r, (m) => { m.files[0].path = "../outside.txt"; });
  assert.equal(await readFileManifest(r), "invalid");
  const res = myco(r, "search", "--json", "--no-refresh", "--no-branches", "driftneedle", r);
  assert.equal(res.code, 2);
  assert.match(res.err, /is malformed/);
  // A hand-built manifest that bypasses the reader is refused by the checker too.
  const m = await manifestOf(await (async () => { assert.equal(myco(r, "index", r).code, 0); return r; })());
  const forged = { ...m, files: [{ ...m.files[0]!, path: "../../etc/hosts" }] };
  const d = await checkContentDrift(r, forged);
  assert.match(String(d.error), /not a safe repo-relative path/);
  assert.equal(d.checked, 0);
  assert.equal(contentDigestVerdict(d, mergeRules(undefined, "defaults"))[0], "FAIL");
});

test("fresh index: content digests PASS in quick and deep mode", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  const q = await digestCheck(r);
  assert.equal(q.c.status, "PASS", q.c.reason);
  assert.match(q.c.reason, /0 file\(s\) re-hashed \(quick\), no content drift/);
  const d = await digestCheck(r, true);
  assert.equal(d.c.status, "PASS", d.c.reason);
  assert.match(d.c.reason, /3 file\(s\) re-hashed \(deep\), no content drift/);
});

test("edited and deleted files after the refresh: stale index WARN with paths", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.writeFile(path.join(r, "a.txt"), "alpha edited after the refresh\n");
  await fs.rm(path.join(r, "sub", "b.txt"));
  const { c, res } = await digestCheck(r);
  assert.equal(c.status, "WARN", c.reason);
  assert.match(c.reason, /index is stale: 1 file\(s\) changed and 1 gone/);
  assert.ok(c.details.includes("changed: a.txt"));
  assert.ok(c.details.includes("deleted: sub/b.txt"));
  assert.notEqual(res.status, "PASS");
  // the manifest/graph agreement itself is untouched by content drift
  assert.equal(res.checks.find((x) => x.id === "index.file-manifest")?.status, "PASS");
});

test("contentDrift threshold is configurable: failAbove 0 turns stale into FAIL", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.writeFile(path.join(r, "a.txt"), "changed\n");
  const rules = mergeRules({ contentDrift: { failAbove: 0 } }, "test");
  const { c } = await digestCheck(r, false, rules);
  assert.equal(c.status, "FAIL");
  assert.throws(() => mergeRules({ silentEdit: "LOUD" }, "test"), /silentEdit must be/);
  assert.throws(() => mergeRules({ contentDrift: { failAbov: 1 } }, "test"), /not a threshold key/);
});

test("touched with the same content is not drift", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.utimes(path.join(r, "a.txt"), T0 + 3600, T0 + 3600);
  const { c } = await digestCheck(r);
  assert.equal(c.status, "PASS", c.reason);
  assert.match(c.reason, /1 file\(s\) re-hashed \(quick\), no content drift; 1 touched with the same content/);
});

test("an edit that keeps length and mtime is invisible to quick mode and FAILs --deep", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.writeFile(path.join(r, "a.txt"), "ALPHA driftneedle\n"); // same byte length
  await fs.utimes(path.join(r, "a.txt"), T0, T0);
  const q = await digestCheck(r);
  assert.equal(q.c.status, "PASS", "quick mode trusts unchanged metadata by design");
  const d = await digestCheck(r, true);
  assert.equal(d.c.status, "FAIL", d.c.reason);
  assert.match(d.c.reason, /byte length \+ mtime stayed the same/);
  assert.deepEqual(d.c.details, ["silent: a.txt"]);
  const soft = await digestCheck(r, true, mergeRules({ silentEdit: "WARN" }, "test"));
  assert.equal(soft.c.status, "WARN");
});

test("a rewritten digest in the manifest FAILs --deep", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await editManifest(r, (m) => { m.files.find((f: any) => f.path === "sub/b.txt").sha256 = "0".repeat(64); });
  assert.equal((await digestCheck(r)).c.status, "PASS");
  const d = await digestCheck(r, true);
  assert.equal(d.c.status, "FAIL");
  assert.deepEqual(d.c.details, ["silent: sub/b.txt"]);
});

test("a file replaced by a directory or symlink counts as gone, and is never followed", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.rm(path.join(r, "a.txt"));
  await fs.mkdir(path.join(r, "a.txt"));
  let linked = true;
  try {
    await fs.rm(path.join(r, "sub", "b.txt"));
    await fs.writeFile(path.join(r, "target.txt"), "beta driftneedle\n");
    await fs.symlink(path.join(r, "target.txt"), path.join(r, "sub", "b.txt"));
  } catch { linked = false; }
  const { c } = await digestCheck(r, true);
  assert.equal(c.status, "WARN", c.reason);
  assert.ok(c.details.includes("deleted: a.txt"));
  if (linked) assert.ok(c.details.includes("deleted: sub/b.txt"), c.details.join("|"));
});

test("pinned index: quick is fixed by the commit; --deep re-verifies blobs and FAILs a rewritten digest", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", "--at", "HEAD", r).code, 0);
  await fs.writeFile(path.join(r, "a.txt"), "working-tree scratch is not the pinned content\n");
  const q = await digestCheck(r);
  assert.equal(q.c.status, "PASS", q.c.reason);
  assert.match(q.c.reason, /pinned index: content is fixed by the commit/);
  const d = await digestCheck(r, true);
  assert.equal(d.c.status, "PASS", d.c.reason);
  assert.match(d.c.reason, /3 file\(s\) re-hashed \(pinned-deep\)/);
  await editManifest(r, (m) => { m.files.find((f: any) => f.path === "a.txt").sha256 = "f".repeat(64); });
  const bad = await digestCheck(r, true);
  assert.equal(bad.c.status, "FAIL");
  assert.match(bad.c.reason, /disagree with the pinned commit/);
});

test("checkContentDrift: pinned commit that cannot be listed is an error, not a pass", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "myco-drift-nogit-"));
  try {
    const m: FileManifest = {
      kind: "myco-file-manifest", version: 1, createdAt: 1,
      source: { repo: "x", commit: "1".repeat(40), pinned: true },
      fileCount: 1, files: [{ path: "a", bytes: 1, mtimeMs: 1, sha256: "0".repeat(64) }],
    };
    const d = await checkContentDrift(parent, m, { deep: true });
    assert.match(String(d.error), /cannot be listed/);
    assert.equal(contentDigestVerdict(d, mergeRules(undefined, "defaults"))[0], "FAIL");
    const unhashed = await checkContentDrift(parent, { ...m, source: { ...m.source, pinned: false, commit: null }, files: [{ path: "a", bytes: 1, mtimeMs: 1, sha256: null }] });
    assert.deepEqual(unhashed.deleted, ["a"]);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test("CLI: myco check --deep exits 2 on a silent edit; plain check does not re-hash unchanged files", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.writeFile(path.join(r, "sub", "b.txt"), "BETA driftneedle\n");
  await fs.utimes(path.join(r, "sub", "b.txt"), T0, T0);
  const plain = myco(r, "check", "--json", "--out", path.join(r, ".myco", "rv1"), r);
  const pj = JSON.parse(plain.out);
  assert.equal(pj.checks.find((c: any) => c.id === "index.content-digest").status, "PASS");
  const deep = myco(r, "check", "--deep", "--json", "--out", path.join(r, ".myco", "rv2"), r);
  assert.equal(deep.code, 2, deep.out);
  const dj = JSON.parse(deep.out);
  assert.equal(dj.checks.find((c: any) => c.id === "index.content-digest").status, "FAIL");
});
