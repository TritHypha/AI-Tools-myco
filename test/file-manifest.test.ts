// file-manifest.test.ts - MYCO-HARD-1 items 3 + 4: per-file sha256 manifest written
// every refresh, UNUSABLE on drift / malformed manifest / failed probe, and
// repo@commit:path citations in search JSON. Synthetic temp repos only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { citeOf, compareManifest, FILE_MANIFEST, readFileManifest } from "../src/review/file-manifest.ts";
import type { FileManifest } from "../src/review/file-manifest.ts";
import { reviewRepo } from "../src/review/check.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const hasGit = spawnSync("git", ["--version"]).status === 0;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

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
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "myco-fman-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const r = path.join(parent, "synthrepo");
  await fs.mkdir(r);
  g(r, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(r, ".gitignore"), ".myco/\n");
  await fs.writeFile(path.join(r, "a.txt"), "alpha manifestneedle\n");
  await fs.mkdir(path.join(r, "sub"));
  await fs.writeFile(path.join(r, "sub", "b.txt"), "beta\nsecond manifestneedle line\n");
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

test("citeOf builds repo@commit:path[:line] and WORKTREE when no commit", () => {
  const c = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(citeOf({ repo: "r", commit: c, pinned: false }, "src/x.ts", 7), "r@0123456789ab:src/x.ts:7");
  assert.equal(citeOf({ repo: "r", commit: c, pinned: false }, "x", 0), "r@0123456789ab:x");
  assert.equal(citeOf({ repo: "r", commit: null, pinned: false }, "x", 2), "r@WORKTREE:x:2");
});

test("compareManifest: agreement ok; count drift, missing, extra and duplicates are UNUSABLE", () => {
  const base: FileManifest = {
    kind: "myco-file-manifest", version: 1, createdAt: 1, source: { repo: "r", commit: null, pinned: false },
    fileCount: 2, files: [{ path: "a", bytes: 1, mtimeMs: 1, sha256: null }, { path: "b", bytes: 1, mtimeMs: 1, sha256: null }],
  };
  assert.deepEqual(compareManifest(base, ["b", "a"]), { state: "ok", reasons: [] });
  const drift = compareManifest(base, ["a"]);
  assert.equal(drift.state, "unusable");
  assert.ok(drift.reasons.some((x) => /file count drift: index has 1 file\(s\), manifest records 2/.test(x)));
  assert.ok(drift.reasons.some((x) => /missing from the index: b/.test(x)));
  const extra = compareManifest(base, ["a", "b", "c"]);
  assert.ok(extra.reasons.some((x) => /not in the manifest: c/.test(x)));
  const lying = compareManifest({ ...base, fileCount: 3 }, ["a", "b"]);
  assert.ok(lying.reasons.some((x) => /fileCount 3 != 2 listed/.test(x)));
  const dup = compareManifest({ ...base, files: [base.files[0]!, base.files[0]!] }, ["a", "b"]);
  assert.equal(dup.state, "unusable");
  assert.ok(dup.reasons.some((x) => /twice/.test(x)));
});

test("myco index writes a per-file sha256 manifest citing repo@HEAD", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  const res = myco(r, "index", r);
  assert.equal(res.code, 0, res.err);
  const m = await manifestOf(r);
  assert.equal(m.fileCount, m.files.length);
  assert.deepEqual(m.files.map((f) => f.path), [".gitignore", "a.txt", "sub/b.txt"]);
  assert.equal(m.files.find((f) => f.path === "a.txt")!.sha256, sha("alpha manifestneedle\n"));
  assert.equal(m.files.find((f) => f.path === "sub/b.txt")!.bytes, Buffer.byteLength("beta\nsecond manifestneedle line\n"));
  assert.deepEqual(m.source, { repo: "synthrepo", commit: g(r, "rev-parse", "HEAD"), pinned: false });
});

test("refresh rewrites the manifest: new file listed, changed file re-hashed", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.writeFile(path.join(r, "c.txt"), "gamma\n");
  await fs.writeFile(path.join(r, "a.txt"), "alpha changed manifestneedle\n");
  assert.equal(myco(r, "index", r).code, 0);
  const m = await manifestOf(r);
  assert.equal(m.fileCount, 4);
  assert.equal(m.files.find((f) => f.path === "c.txt")!.sha256, sha("gamma\n"));
  assert.equal(m.files.find((f) => f.path === "a.txt")!.sha256, sha("alpha changed manifestneedle\n"));
});

