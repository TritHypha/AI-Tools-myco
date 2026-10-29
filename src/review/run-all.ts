// run-all.ts — `myco run-all --config <file>`: index + check every repo listed in
// a JSON config, then write a combined status file and append one line to an
// append-only history log. Built for unattended schedules (Task Scheduler, cron).
//
// Config (paths relative to the config file):
//   { "out": "./myco-status",
//     "repos": [ { "path": "../app", "name": "app", "index": true,
//                  "indexArgs": ["--vendored"], "rules": "rules.json" } ] }

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { exitCodeFor, loadRules, reviewRepo, worst } from "./check.ts";
import type { Level } from "./check.ts";

export interface RepoEntry { path: string; name?: string; index?: boolean; indexArgs?: string[]; rules?: string; }
export interface RunAllConfig { out?: string; repos: RepoEntry[]; }

export interface RepoStatus {
  name: string; path: string; indexExit: number | null; indexLog: string | null;
  review: Level | null; reviewDir: string | null; counts: Record<Level, number> | null;
  status: Level; reason: string; failing: string[];
}

export async function loadRunAllConfig(file: string): Promise<{ config: RunAllConfig; dir: string }> {
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { throw new Error(`config ${file}: ${(e as Error).message}`); }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as RunAllConfig).repos) || (raw as RunAllConfig).repos.length === 0) {
    throw new Error(`config ${file}: needs a non-empty "repos" array`);
  }
  for (const [i, r] of (raw as RunAllConfig).repos.entries()) {
    if (typeof r !== "object" || r === null || typeof r.path !== "string" || r.path === "") throw new Error(`config ${file}: repos[${i}].path must be a string`);
    if (r.indexArgs !== undefined && (!Array.isArray(r.indexArgs) || r.indexArgs.some((a) => typeof a !== "string"))) throw new Error(`config ${file}: repos[${i}].indexArgs must be an array of strings`);
  }
  return { config: raw as RunAllConfig, dir: path.dirname(path.resolve(file)) };
}

function runIndex(repo: string, args: string[], log: string): Promise<number> {
  return new Promise((resolve) => {
    const script = process.argv[1]!;
    const child = spawn(process.execPath, [...process.execArgv, script, "index", ...args, repo], { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", (e) => { chunks.push(Buffer.from(`spawn error: ${e.message}\n`)); });
    child.on("close", async (code) => {
      await fs.writeFile(log, Buffer.concat(chunks)).catch(() => undefined);
      resolve(code ?? 2);
    });
  });
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "repo";
}

export async function runAll(configFile: string, opts: { outDir?: string; noIndex?: boolean; now?: () => number } = {}): Promise<{ status: Level; exitCode: number; outDir: string; repos: RepoStatus[] }> {
  const { config, dir } = await loadRunAllConfig(configFile);
  const now = opts.now ?? Date.now;
  const outDir = path.resolve(opts.outDir ?? path.resolve(dir, config.out ?? "myco-status"));
  await fs.mkdir(path.join(outDir, "logs"), { recursive: true });
  const used = new Set<string>();
  const repos: RepoStatus[] = [];
  const started = new Date(now()).toISOString();
  for (const entry of config.repos) {
    const repo = path.resolve(dir, entry.path);
    let name = slug(entry.name ?? path.basename(repo));
    for (let n = 2; used.has(name); n++) name = `${slug(entry.name ?? path.basename(repo))}-${n}`;
    used.add(name);
    const st: RepoStatus = { name, path: repo, indexExit: null, indexLog: null, review: null, reviewDir: null, counts: null, status: "FAIL", reason: "", failing: [] };
    const isDir = await fs.stat(repo).then((s) => s.isDirectory(), () => false);
    if (!isDir) { st.reason = `repo path not found: ${repo}`; repos.push(st); continue; }
    if (entry.index !== false && !opts.noIndex) {
      st.indexLog = path.join(outDir, "logs", `${name}.index.log`);
      st.indexExit = await runIndex(repo, entry.indexArgs ?? [], st.indexLog);
    }
    try {
      const { rules, source } = await loadRules(repo, entry.rules === undefined ? undefined : path.resolve(dir, entry.rules));
      const r = await reviewRepo(repo, { rules, rulesSource: source, now: now() });
      st.review = r.status;
      st.reviewDir = r.outDir;
      st.counts = r.counts;
      st.failing = r.checks.filter((c) => c.status !== "PASS").map((c) => `${c.status} ${c.id}: ${c.reason}`);
      const indexFailed = st.indexExit !== null && st.indexExit !== 0;
      st.status = indexFailed ? "FAIL" : r.status;
      st.reason = indexFailed ? `myco index exited ${st.indexExit} (see ${st.indexLog}); review ${r.status}` : `review ${r.status}: ${r.counts.PASS} pass, ${r.counts.WARN} warn, ${r.counts.FAIL} fail`;
    } catch (e) {
      st.status = "FAIL";
      st.reason = `review could not run: ${(e as Error).message}`;
    }
    repos.push(st);
  }
  const status = worst(repos.map((r) => r.status));
  const finished = new Date(now()).toISOString();
  const statusFile = { kind: "myco-run-all-status", version: 1, started, finished, config: path.resolve(configFile), status, exitCode: exitCodeFor(status), repos };
  await fs.writeFile(path.join(outDir, "status.json"), JSON.stringify(statusFile, null, 2) + "\n", "utf8");
  const md = [
    `# myco run-all — ${status}`, "", `- started: ${started}`, `- finished: ${finished}`, "",
    "| status | repo | index exit | review | reason |", "|---|---|---|---|---|",
    ...repos.map((r) => `| ${r.status} | ${r.name} | ${r.indexExit ?? "-"} | ${r.review ?? "-"} | ${r.reason.replace(/\|/g, "\\|")} |`),
    "",
    ...repos.filter((r) => r.failing.length > 0).flatMap((r) => [`## ${r.name}`, "", ...r.failing.map((f) => `- ${f.replace(/[\r\n]+/g, " ")}`), ""]),
  ].join("\n");
  await fs.writeFile(path.join(outDir, "status.md"), md + "\n", "utf8");
  const history = { at: finished, status, repos: Object.fromEntries(repos.map((r) => [r.name, r.status])) };
  await fs.appendFile(path.join(outDir, "history.jsonl"), JSON.stringify(history) + "\n", "utf8");
  return { status, exitCode: exitCodeFor(status), outDir, repos };
}
