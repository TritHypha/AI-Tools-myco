// results-tree.test.ts — search/compare across every branch and worktree of a
// git app, read from git objects (no checkout). Synthetic temp repo only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { compareTree, queryToken, safeToken, searchTree } from "../src/query/branches.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const hasGit = spawnSync("git", ["--version"]).status === 0;

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

async function fixture(): Promise<{ parent: string; repo: string; wt: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "myco-tree-"));
  const repo = path.join(parent, "app");
  await fs.mkdir(repo);
  g(repo, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(repo, ".gitignore"), ".myco/\n.worktrees/\n");
  await fs.writeFile(path.join(repo, "shared.txt"), "alpha treeneedle\nsame\n");
  await fs.writeFile(path.join(repo, "only-main.txt"), "main file\n");
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "base");
  g(repo, "switch", "-q", "-c", "grok/foo");
  await fs.writeFile(path.join(repo, "shared.txt"), "alpha treeneedle\nchanged on foo treeneedle\n");
  g(repo, "commit", "-q", "-am", "foo");
  g(repo, "switch", "-q", "-c", "feature/bar", "main");
  await fs.rm(path.join(repo, "only-main.txt"));
  await fs.writeFile(path.join(repo, "bar.txt"), "bar has no hit\n");
  g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "bar");
  g(repo, "switch", "-q", "main");
  const wt = path.join(repo, ".worktrees", "codex-pr169");
  g(repo, "worktree", "add", "-q", "-b", "codex/pr169", wt, "main");
  await fs.writeFile(path.join(wt, "shared.txt"), "alpha treeneedle\nworktree edit treeneedle\n");
  return { parent, repo, wt };
}

test("safe tokens", () => {
  assert.equal(safeToken("grok/foo"), "grok%2Ffoo");
  assert.equal(safeToken(".worktrees/codex-pr169"), ".worktrees%2Fcodex-pr169");
  assert.equal(safeToken("a b:c"), "a%20b%3Ac");
  assert.match(queryToken("tree needle"), /^tree%20needle-[0-9a-f]{8}$/);
});

test("searchTree writes one folder per branch and worktree with repo@commit hits", { skip: !hasGit }, async () => {
  const { parent, repo } = await fixture();
  try {
    const main = g(repo, "rev-parse", "main");
    const foo = g(repo, "rev-parse", "grok/foo");
    const res = await searchTree(repo, repo, "treeneedle", { mode: "word", caseSensitive: "smart" });
    assert.deepEqual(res.errors, []);
    const folders = (await fs.readdir(res.dir)).sort();
    assert.deepEqual(folders, [
      "branch__codex%2Fpr169", "branch__feature%2Fbar", "branch__grok%2Ffoo", "branch__main",
      "summary.json", "summary.md", "worktree__.worktrees%2Fcodex-pr169", "worktree__root",
    ]);
    const hits = (name: string) => fs.readFile(path.join(res.dir, name, "hits.txt"), "utf8");
    assert.equal(await hits("branch__main"), `app@${main.slice(0, 12)}:shared.txt:1:alpha treeneedle\n`);
    assert.equal(
      await hits("branch__grok%2Ffoo"),
      `app@${foo.slice(0, 12)}:shared.txt:1:alpha treeneedle\napp@${foo.slice(0, 12)}:shared.txt:2:changed on foo treeneedle\n`,
    );
    assert.match(await hits("worktree__.worktrees%2Fcodex-pr169"), /shared\.txt:2:worktree edit treeneedle/);
    const byToken = Object.fromEntries(res.results.map((r) => [r.token, r]));
    assert.equal(byToken["branch__feature%2Fbar"]?.hits, 1);
    assert.equal(byToken["worktree__.worktrees%2Fcodex-pr169"]?.hits, 2);
    assert.ok(res.results.every((r) => r.status === "ok"));
    // Nothing was checked out: main tree still on main and clean.
    assert.equal(g(repo, "branch", "--show-current"), "main");
    assert.equal(g(repo, "status", "--porcelain"), "");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("compareTree reports identical/changed/missing per branch and worktree vs main", { skip: !hasGit }, async () => {
  const { parent, repo } = await fixture();
  try {
    const shared = await compareTree(repo, repo, "shared.txt");
    const state = Object.fromEntries(shared.rows.map((r) => [r.token, r.state]));
    assert.deepEqual(state, {
      "branch__codex%2Fpr169": "identical",
      "branch__feature%2Fbar": "identical",
      "branch__grok%2Ffoo": "changed",
      branch__main: "identical",
      "worktree__.worktrees%2Fcodex-pr169": "changed",
      worktree__root: "identical",
    });
    const patch = await fs.readFile(path.join(shared.dir, "branch__grok%2Ffoo", "diff.patch"), "utf8");
    assert.match(patch, /\+changed on foo treeneedle/);
    const only = await compareTree(repo, repo, "only-main.txt");
    assert.equal(only.rows.find((r) => r.token === "branch__feature%2Fbar")?.state, "missing");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("an unreadable worktree is reported, never silently skipped; CLI compare works", { skip: !hasGit }, async () => {
  const { parent, repo, wt } = await fixture();
  try {
    await fs.rm(wt, { recursive: true, force: true }); // stale worktree entry
    const res = await searchTree(repo, repo, "treeneedle", { mode: "word", caseSensitive: "smart" });
    const bad = res.results.find((r) => r.token === "worktree__.worktrees%2Fcodex-pr169");
    assert.equal(bad?.status, "error");
    await fs.access(path.join(res.dir, "worktree__.worktrees%2Fcodex-pr169", "ERROR.txt"));
    const cli = await new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "compare", "shared.txt", repo], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      child.on("exit", (code) => resolve({ code: code ?? -1, out }));
    });
    assert.equal(cli.code, 2, "an unreadable target fails the process boundary closed");
    assert.match(cli.out, /changed\s+branch__grok%2Ffoo/);
    assert.match(cli.out, /error\s+worktree__\.worktrees%2Fcodex-pr169/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
