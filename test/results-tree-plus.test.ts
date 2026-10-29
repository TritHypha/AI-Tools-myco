// results-tree-plus.test.ts — coverage summaries, --branch/--worktree limits,
// git-native unified diffs, the thread view, odd filenames (NUL-safe, reversible
// tokens) and TriRegex streaming of very long lines. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareTree, decodeToken, encodeToken, listTargets, parseGrepZ, parseWorktreesZ, quotePath, searchTree,
} from "../src/query/branches.ts";
import { buildIndex, DEFAULT_INDEX_OPTIONS } from "../src/ingest/indexer.ts";
import { isError, search } from "../src/query/search.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const hasGit = spawnSync("git", ["--version"]).status === 0;
const opts = { mode: "word" as const, caseSensitive: "smart" as const, files: false, limit: 1000, context: 0 };

let clock = 1_700_000_000;
function g(cwd: string, args: string[], input?: string): string {
  clock += 100;
  const date = `@${clock} +0000`;
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(/\n$/, "");
}

function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    let out = ""; let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
    child.on("exit", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

/** main + 2 branches (feat/a, feat/b) + 1 linked worktree on feat/b. */
async function fixture(): Promise<{ parent: string; repo: string; wt: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "myco-plus-"));
  const repo = path.join(parent, "app");
  await fs.mkdir(repo);
  g(repo, ["init", "-q", "-b", "main"]);
  await fs.writeFile(path.join(repo, ".gitignore"), ".myco/\n.worktrees/\n");
  await fs.writeFile(path.join(repo, "doc.txt"), "one plusneedle\ntwo\nthree\n");
  g(repo, ["add", "-A"]);
  g(repo, ["commit", "-q", "-m", "c1 base"]);
  g(repo, ["branch", "feat/a"]);
  g(repo, ["branch", "feat/b"]);
  // feat/a changes line 2 (from git objects; no checkout of the main tree needed)
  g(repo, ["switch", "-q", "feat/a"]);
  await fs.writeFile(path.join(repo, "doc.txt"), "one plusneedle\nTWO on a\nthree\n");
  g(repo, ["commit", "-q", "-am", "c2 a edits line 2"]);
  g(repo, ["switch", "-q", "main"]);
  await fs.writeFile(path.join(repo, "doc.txt"), "ONE on main plusneedle\ntwo\nthree\n");
  g(repo, ["commit", "-q", "-am", "c3 main edits line 1"]);
  const wt = path.join(repo, ".worktrees", "wb");
  g(repo, ["worktree", "add", "-q", wt, "feat/b"]);
  await fs.writeFile(path.join(wt, "doc.txt"), "one plusneedle\ntwo\nthree wt\n");
  return { parent, repo, wt };
}

test("tokens are reversible, case-distinct and collision-free", () => {
  const names = [
    "with space", "unicodé-ñ", "new\nline", 'quo"te', "back\\slash", "-leading", "Case", "case",
    "a/b", "a__b", "a%2Fb", "trailing.", "..", "", "x".repeat(400), "con",
  ];
  const tokens = names.map(encodeToken);
  assert.equal(new Set(tokens.map((t) => t.toLowerCase())).size, names.length, tokens.join(" | "));
  for (const [i, n] of names.entries()) {
    const t = tokens[i]!;
    assert.match(t, /^[a-z0-9A-F._%~-]+$/, t);
    assert.ok(t.length <= 200, `${t.length}`);
    assert.ok(!t.endsWith("."), t);
    if (n.length < 100) assert.equal(decodeToken(t), n);
  }
  assert.equal(decodeToken(encodeToken("x".repeat(400))), null, "hashed tokens say so");
  assert.equal(quotePath("new\nline"), '"new\\nline"');
  assert.equal(quotePath("plain é"), "plain é");
});

test("NUL parsers: git grep -z and worktree list -z", () => {
  assert.deepEqual(parseGrepZ("abc:a:b\nc.txt\x003\x00text: x\n", "abc:"), [{ path: "a:b\nc.txt", line: 3, text: "text: x" }]);
  const wts = parseWorktreesZ("worktree /r\x00HEAD 1\x00branch refs/heads/main\x00\x00worktree /r/w x\x00HEAD 2\x00detached\x00\x00");
  assert.deepEqual(wts.map((w) => [w.dir, w.head, w.branch ?? null]), [["/r", "1", "main"], ["/r/w x", "2", null]]);
});