test("--at manifest hashes the pinned blobs, not the working folder", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  const head = g(r, "rev-parse", "HEAD");
  await fs.writeFile(path.join(r, "a.txt"), "uncommitted scratch\n");
  const res = myco(r, "index", "--at", "HEAD", r);
  assert.equal(res.code, 0, res.err);
  const m = await manifestOf(r);
  assert.deepEqual(m.source, { repo: "synthrepo", commit: head, pinned: true });
  assert.equal(m.files.find((f) => f.path === "a.txt")!.sha256, sha("alpha manifestneedle\n"));
});

test("search --json cites repo@commit:path:line and keeps the existing fields", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  const res = myco(r, "search", "--json", "--no-branches", "--limit", "1000", "manifestneedle", r);
  assert.equal(res.code, 0, res.err);
  const j = JSON.parse(res.out);
  const head12 = g(r, "rev-parse", "HEAD").slice(0, 12);
  const cites = j.matches.map((m: any) => m.citation).sort();
  assert.deepEqual(cites, [`synthrepo@${head12}:a.txt:1`, `synthrepo@${head12}:sub/b.txt:2`]);
  for (const m of j.matches) for (const k of ["path", "line", "col", "length", "text"]) assert.ok(k in m, k);
  assert.equal(j.complete, true);
  assert.equal(j.indexManifest.state, "ok");
  assert.equal(j.source.repo, "synthrepo");
  assert.ok("summary" in j && "unknown" in j);
});

test("search --no-refresh on a drifted manifest is UNUSABLE: incomplete, exit 2, stderr reason", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await editManifest(r, (m) => { m.files = m.files.filter((f: any) => f.path !== "sub/b.txt"); m.fileCount = m.files.length; });
  const res = myco(r, "search", "--json", "--no-refresh", "--no-branches", "manifestneedle", r);
  assert.equal(res.code, 2);
  assert.match(res.err, /index UNUSABLE - .*file count drift/);
  const j = JSON.parse(res.out);
  assert.equal(j.complete, false);
  assert.equal(j.indexManifest.state, "unusable");
  assert.ok(j.matches.length > 0, "matches are kept as evidence");
});

test("a malformed manifest is UNUSABLE (fail closed), and a refresh repairs it", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.writeFile(mpath(r), "{not json");
  const bad = myco(r, "search", "--json", "--no-refresh", "--no-branches", "manifestneedle", r);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /is malformed/);
  const fixed = myco(r, "search", "--json", "--no-branches", "manifestneedle", r);
  assert.equal(fixed.code, 0, fixed.err);
  assert.equal(JSON.parse(fixed.out).indexManifest.state, "ok");
});

test("an index without a manifest (pre-upgrade) still searches; no citation is invented", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.rm(mpath(r));
  const res = myco(r, "search", "--json", "--no-refresh", "--no-branches", "manifestneedle", r);
  assert.equal(res.code, 0, res.err);
  const j = JSON.parse(res.out);
  assert.equal(j.indexManifest.state, "absent");
  assert.equal(j.source, null);
  assert.ok(j.matches.every((m: any) => !("citation" in m)));
});

test("myco check: manifest PASS + probe PASS on a fresh index", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  const res = await reviewRepo(r, { write: false });
  const fm = res.checks.find((c) => c.id === "index.file-manifest");
  const pr = res.checks.find((c) => c.id === "index.probe");
  assert.equal(fm?.status, "PASS", fm?.reason);
  assert.match(fm!.reason, /3 file\(s\) match the manifest \(synthrepo@[0-9a-f]{12}\)/);
  assert.equal(pr?.status, "PASS", pr?.reason);
});

test("myco check FAILs a drifted manifest and a failed probe search", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await editManifest(r, (m) => { m.fileCount = 9; });
  // The probe file is the first content file by path (.gitignore, term "myco");
  // rewrite it so the stored index is stale and the probe cannot be found.
  await fs.writeFile(path.join(r, ".gitignore"), "zz\n");
  const res = await reviewRepo(r, { write: false });
  const fm = res.checks.find((c) => c.id === "index.file-manifest")!;
  const pr = res.checks.find((c) => c.id === "index.probe")!;
  assert.equal(fm.status, "FAIL");
  assert.match(fm.reason, /UNUSABLE/);
  assert.ok(fm.details.some((d) => /fileCount 9/.test(d)));
  assert.equal(pr.status, "FAIL", pr.reason);
  assert.match(pr.reason, /UNUSABLE: the index says \.gitignore contains/);
  assert.equal(res.status, "FAIL");
});

test("myco check reports a missing manifest at the missingCoverageFile level", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  assert.equal(myco(r, "index", r).code, 0);
  await fs.rm(mpath(r));
  const res = await reviewRepo(r, { write: false });
  const fm = res.checks.find((c) => c.id === "index.file-manifest")!;
  assert.notEqual(fm.status, "PASS");
  assert.match(fm.reason, /missing/);
});