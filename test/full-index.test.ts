// full-index.test.ts — "index everything" (owner 2026-10-28): no default size
// skip, default --limit 1000, sharded no-loss storage that fails closed, and
// git-tracked files indexed even when .gitignore matches them. Synthetic data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { SearchGraph } from "../src/graph/model.ts";
import { loadGraphOutcome, MANIFEST_FILE, saveGraph } from "../src/graph/store.ts";
import { buildIndex, DEFAULT_INDEX_OPTIONS, UNLIMITED_FILE_SIZE } from "../src/ingest/indexer.ts";
import { walk } from "../src/ingest/walk.ts";
import { isError, search } from "../src/query/search.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const opts = { mode: "word" as const, caseSensitive: "smart" as const, files: false, limit: 1000, context: 0 };

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "myco-full-"));
}

function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
    let out = ""; let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
    child.on("exit", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

test("a file larger than 5 MiB is content-searchable by default (no size skip)", async () => {
  const root = await tmp();
  try {
    assert.equal(DEFAULT_INDEX_OPTIONS.maxFileSize, UNLIMITED_FILE_SIZE);
    const body = "filler words here\n".repeat(Math.ceil((6 * 1024 * 1024) / 18)) + "bignineneedle at the end\n";
    await fs.writeFile(path.join(root, "big.txt"), body);
    const built = await buildIndex(root, DEFAULT_INDEX_OPTIONS);
    assert.deepEqual(built.skippedLargePaths, []);
    assert.equal(built.graph.fileByPath("big.txt")?.contentSkip, undefined);
    const out = await search(root, built.graph, "bignineneedle", opts);
    assert.ok(!isError(out));
    if (isError(out)) return;
    assert.equal(out.matches.length, 1);
    assert.equal(out.matches[0]?.path, "big.txt");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("--max-size stays optional and reported", async () => {
  const root = await tmp();
  try {
    await fs.writeFile(path.join(root, "a.txt"), "x".repeat(3 * 1024 * 1024));
    const res = await runCli(["index", root, "--max-size", "1"]);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /--max-size 1 MiB/);
    assert.match(res.out, /a\.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("search --limit defaults to 1000", async () => {
  const root = await tmp();
  try {
    await fs.writeFile(path.join(root, "many.txt"), "limitneedle\n".repeat(1500));
    const res = await runCli(["search", "limitneedle", root, "--json", "--no-branches"]);
    const payload = JSON.parse(res.out.slice(res.out.indexOf("{"))) as { matches: unknown[]; summary: { resultLimitExceeded: boolean } };
    assert.equal(payload.matches.length, 1000);
    assert.equal(payload.summary.resultLimitExceeded, true);
    const help = await runCli(["--help"]);
    assert.match(help.out, /max results \(default 1000\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a file with >100k distinct terms is fully searchable via a sharded index", async () => {
  const root = await tmp();
  try {
    const words: string[] = [];
    for (let i = 0; i < 300_000; i += 1) words.push(`w${i.toString(36)}z`);
    await fs.writeFile(path.join(root, "terms.txt"), words.join("\n") + "\n");
    await fs.writeFile(path.join(root, "small.txt"), "tail term\n");
    const built = await buildIndex(root, DEFAULT_INDEX_OPTIONS);
    assert.equal(built.saved.written, true);
    const dir = path.join(root, ".myco");
    const names = (await fs.readdir(dir)).sort();
    assert.ok(names.includes(MANIFEST_FILE), names.join(","));
    assert.ok(!names.includes("index.json"), "sharded layout replaces the single file");
    assert.ok(names.filter((n) => /^index-\d{3}\.json$/.test(n)).length >= 2, names.join(","));
    const loaded = await loadGraphOutcome(root);
    assert.equal(loaded.status, "ok");
    if (loaded.status !== "ok") return;
    assert.equal(loaded.graph.forwardOf(loaded.graph.fileByPath("terms.txt")!.id)?.size, 300_000);
    for (const probe of [words[0]!, words[150_000]!, words[299_999]!]) {
      const out = await search(root, loaded.graph, probe, opts);
      assert.ok(!isError(out) && out.matches.length === 1, probe);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function shardedRoot(): Promise<string> {
  const root = await tmp();
  const graph = new SearchGraph();
  for (let f = 0; f < 3; f += 1) {
    const counts = new Map<string, number>();
    for (let i = 0; i < 50; i += 1) counts.set(`t${f}x${i}`, 1);
    graph.setFile(`f${f}.txt`, 1, 1, counts);
  }
  assert.deepEqual(await saveGraph(root, graph, { maxEntries: 40, maxChars: 1 << 20 }), { written: true });
  assert.equal((await loadGraphOutcome(root)).status, "ok");
  return root;
}

test("a tampered shard fails closed (rejected)", async () => {
  const root = await shardedRoot();
  try {
    const shard = path.join(root, ".myco", "index-001.json");
    const text = await fs.readFile(shard, "utf8");
    await fs.writeFile(shard, text.replace(/"t\dx\d+"/, '"tamper"'));
    assert.equal((await loadGraphOutcome(root)).status, "rejected");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a missing shard fails closed (rejected, never absent)", async () => {
  const root = await shardedRoot();
  try {
    await fs.unlink(path.join(root, ".myco", "index-002.json"));
    assert.equal((await loadGraphOutcome(root)).status, "rejected");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a manifest count mismatch fails closed", async () => {
  const root = await shardedRoot();
  try {
    const m = path.join(root, ".myco", MANIFEST_FILE);
    const manifest = JSON.parse(await fs.readFile(m, "utf8"));
    manifest.fileCount += 1;
    await fs.writeFile(m, JSON.stringify(manifest));
    assert.equal((await loadGraphOutcome(root)).status, "rejected");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a git-tracked file is indexed even when .gitignore matches it", async (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) { t.skip("git not available"); return; }
  const root = await tmp();
  try {
    const g = (...args: string[]) => {
      const r = spawnSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    g("init", "-q");
    await fs.mkdir(path.join(root, "gen"), { recursive: true });
    await fs.writeFile(path.join(root, "gen", "kept.txt"), "trackedignoredneedle\n");
    await fs.writeFile(path.join(root, "notes.log"), "trackedlogneedle\n");
    g("add", "gen/kept.txt", "notes.log");
    g("commit", "-q", "-m", "seed");
    await fs.writeFile(path.join(root, ".gitignore"), "gen/\n*.log\n");
    await fs.writeFile(path.join(root, "gen", "untracked.txt"), "untrackedneedle\n");
    const rels = new Set((await walk(root, { maxFileSize: Infinity, useGitignore: true })).map((m) => m.relPath));
    assert.ok(rels.has("gen/kept.txt"));
    assert.ok(rels.has("notes.log"));
    assert.ok(!rels.has("gen/untracked.txt"), "untracked ignored files stay ignored");
    const built = await buildIndex(root, DEFAULT_INDEX_OPTIONS);
    const out = await search(root, built.graph, "trackedignoredneedle", opts);
    assert.ok(!isError(out) && out.matches.length === 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
