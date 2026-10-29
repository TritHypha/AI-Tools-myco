// review.test.ts — `myco check` / `myco run-all`: every rule and every exit code,
// on synthetic temp repos only (no real data, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_RULES, levelFor, mergeRules, reviewRepo, worst, exitCodeFor } from "../src/review/check.ts";
import type { Check, ReviewRules } from "../src/review/check.ts";
import { loadGraphOutcome, saveGraph } from "../src/graph/store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const hasGit = spawnSync("git", ["--version"]).status === 0;
const DAY = 86_400_000;

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
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "myco-review-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const r = path.join(parent, "app");
  await fs.mkdir(r);
  g(r, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(r, ".gitignore"), ".myco/\n");
  await fs.writeFile(path.join(r, "a.txt"), "alpha reviewneedle\n");
  await fs.writeFile(path.join(r, "b.txt"), "beta\n");
  g(r, "add", "-A"); g(r, "commit", "-q", "-m", "base");
  return r;
}
async function indexed(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const r = await repo(t);
  const res = myco(r, "index", r);
  assert.equal(res.code, 0, res.err);
  return r;
}
const rules = (over: Record<string, unknown> = {}): ReviewRules => mergeRules(over, "test");
function get(checks: Check[], id: string): Check {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} missing; have ${checks.map((x) => x.id).join(",")}`);
  return c;
}
async function editCoverage(r: string, fn: (c: Record<string, any>) => void): Promise<void> {
  const p = path.join(r, ".myco", "index-coverage.json");
  const c = JSON.parse(await fs.readFile(p, "utf8"));
  fn(c);
  await fs.writeFile(p, JSON.stringify(c));
}
const tmpOut = async (r: string): Promise<string> => path.join(r, ".myco", "review");

// ---------------------------------------------------------------- pure rules

test("RV-01 levelFor thresholds: strict >, null = never", () => {
  assert.equal(levelFor(0, { warnAbove: 0, failAbove: null }), "PASS");
  assert.equal(levelFor(1, { warnAbove: 0, failAbove: null }), "WARN");
  assert.equal(levelFor(5, { warnAbove: 0, failAbove: 4 }), "FAIL");
  assert.equal(levelFor(4, { warnAbove: 0, failAbove: 4 }), "WARN");
  assert.equal(levelFor(99, { warnAbove: null, failAbove: null }), "PASS");
  assert.equal(worst(["PASS", "WARN", "PASS"]), "WARN");
  assert.equal(worst(["WARN", "FAIL"]), "FAIL");
  assert.deepEqual([exitCodeFor("PASS"), exitCodeFor("WARN"), exitCodeFor("FAIL")], [0, 1, 2]);
});

test("RV-02 rules: overrides merge, typos and bad types are errors", () => {
  const r = rules({ resultLimit: 5, emptyResults: "FAIL", gapGrowth: { failAbove: 3 } });
  assert.equal(r.resultLimit, 5);
  assert.equal(r.emptyResults, "FAIL");
  assert.deepEqual(r.gapGrowth, { warnAbove: 0, failAbove: 3 });
  assert.equal(DEFAULT_RULES.resultLimit, 1000, "defaults not mutated");
  assert.throws(() => rules({ resultLimt: 5 }), /unknown review rule/);
  assert.throws(() => rules({ emptyResults: "LOUD" }), /must be/);
  assert.throws(() => rules({ gapGrowth: { warnAbove: "1" } }), /number or null/);
  assert.throws(() => rules({ gapGrowth: { warn: 1 } }), /not a threshold key/);
  assert.throws(() => rules({ resultLimit: 0 }), /positive integer/);
});

// ---------------------------------------------------------------- index rules

test("RV-03 green repo: all PASS, exit 0, files written, baseline stable", { skip: !hasGit }, async (t) => {
  const r = await indexed(t);
  const res = myco(r, "check", r);
  assert.equal(res.code, 0, res.out + res.err);
  const out = await tmpOut(r);
  const json = JSON.parse(await fs.readFile(path.join(out, "review.json"), "utf8"));
  assert.equal(json.status, "PASS");
  assert.ok((await fs.readFile(path.join(out, "review.md"), "utf8")).startsWith("# myco review — PASS"));
  const b1 = await fs.readFile(path.join(out, "baseline.json"), "utf8");
  assert.equal(myco(r, "check", r).code, 0);
  const b2 = await fs.readFile(path.join(out, "baseline.json"), "utf8");
  assert.equal(b1, b2, "baseline has no timestamps: identical when nothing changed");
  assert.equal(get(json.checks, "index.vs-git").status, "PASS");
  assert.match(get(json.checks, "index.vs-git").reason, /3 of 3 tracked/);
});

test("RV-04 index absent → FAIL, exit 2; rejected index → FAIL", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  const res = myco(r, "check", r);
  assert.equal(res.code, 2);
  let rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.present").status, "FAIL");
  assert.equal(get(rv.checks, "index.coverage-file").status, "WARN");
  myco(r, "index", r);
  await fs.writeFile(path.join(r, ".myco", "index.json"), "{\"format\":1,\"garbage\":true}");
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.present").status, "FAIL");
  assert.match(get(rv.checks, "index.present").reason, /REFUSED/);
});

test("RV-05 tracked file not indexed and unexplained → FAIL; explained gaps PASS", { skip: !hasGit }, async (t) => {
  const r = await indexed(t);
  await fs.writeFile(path.join(r, "late.txt"), "staged after index\n");
  g(r, "add", "late.txt");
  let rv = await reviewRepo(r, { write: false });
  const c = get(rv.checks, "index.vs-git");
  assert.equal(c.status, "FAIL");
  assert.match(c.reason, /UNEXPLAINED: 1/);
  assert.ok(c.details.some((d) => d.includes("late.txt")));
  // explained: a deleted tracked file and a listed unreadable one
  g(r, "rm", "-q", "--cached", "late.txt");
  await fs.rm(path.join(r, "b.txt"));
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.vs-git").status, "PASS", "file still indexed → no gap");
  myco(r, "index", r);
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.vs-git").status, "PASS");
  assert.match(get(rv.checks, "index.vs-git").reason, /1 deleted/);
  // unreadable recorded by the indexer explains the gap
  await fs.writeFile(path.join(r, "u.txt"), "x\n"); g(r, "add", "u.txt");
  await editCoverage(r, (cv) => { cv.lists.unreadable = ["u.txt"]; });
  rv = await reviewRepo(r, { write: false });
  assert.match(get(rv.checks, "index.vs-git").reason, /1 unreadable/);
  assert.equal(get(rv.checks, "index.vs-git").status, "PASS");
  assert.equal(get(rv.checks, "index.unreadable").status, "WARN");
});

test("RV-06 symlinks explained in the gap, new symlink since baseline → WARN", { skip: !hasGit || process.platform === "win32" }, async (t) => {
  const r = await indexed(t);
  assert.equal((await reviewRepo(r)).status, "PASS");
  await fs.symlink("a.txt", path.join(r, "link.txt"));
  g(r, "add", "link.txt"); g(r, "commit", "-q", "-m", "link");
  myco(r, "index", r);
  const rv = await reviewRepo(r);
  const s = get(rv.checks, "index.symlinks");
  assert.equal(s.status, "WARN");
  assert.ok(s.details.includes("NEW: link.txt"));
  assert.match(get(rv.checks, "index.vs-git").reason, /1 symlink/);
  assert.equal(get(rv.checks, "index.vs-git").status, "PASS");
  // listed again next run: no longer new
  assert.equal(get((await reviewRepo(r)).checks, "index.symlinks").status, "PASS");
});

test("RV-07 gap growth since last run → WARN; configurable to FAIL", { skip: !hasGit }, async (t) => {
  const r = await indexed(t);
  let rv = await reviewRepo(r);
  assert.match(get(rv.checks, "index.gap-growth").reason, /no previous baseline/);
  await fs.rm(path.join(r, "b.txt"));
  myco(r, "index", r);
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.gap-growth").status, "WARN");
  assert.match(get(rv.checks, "index.gap-growth").reason, /0 → 1 \(\+1\)/);
  rv = await reviewRepo(r, { write: false, rules: rules({ gapGrowth: { warnAbove: null, failAbove: 0 } }) });
  assert.equal(get(rv.checks, "index.gap-growth").status, "FAIL");
  rv = await reviewRepo(r, { write: false, rules: rules({ gapGrowth: { warnAbove: 1, failAbove: null } }) });
  assert.equal(get(rv.checks, "index.gap-growth").status, "PASS");
});

test("RV-08 over-size / unreadable counts with thresholds", { skip: !hasGit }, async (t) => {
  const r = await indexed(t);
  await editCoverage(r, (c) => { c.lists.overSize = ["big.bin"]; c.lists.unreadable = ["x", "y"]; });
  let rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.skipped").status, "WARN");
  assert.equal(get(rv.checks, "index.unreadable").status, "WARN");
  rv = await reviewRepo(r, { write: false, rules: rules({ unreadable: { failAbove: 1 }, overSize: { warnAbove: 1 } }) });
  assert.equal(get(rv.checks, "index.unreadable").status, "FAIL");
  assert.equal(get(rv.checks, "index.skipped").status, "PASS");
});

test("RV-09 shard sha256 integrity: verified, tampered → FAIL, missing → FAIL, orphan → WARN", { skip: !hasGit }, async (t) => {
  const r = await indexed(t);
  const loaded = await loadGraphOutcome(r);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") return;
  const saved = await saveGraph(r, loaded.graph, { maxEntries: 1, maxChars: 1 << 20 });
  assert.equal(saved.written, true);
  let rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.integrity").status, "PASS");
  assert.match(get(rv.checks, "index.integrity").reason, /shard\(s\), every sha256/);
  await fs.writeFile(path.join(r, ".myco", "index-099.json"), "{}");
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.integrity").status, "WARN");
  await fs.rm(path.join(r, ".myco", "index-099.json"));
  const shard = path.join(r, ".myco", "index-000.json");
  const text = await fs.readFile(shard, "utf8");
  await fs.writeFile(shard, text + "\n");
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.integrity").status, "FAIL");
  assert.match(get(rv.checks, "index.integrity").details.join("\n"), /sha256 mismatch/);
  assert.equal(get(rv.checks, "index.present").status, "FAIL", "loader refuses it too");
  await fs.rm(shard);
  rv = await reviewRepo(r, { write: false });
  assert.match(get(rv.checks, "index.integrity").details.join("\n"), /MISSING/);
});

test("RV-10 secret guard: counts reported, growth → WARN, guard off → WARN", { skip: !hasGit }, async (t) => {
  const r = await repo(t);
  const gh = ["gh", "p_"].join("") + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
  await fs.writeFile(path.join(r, "cfg1.txt"), `token = ${gh}\n`);
  g(r, "add", "-A"); g(r, "commit", "-q", "-m", "s1");
  myco(r, "index", r);
  let rv = await reviewRepo(r);
  const s = get(rv.checks, "index.secret-guard");
  assert.equal(s.status, "PASS");
  assert.match(s.reason, /1 indexed file\(s\) carry withheld/);
  assert.ok(!JSON.stringify(rv).includes(gh), "secret value never in review output");
  await fs.writeFile(path.join(r, "cfg2.txt"), `token = ${gh.replace("a1", "z9")}\n`);
  g(r, "add", "-A"); g(r, "commit", "-q", "-m", "s2");
  myco(r, "index", r);
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.secret-guard").status, "WARN", get(rv.checks, "index.secret-guard").reason);
  myco(r, "index", "--no-secret-guard", r);
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.secret-guard").status, "WARN");
  assert.match(get(rv.checks, "index.secret-guard").reason, /OFF/);
});

test("RV-11 stale index vs HEAD → WARN; old index → WARN; pinned index is deliberate", { skip: !hasGit }, async (t) => {
  const r = await indexed(t);
  await fs.writeFile(path.join(r, "c.txt"), "gamma\n");
  g(r, "add", "-A"); g(r, "commit", "-q", "-m", "next");
  let rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.stale").status, "WARN");
  rv = await reviewRepo(r, { write: false, now: Date.now() + 2 * DAY });
  assert.equal(get(rv.checks, "index.age").status, "WARN");
  rv = await reviewRepo(r, { write: false, rules: rules({ staleHead: "FAIL" }) });
  assert.equal(get(rv.checks, "index.stale").status, "FAIL");
  myco(r, "index", "--at", "HEAD~1", r);
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.stale").status, "PASS");
  assert.match(get(rv.checks, "index.stale").reason, /pinned/);
  assert.match(get(rv.checks, "index.vs-git").reason, /files at pinned/);
  assert.equal(get(rv.checks, "index.vs-git").status, "PASS");
});

test("RV-12 missing / malformed coverage file", { skip: !hasGit }, async (t) => {
  const r = await indexed(t);
  await fs.rm(path.join(r, ".myco", "index-coverage.json"));
  let rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.coverage-file").status, "WARN");
  await fs.writeFile(path.join(r, ".myco", "index-coverage.json"), "{nope");
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "index.coverage-file").status, "FAIL");
});

// ---------------------------------------------------------------- results rules

async function withResults(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const r = await indexed(t);
  g(r, "switch", "-q", "-c", "feat");
  await fs.writeFile(path.join(r, "a.txt"), "alpha reviewneedle\nmore reviewneedle on feat\n");
  g(r, "commit", "-q", "-am", "feat");
  g(r, "switch", "-q", "main");
  myco(r, "index", r);
  assert.equal(myco(r, "reviewneedle", r).code, 0);
  assert.equal(myco(r, "compare", "a.txt", r).code, 0);
  return r;
}
const qdirOf = async (r: string, prefix: string): Promise<string> => {
  const names = await fs.readdir(path.join(r, ".myco", "results"));
  const n = names.find((x) => x.startsWith(prefix));
  assert.ok(n, `no results folder ${prefix}* in ${names.join(",")}`);
  return path.join(r, ".myco", "results", n);
};

test("RV-13 healthy search + compare results all PASS", { skip: !hasGit }, async (t) => {
  const r = await withResults(t);
  const rv = await reviewRepo(r, { write: false });
  for (const id of ["results.summaries", "results.counts", "results.capped", "results.empty", "results.coverage", "results.unreadable", "results.refused", "compare.wellformed"]) {
    assert.equal(get(rv.checks, id).status, "PASS", `${id}: ${get(rv.checks, id).reason} ${get(rv.checks, id).details.join(";")}`);
  }
  assert.match(get(rv.checks, "results.summaries").reason, /1 search, 1 compare/);
  assert.equal(rv.status, "PASS");
});

test("RV-14 missing summary.md → FAIL; hit-count mismatch → FAIL; orphan folder → FAIL", { skip: !hasGit }, async (t) => {
  const r = await withResults(t);
  const q = await qdirOf(r, "reviewneedle");
  const hits = path.join(q, "branch__main", "hits.txt");
  await fs.appendFile(hits, "forged line\n");
  let rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "results.counts").status, "FAIL");
  assert.match(get(rv.checks, "results.counts").details.join("\n"), /2 line\(s\) but summary says 1/);
  await fs.mkdir(path.join(q, "branch__ghost"));
  rv = await reviewRepo(r, { write: false });
  assert.match(get(rv.checks, "results.counts").details.join("\n"), /not listed in summary\.json/);
  await fs.rm(path.join(q, "summary.md"));
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "results.summaries").status, "FAIL");
});

test("RV-15 capped at limit → WARN; empty results → WARN", { skip: !hasGit }, async (t) => {
  const r = await withResults(t);
  let rv = await reviewRepo(r, { write: false, rules: rules({ resultLimit: 1 }) });
  assert.equal(get(rv.checks, "results.capped").status, "WARN");
  // boundary: hits == limit is capped, hits == limit - 1 is not
  const qs = JSON.parse(await fs.readFile(path.join(await qdirOf(r, "reviewneedle"), "summary.json"), "utf8"));
  const maxHits = Math.max(...qs.targets.map((x: { hits: number }) => x.hits));
  assert.ok(maxHits >= 1);
  rv = await reviewRepo(r, { write: false, rules: rules({ resultLimit: maxHits }) });
  assert.equal(get(rv.checks, "results.capped").status, "WARN", "hits == limit");
  rv = await reviewRepo(r, { write: false, rules: rules({ resultLimit: maxHits + 1 }) });
  assert.equal(get(rv.checks, "results.capped").status, "PASS", "hits < limit");
  assert.equal(myco(r, "zzznothere", r).code, 1);
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "results.empty").status, "WARN");
  assert.match(get(rv.checks, "results.empty").details.join(), /zzznothere/);
});

test("RV-16 limited branch coverage → WARN; unreadable target → FAIL; refused → WARN", { skip: !hasGit }, async (t) => {
  const r = await withResults(t);
  myco(r, "reviewneedle", "--branch", "feat", r);
  let rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "results.coverage").status, "WARN");
  assert.match(get(rv.checks, "results.coverage").details.join(), /LIMITED/);
  const q = await qdirOf(r, "reviewneedle");
  const sp = path.join(q, "summary.json");
  const s = JSON.parse(await fs.readFile(sp, "utf8"));
  s.targets[0].status = "error"; s.targets[0].error = "synthetic unreadable";
  s.coverage.refused = ["TriRegex R1 at a.txt:1: synthetic"];
  await fs.writeFile(sp, JSON.stringify(s));
  await fs.writeFile(path.join(q, s.targets[0].token, "ERROR.txt"), "synthetic\n");
  rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "results.unreadable").status, "FAIL");
  assert.equal(get(rv.checks, "results.refused").status, "WARN");
});

test("RV-17 compare outputs: missing diff.patch / bad header / no hunk / thread.md → FAIL", { skip: !hasGit }, async (t) => {
  const r = await withResults(t);
  const q = await qdirOf(r, "compare__");
  const summary = JSON.parse(await fs.readFile(path.join(q, "summary.json"), "utf8"));
  const changed = summary.rows.find((x: { state: string }) => x.state === "changed");
  assert.ok(changed, "fixture has a changed row");
  const patch = path.join(q, changed.token, "diff.patch");
  const good = await fs.readFile(patch, "utf8");
  await fs.writeFile(patch, good.replace("# myco compare", "# other"));
  let rv = await reviewRepo(r, { write: false });
  assert.equal(get(rv.checks, "compare.wellformed").status, "FAIL");
  assert.match(get(rv.checks, "compare.wellformed").details.join(), /header/);
  await fs.writeFile(patch, good.replace(/^@@.*$/gm, ""));
  rv = await reviewRepo(r, { write: false });
  assert.match(get(rv.checks, "compare.wellformed").details.join(), /no unified-diff hunk/);
  await fs.rm(patch);
  rv = await reviewRepo(r, { write: false });
  assert.match(get(rv.checks, "compare.wellformed").details.join(), /diff\.patch missing/);
  await fs.writeFile(patch, good);
  await fs.writeFile(path.join(q, changed.token, "result.txt"), "identical\n");
  rv = await reviewRepo(r, { write: false });
  assert.match(get(rv.checks, "compare.wellformed").details.join(), /result\.txt says/);
  await fs.rm(path.join(q, "thread.md"));
  rv = await reviewRepo(r, { write: false });
  assert.match(get(rv.checks, "compare.wellformed").details.join(), /thread\.md missing/);
});

test("RV-18 regression vs baseline → WARN once, then stable", { skip: !hasGit }, async (t) => {
  const r = await withResults(t);
  assert.equal((await reviewRepo(r)).status, "PASS");
  await fs.rm(path.join(await qdirOf(r, "compare__"), "thread.md"));
  const rv = await reviewRepo(r);
  assert.equal(get(rv.checks, "review.regression").status, "WARN");
  assert.match(get(rv.checks, "review.regression").details.join(), /compare\.wellformed PASS → FAIL/);
  assert.equal(get((await reviewRepo(r)).checks, "review.regression").status, "PASS");
});

// ---------------------------------------------------------------- CLI + config + exit codes

test("RV-19 exit codes 0 / 1 / 2 through the CLI, --json, rules sources", { skip: !hasGit }, async (t) => {
  const r = await indexed(t);
  const ok = myco(r, "check", r);
  assert.equal(ok.code, 0);
  assert.ok(!ok.out.includes("\\x0a"), "text output keeps real newlines");
  assert.ok(ok.out.split("\n").length > 5);
  await editCoverage(r, (c) => { c.lists.overSize = ["big.bin"]; });
  assert.equal(myco(r, "review", r).code, 1, "alias review, WARN → 1");
  await fs.writeFile(path.join(r, "myco.config.json"), JSON.stringify({ review: { overSize: { failAbove: 0 } } }));
  const fail = myco(r, "check", "--json", r);
  assert.equal(fail.code, 2);
  assert.equal(JSON.parse(fail.out).rulesSource, "myco.config.json");
  await fs.writeFile(path.join(r, ".myco", "review-rules.json"), JSON.stringify({ overSize: { warnAbove: 5 } }));
  assert.equal(myco(r, "check", r).code, 0, ".myco/review-rules.json wins over myco.config.json");
  const ext = path.join(r, "..", "strict.json");
  await fs.writeFile(ext, JSON.stringify({ overSize: { failAbove: 0 } }));
  assert.equal(myco(r, "check", "--rules", ext, r).code, 2, "--rules wins");
  await fs.writeFile(ext, JSON.stringify({ bogus: 1 }));
  const bad = myco(r, "check", "--rules", ext, r);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown review rule "bogus"/);
  const out = path.join(r, "..", "rv-out");
  assert.equal(myco(r, "check", "--out", out, "--rules", path.join(r, ".myco", "review-rules.json"), r).code, 0);
  assert.ok((await fs.readFile(path.join(out, "review.md"), "utf8")).includes("index.vs-git"));
  assert.equal(myco(r, "check", path.join(r, "nope")).code, 2);
});

test("RV-20 run-all: index + check per repo, combined status, append-only history", { skip: !hasGit }, async (t) => {
  const green = await repo(t);
  const red = await repo(t);
  const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "myco-runall-"));
  t.after(() => fs.rm(cfgDir, { recursive: true, force: true }));
  const cfg = path.join(cfgDir, "repos.json");
  await fs.writeFile(cfg, JSON.stringify({ out: "status", repos: [{ path: green, name: "green" }, { path: red, name: "red" }] }));
  let res = myco(cfgDir, "run-all", "--config", cfg);
  assert.equal(res.code, 0, res.out + res.err);
  const st = JSON.parse(await fs.readFile(path.join(cfgDir, "status", "status.json"), "utf8"));
  assert.equal(st.status, "PASS");
  assert.equal(st.repos.length, 2);
  assert.ok(await fs.stat(path.join(cfgDir, "status", "logs", "green.index.log")));
  // make red WARN: commit after... use --no-index so the index goes stale
  await fs.writeFile(path.join(red, "c.txt"), "c\n");
  g(red, "add", "-A"); g(red, "commit", "-q", "-m", "c");
  res = myco(cfgDir, "run-all", "--config", cfg, "--no-index");
  assert.equal(res.code, 2, "new tracked file unindexed → FAIL");
  // a missing repo is FAIL
  await fs.writeFile(cfg, JSON.stringify({ out: "status", repos: [{ path: green }, { path: "does-not-exist" }] }));
  res = myco(cfgDir, "run-all", "--config", cfg);
  assert.equal(res.code, 2);
  const hist = (await fs.readFile(path.join(cfgDir, "status", "history.jsonl"), "utf8")).trim().split("\n");
  assert.equal(hist.length, 3, "one line appended per run");
  assert.deepEqual(hist.map((l) => JSON.parse(l).status), ["PASS", "FAIL", "FAIL"]);
  assert.match(await fs.readFile(path.join(cfgDir, "status", "status.md"), "utf8"), /repo path not found/);
  // WARN exit 1: stale HEAD only
  await fs.writeFile(cfg, JSON.stringify({ out: "status", repos: [{ path: green, index: false }] }));
  g(green, "commit", "-q", "--allow-empty", "-m", "empty");
  res = myco(cfgDir, "run-all", "--config", cfg);
  assert.equal(res.code, 1, res.out);
  // bad config
  await fs.writeFile(cfg, JSON.stringify({ repos: [] }));
  assert.equal(myco(cfgDir, "run-all", "--config", cfg).code, 2);
  assert.equal(myco(cfgDir, "run-all").code, 2);
});