test("odd filenames are found exactly on a branch and compared with git diffs", { skip: !hasGit || process.platform === "win32" }, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "myco-odd-"));
  const repo = path.join(parent, "app");
  try {
    await fs.mkdir(repo);
    g(repo, ["init", "-q", "-b", "main"]);
    // Built from git objects so the test is filesystem-independent (Windows
    // cannot hold newline/quote/backslash names; case-only clashes collide).
    const odd = [
      "has space.txt", "ünïcødé/文件.txt", "new\nline.txt", 'quo"te.txt', "back\\slash.txt",
      "-leading.txt", "Clash.txt", "clash.txt", `${"deep/".repeat(40)}${"l".repeat(120)}.txt`,
    ];
    const put = (p: string, body: string): void => {
      const blob = g(repo, ["hash-object", "-w", "--stdin"], body);
      g(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${p}`]);
    };
    for (const p of odd) put(p, `v1 oddneedle\n`);
    g(repo, ["commit", "-q", "-m", "odd v1"]);
    g(repo, ["branch", "odd"]);
    g(repo, ["symbolic-ref", "HEAD", "refs/heads/odd"]);
    g(repo, ["read-tree", "odd"]);
    for (const p of odd) put(p, `v2 oddneedle\n`);
    g(repo, ["commit", "-q", "-m", "odd v2"]);
    g(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    g(repo, ["read-tree", "main"]);

    const res = await searchTree(repo, repo, "oddneedle", { mode: "word", caseSensitive: "smart", filter: { branches: ["odd"] } });
    assert.deepEqual(res.filterErrors, []);
    const hits = JSON.parse(await fs.readFile(path.join(res.dir, "branch__odd", "hits.json"), "utf8")) as { hits: Array<{ path: string; text: string }> };
    assert.deepEqual(hits.hits.map((h) => h.path).sort(), [...odd].sort());
    assert.ok(hits.hits.every((h) => h.text === "v2 oddneedle"));
    const txt = await fs.readFile(path.join(res.dir, "branch__odd", "hits.txt"), "utf8");
    assert.equal(txt.split("\n").filter((l) => l !== "").length, odd.length, "C-quoted paths keep one hit per line");
    assert.match(txt, /:"new\\nline\.txt":1:v2 oddneedle/);
    const target = JSON.parse(await fs.readFile(path.join(res.dir, "branch__odd", "target.json"), "utf8")) as { name: string };
    assert.equal(target.name, "odd");

    for (const p of odd) {
      const cmp = await compareTree(repo, repo, p, { branches: ["main", "odd"] });
      const byName = Object.fromEntries(cmp.rows.map((r) => [r.name, r.state]));
      assert.deepEqual(byName, { main: "identical", odd: "changed" }, p);
      const patch = await fs.readFile(path.join(cmp.dir, "branch__odd", "diff.patch"), "utf8");
      assert.match(patch, /^-v1 oddneedle$/m, p);
      assert.match(patch, /^\+v2 oddneedle$/m, p);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("compare writes git's unified diff, a thread ordered by commit time, and summary.md", { skip: !hasGit }, async () => {
  const { parent, repo } = await fixture();
  try {
    const cmp = await compareTree(repo, repo, "doc.txt");
    const state = Object.fromEntries(cmp.rows.map((r) => [r.token, r.state]));
    assert.equal(state["branch__feat%2Fa"], "changed");
    assert.equal(state["worktree__.worktrees%2Fwb"], "changed");
    const patchA = await fs.readFile(path.join(cmp.dir, "branch__feat%2Fa", "diff.patch"), "utf8");
    assert.match(patchA, /^diff --git /m);
    assert.match(patchA, /^@@ /m);
    assert.match(patchA, /^\+TWO on a$/m);
    const patchW = await fs.readFile(path.join(cmp.dir, "worktree__.worktrees%2Fwb", "diff.patch"), "utf8");
    assert.match(patchW, /^\+three wt$/m);

    const subjects = cmp.thread.map((e) => e.subject);
    assert.deepEqual(subjects.slice(0, 3), ["c1 base", "c2 a edits line 2", "c3 main edits line 1"]);
    const c1 = cmp.thread[0]!;
    assert.ok(c1.branches.includes("main"));
    assert.deepEqual(cmp.thread[1]!.branches, ["feat/a"]);
    assert.deepEqual(cmp.thread[1]!.hunks, [{ old: "2", new: "2" }]);
    assert.deepEqual(cmp.thread[2]!.branches, ["main"]);
    assert.ok(cmp.thread.some((e) => e.sha === "(uncommitted)"), "worktree edit is in the thread");
    const md = await fs.readFile(path.join(cmp.dir, "thread.md"), "utf8");
    assert.match(md, /\[feat\/a\] t: c2 a edits line 2\n- was line 2 -> now line 2/);
    const summary = await fs.readFile(path.join(cmp.dir, "summary.md"), "utf8");
    assert.match(summary, /branches: +3 of 3/);
    assert.match(summary, /worktrees: 2 of 2/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("--branch / --worktree limit runs, say so, and unmatched filters fail closed", { skip: !hasGit }, async () => {
  const { parent, repo, wt } = await fixture();
  try {
    const all = await listTargets(repo);
    assert.equal(all.targets.length, 5);
    const lim = await listTargets(repo, { branches: ["feat/a"], worktrees: [".worktrees/wb"] });
    assert.deepEqual(lim.targets.map((t) => t.token).sort(), ["branch__feat%2Fa", "worktree__.worktrees%2Fwb"]);
    const viaAbs = await listTargets(repo, { worktrees: [wt] });
    assert.equal(viaAbs.targets.length, 1);
    const bad = await listTargets(repo, { branches: ["nope"] });
    assert.equal(bad.filterErrors.length, 1);

    const cli = await runCli(["plusneedle", repo, "--branch", "feat/a"]);
    assert.equal(cli.code, 0, cli.err);
    assert.match(cli.out, /coverage \(search\)/);
    assert.match(cli.out, /LIMITED run \(--branch feat\/a\)/);
    assert.match(cli.out, /branches: +1 of 3/);
    assert.match(cli.out, /worktrees: 0 of 2/);
    assert.match(cli.out, /index: \d+ file\(s\), (legacy|sharded) store, \d+ shard\(s\)/);
    const qdirs = await fs.readdir(path.join(repo, ".myco", "results"));
    const q = qdirs.find((d) => d.startsWith("plusneedle-"))!;
    assert.deepEqual((await fs.readdir(path.join(repo, ".myco", "results", q))).sort(), ["branch__feat%2Fa", "summary.json", "summary.md"]);

    const nope = await runCli(["plusneedle", repo, "--branch", "nope"]);
    assert.equal(nope.code, 2);
    assert.match(nope.err, /--branch "nope" matches no local branch/);
    const idx = await runCli(["index", repo, "--branch", "main"]);
    assert.equal(idx.code, 2);
    assert.match(idx.err, /index --branch is refused/);
    const idxWt = await runCli(["index", repo, "--worktree", ".worktrees/wb"]);
    assert.equal(idxWt.code, 0, idxWt.err);
    assert.match(idxWt.out, /coverage \(index\)/);
    assert.match(idxWt.out, /LIMITED run \(--worktree \.worktrees\/wb\)/);
    await fs.access(path.join(wt, ".myco"));
    const cmp = await runCli(["compare", "doc.txt", repo, "--worktree", "root"]);
    assert.equal(cmp.code, 0, cmp.err);
    assert.match(cmp.out, /coverage \(compare\)/);
    assert.match(cmp.out, /thread: \d+ version\(s\)/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("all terms on ONE 2MB+ line are found (TriRegex streams the full line)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "myco-longline-"));
  try {
    const words: string[] = [];
    for (let i = 0; i < 330_000; i += 1) words.push(`w${i.toString(36)}z`);
    const line = words.join(" ");
    assert.ok(line.length > 2 * 1024 * 1024, `${line.length}`);
    await fs.writeFile(path.join(root, "one-line.txt"), line + "\n");
    const built = await buildIndex(root, DEFAULT_INDEX_OPTIONS);
    for (const probe of [words[0]!, words[150_000]!, words[299_999]!]) {
      const out = await search(root, built.graph, probe, opts);
      assert.ok(!isError(out), probe);
      if (isError(out)) return;
      assert.equal(out.matches.length, 1, probe);
      assert.equal(out.matches[0]!.col, line.indexOf(probe) + 1);
      assert.deepEqual(out.longLineRefusals, []);
      assert.equal(out.complete, true);
    }
    const sub = await search(root, built.graph, words[299_999]!.slice(1), { ...opts, mode: "substring" });
    assert.ok(!isError(sub) && sub.matches.length === 1);
    const w = words[320_000]!;
    const rx = await search(root, built.graph, `${w.slice(0, -2)}[a-z0-9]z`, { ...opts, mode: "regex" });
    assert.ok(!isError(rx) && rx.matches.length >= 1 && rx.longLineRefusals.length === 0, JSON.stringify(!isError(rx) && rx.longLineRefusals));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a TriRegex refusal on a long line is reported, never read as no-hit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "myco-refuse-"));
  try {
    await fs.writeFile(path.join(root, "long.txt"), "x ".repeat(150_000) + "éclair\n");
    const built = await buildIndex(root, DEFAULT_INDEX_OPTIONS);
    const out = await search(root, built.graph, "éclair", { ...opts, caseSensitive: false });
    assert.ok(!isError(out));
    if (isError(out)) return;
    assert.equal(out.longLineRefusals.length, 1);
    assert.equal(out.longLineRefusals[0]!.code, "MYCO-TRI-CASEFOLD");
    assert.equal(out.complete, false);
    assert.equal(out.truncated, true);
    const cli = await runCli(["-i", "éclair", root]);
    assert.equal(cli.code, 2, "incomplete coverage fails the process boundary closed");
    assert.match(cli.out, /TriRegex REFUSED 1 over-long line/);
    assert.match(cli.out, /refused:\n\s+TriRegex MYCO-TRI-CASEFOLD/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
