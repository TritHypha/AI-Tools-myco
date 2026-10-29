// branches.ts — the "results tree": search / compare across every local branch
// and every worktree of a git app, WITHOUT checking anything out.
//
// Branch content is read from git objects at the branch's commit (`git grep
// <commit>`, `git rev-parse <commit>:<path>`, `git diff <a>:<p> <b>:<p>`).
// Worktree content is read from that worktree's files on disk.
//
// Results land under <root>/.myco/results/<query-token>/<target-token>/ with one
// folder per branch (branch__<name>) and per worktree (worktree__<path>). Every
// token is a reversible, collision-free percent-encoding (decodeToken) and each
// folder also carries target.json with the exact name. Nothing is bounded
// silently: a target that cannot be read is recorded with its error in
// summary.json / summary.md and reported by the CLI.
//
// All git output that carries paths is read NUL-separated (-z), and every path
// argument goes after `--` as a :(literal) pathspec, so spaces, unicode,
// newlines, quotes, backslashes, leading '-' and glob characters are exact.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { MatchMode } from "./search.ts";
import { terminalData } from "../util/terminal.ts";

export interface GitResult { code: number; stdout: string; stderr: string; }

function runGit(cwd: string, args: string[], encoding: "utf8" | "buffer"): Promise<{ code: number; stdout: string | Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", "-C", cwd, ...args],
      { maxBuffer: 1024 * 1024 * 1024, encoding, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 128) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: String(stderr ?? "") });
      },
    );
  });
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  const r = await runGit(cwd, args, "utf8");
  return { code: r.code, stdout: String(r.stdout), stderr: r.stderr };
}

async function gitBuffer(cwd: string, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const r = await runGit(cwd, args, "buffer");
  return { code: r.code, stdout: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout), stderr: r.stderr };
}

/** Exact-path pathspec: no glob, no magic, safe for any filename. */
export function literal(p: string): string {
  return `:(literal)${p}`;
}

// ---------------------------------------------------------------------------
// Tokens

const TOKEN_KEEP = /^[a-z0-9._-]$/;
const MAX_TOKEN = 200;

/**
 * Reversible, collision-free folder token. UTF-8 bytes outside [a-z0-9._-] are
 * percent-encoded (%XX, upper-case hex). Upper-case ASCII is encoded too, so
 * names that differ only by case never share a folder on a case-insensitive
 * filesystem (Windows, macOS). A trailing '.' is encoded (Windows strips it),
 * and so is a name that is all dots. Tokens longer than MAX_TOKEN are cut on an
 * escape boundary and suffixed with `~<sha256-16>`; the exact name is then in
 * the folder's target.json (decodeToken reports such tokens as hashed).
 */
export function encodeToken(raw: string): string {
  let out = "";
  for (const byte of Buffer.from(raw, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && TOKEN_KEEP.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (out === "") return "%00empty";
  if (/^\.+$/.test(out)) out = out.replace(/\./g, "%2E");
  if (out.endsWith(".")) out = `${out.slice(0, -1)}%2E`;
  if (out.length > MAX_TOKEN) {
    let cut = MAX_TOKEN - 18;
    const pct = out.lastIndexOf("%", cut);
    if (pct > cut - 3) cut = pct; // never split an escape
    const hash = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
    out = `${out.slice(0, cut)}~${hash}`;
  }
  return out;
}

/** Inverse of encodeToken. Returns null for a hashed (over-long) token. */
export function decodeToken(token: string): string | null {
  if (token === "%00empty") return "";
  if (token.includes("~")) return null;
  const bytes: number[] = [];
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "%") {
      bytes.push(Number.parseInt(token.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(token.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Back-compat name: the same reversible encoding. */
export const safeToken = encodeToken;

export function queryToken(pattern: string): string {
  const hash = createHash("sha256").update(pattern, "utf8").digest("hex").slice(0, 8);
  let body = encodeToken(pattern);
  if (body.length > 64) {
    let cut = 64;
    const pct = body.lastIndexOf("%", cut);
    if (pct > cut - 3) cut = pct;
    body = body.slice(0, cut);
  }
  return `${body}-${hash}`;
}

/** git-style C quoting for display when a path has control chars, quotes or backslashes. */
export function quotePath(p: string): string {
  if (!/[\x00-\x1f\x7f"\\]/.test(p)) return p;
  const esc: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r", '"': '\\"', "\\": "\\\\" };
  return `"${p.replace(/[\x00-\x1f\x7f"\\]/g, (c) => esc[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`)}"`;
}

// ---------------------------------------------------------------------------
// Targets

export interface Target {
  kind: "branch" | "worktree";
  name: string; // branch short name, or worktree path relative to the repo top (or absolute)
  token: string; // folder name
  commit: string; // commit sha (worktree: its HEAD, "" if unborn)
  dir?: string; // worktree absolute path
  branch?: string; // worktree's checked-out branch, if any
}

export interface TargetFilter {
  branches?: string[];
  worktrees?: string[];
}

export function filterActive(f: TargetFilter | undefined): boolean {
  return (f?.branches?.length ?? 0) > 0 || (f?.worktrees?.length ?? 0) > 0;
}

export async function repoTop(root: string): Promise<string | null> {
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  return path.resolve(top.stdout.replace(/\r?\n$/, ""));
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" || process.platform === "darwin"
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/** Parse `git worktree list --porcelain -z` (fields NUL-terminated, records split by an empty field). */
export function parseWorktreesZ(out: string): Array<{ dir: string; head: string; branch?: string; bare: boolean }> {
  const res: Array<{ dir: string; head: string; branch?: string; bare: boolean }> = [];
  let cur: { dir: string; head: string; branch?: string; bare: boolean } | null = null;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (cur) res.push(cur);
      cur = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (cur) res.push(cur);
      cur = { dir: field.slice(9), head: "", bare: false };
    } else if (cur && field.startsWith("HEAD ")) cur.head = field.slice(5);
    else if (cur && field.startsWith("branch ")) cur.branch = field.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && field === "bare") cur.bare = true;
  }
  if (cur) res.push(cur);
  return res;
}

/**
 * Every local branch and every worktree, optionally limited by --branch /
 * --worktree. A filter entry that matches nothing is an ERROR (fail closed): a
 * typo'd branch must never produce a "0 hits" that reads as absence.
 */
export async function listTargets(
  top: string,
  filter?: TargetFilter,
): Promise<{ targets: Target[]; errors: string[]; filterErrors: string[]; all: { branches: number; worktrees: number } }> {
  let targets: Target[] = [];
  const errors: string[] = [];
  const refs = await git(top, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"]);
  if (refs.code !== 0) errors.push(`branches: git for-each-ref failed: ${refs.stderr.trim()}`);
  for (const line of refs.stdout.split("\n")) {
    if (line === "") continue;
    const [full, commit] = line.split("\0");
    const name = (full ?? "").replace(/^refs\/heads\//, "");
    targets.push({ kind: "branch", name, token: `branch__${encodeToken(name)}`, commit: commit ?? "" });
  }
  const wts = await git(top, ["worktree", "list", "--porcelain", "-z"]);
  if (wts.code !== 0) errors.push(`worktrees: git worktree list failed: ${wts.stderr.trim()}`);
  for (const wt of parseWorktreesZ(wts.stdout)) {
    if (wt.bare) continue;
    const dir = path.resolve(wt.dir);
    let rel = path.relative(top, dir).split(path.sep).join("/");
    if (rel === "") rel = "root";
    else if (rel.startsWith("..") || path.isAbsolute(rel)) rel = dir;
    targets.push({
      kind: "worktree",
      name: rel,
      token: `worktree__${encodeToken(rel)}`,
      commit: wt.head,
      dir,
      ...(wt.branch ? { branch: wt.branch } : {}),
    });
  }
  const all = {
    branches: targets.filter((t) => t.kind === "branch").length,
    worktrees: targets.filter((t) => t.kind === "worktree").length,
  };
  const filterErrors: string[] = [];
  if (filterActive(filter)) {
    const keep = new Set<Target>();
    for (const b of filter?.branches ?? []) {
      const hit = targets.filter((t) => t.kind === "branch" && t.name === b);
      if (hit.length === 0) filterErrors.push(`--branch ${JSON.stringify(b)} matches no local branch`);
      hit.forEach((t) => keep.add(t));
    }
    for (const w of filter?.worktrees ?? []) {
      const hit = targets.filter((t) =>
        t.kind === "worktree" && (t.name === w || samePath(t.dir!, path.resolve(top, w)) || samePath(t.dir!, path.resolve(w))));
      if (hit.length === 0) filterErrors.push(`--worktree ${JSON.stringify(w)} matches no worktree`);
      hit.forEach((t) => keep.add(t));
    }
    targets = targets.filter((t) => keep.has(t));
  }
  // Belt and braces: encoding is injective, but a hashed (over-long) token could
  // in principle repeat. Never merge two targets into one folder.
  const seen = new Map<string, number>();
  for (const t of targets) {
    const key = t.token.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n > 0) t.token = `${t.token}~${n + 1}`;
  }
  return { targets, errors, filterErrors, all };
}

async function writeTargetJson(tdir: string, t: Target): Promise<void> {
  await fs.writeFile(
    path.join(tdir, "target.json"),
    JSON.stringify({ kind: t.kind, name: t.name, token: t.token, commit: t.commit, dir: t.dir, branch: t.branch }, null, 2) + "\n",
    "utf8",
  );
}

async function countFiles(t: Target, top: string): Promise<number | null> {
  const r = t.kind === "branch"
    ? await git(top, ["ls-tree", "-r", "-z", "--name-only", t.commit])
    : await git(t.dir!, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (r.code !== 0) return null;
  return r.stdout.split("\0").filter((s) => s !== "").length;
}

// ---------------------------------------------------------------------------
// Coverage summary (printed by every index/search/compare run, and summary.md)

export interface Coverage {
  command: "index" | "search" | "compare";
  repo: string | null;
  limited: TargetFilter | null;
  branches: { searched: number; total: number };
  worktrees: { searched: number; total: number };
  targets: Array<{ token: string; name: string; kind: string; files: number | null; status: string; note?: string }>;
  index?: { files: number; layout: string; shards: number };
  skipped: string[];
  unreadable: string[];
  refused: string[];
}

export function renderCoverage(c: Coverage): string {
  const lines: string[] = [];
  lines.push(`coverage (${c.command})${c.repo ? ` — repo ${terminalData(c.repo)}` : " — not a git repo"}`);
  if (c.limited) {
    const bits = [
      ...(c.limited.branches ?? []).map((b) => `--branch ${terminalData(b)}`),
      ...(c.limited.worktrees ?? []).map((w) => `--worktree ${terminalData(w)}`),
    ];
    lines.push(`  LIMITED run (${bits.join(", ")}): other branches/worktrees were NOT covered`);
  }
  if (c.repo) {
    lines.push(`  branches:  ${c.branches.searched} of ${c.branches.total}`);
    lines.push(`  worktrees: ${c.worktrees.searched} of ${c.worktrees.total}`);
  }
  if (c.index) lines.push(`  index: ${c.index.files} file(s), ${c.index.layout} store, ${c.index.shards} shard(s)`);
  for (const t of c.targets) {
    lines.push(`  ${terminalData(t.token)}: ${t.files ?? "?"} file(s), ${terminalData(t.status)}${t.note ? ` — ${terminalData(t.note)}` : ""}`);
  }
  lines.push(`  skipped: ${c.skipped.length === 0 ? "none" : ""}`);
  for (const s of c.skipped) lines.push(`    ${terminalData(s)}`);
  lines.push(`  unreadable: ${c.unreadable.length === 0 ? "none" : ""}`);
  for (const s of c.unreadable) lines.push(`    ${terminalData(s)}`);
  lines.push(`  refused: ${c.refused.length === 0 ? "none" : ""}`);
  for (const s of c.refused) lines.push(`    ${terminalData(s)}`);
  return lines.join("\n").replace(/: \n/g, ":\n");
}

function coverageMarkdown(title: string, c: Coverage, extra: string[]): string {
  return [`# ${title}`, "", "```", renderCoverage(c), "```", "", ...extra, ""].join("\n");
}

// ---------------------------------------------------------------------------
// Search

export interface TreeSearchOptions {
  mode: MatchMode;
  caseSensitive: boolean | "smart";
  filter?: TargetFilter;
}

function grepArgs(pattern: string, opts: TreeSearchOptions): string[] {
  const args = ["grep", "-z", "-n", "-I", "--no-color", "--full-name"];
  const sensitive = opts.caseSensitive === "smart" ? /\p{Lu}/u.test(pattern) : opts.caseSensitive;
  if (!sensitive) args.push("-i");
  if (opts.mode === "regex") args.push("-E");
  else args.push("-F");
  if (opts.mode === "word") args.push("-w");
  args.push("-e", pattern);
  return args;
}

export interface TreeHit { path: string; line: number; text: string; }

/** Parse `git grep -z -n` output: `[rev:]path\0line\0text\n` records. */
export function parseGrepZ(out: string, revPrefix: string): TreeHit[] {
  const hits: TreeHit[] = [];
  let i = 0;
  while (i < out.length) {
    const a = out.indexOf("\0", i);
    if (a < 0) break;
    const b = out.indexOf("\0", a + 1);
    if (b < 0) break;
    let nl = out.indexOf("\n", b + 1);
    if (nl < 0) nl = out.length;
    let p = out.slice(i, a);
    if (revPrefix && p.startsWith(revPrefix)) p = p.slice(revPrefix.length);
    hits.push({ path: p, line: Number.parseInt(out.slice(a + 1, b), 10), text: out.slice(b + 1, nl) });
    i = nl + 1;
  }
  return hits;
}

export interface TargetResult {
  kind: Target["kind"]; name: string; token: string; commit: string;
  status: "ok" | "error"; hits: number; files: number | null; error?: string;
}

/** Search every branch (from git objects) and worktree (from disk). */
export async function searchTree(
  root: string,
  top: string,
  pattern: string,
  opts: TreeSearchOptions,
): Promise<{ dir: string; results: TargetResult[]; errors: string[]; filterErrors: string[]; coverage: Coverage }> {
  const { targets, errors, filterErrors, all } = await listTargets(top, opts.filter);
  const qdir = path.join(root, ".myco", "results", queryToken(pattern));
  const repoName = path.basename(top);
  const coverage: Coverage = {
    command: "search",
    repo: repoName,
    limited: filterActive(opts.filter) ? opts.filter! : null,
    branches: { searched: 0, total: all.branches },
    worktrees: { searched: 0, total: all.worktrees },
    targets: [],
    skipped: ["binary files (git grep -I) in branches/worktrees"],
    unreadable: [...errors],
    refused: [...filterErrors],
  };
  if (filterErrors.length > 0) return { dir: qdir, results: [], errors, filterErrors, coverage };
  await fs.rm(qdir, { recursive: true, force: true });
  await fs.mkdir(qdir, { recursive: true });
  const results: TargetResult[] = [];
  for (const t of targets) {
    const tdir = path.join(qdir, t.token);
    await fs.mkdir(tdir, { recursive: true });
    await writeTargetJson(tdir, t);
    let res: GitResult;
    if (t.kind === "branch") {
      res = await git(top, [...grepArgs(pattern, opts), t.commit, "--", ".", ":(exclude).myco"]);
    } else {
      const exists = await fs.stat(t.dir!).then((s) => s.isDirectory(), () => false);
      res = exists
        ? await git(t.dir!, [...grepArgs(pattern, opts), "--untracked", "--", ".", ":(exclude).myco"])
        : { code: 128, stdout: "", stderr: `worktree path not readable: ${t.dir}` };
    }
    const files = res.code === 0 || res.code === 1 ? await countFiles(t, top) : null;
    // git grep: 0 = hits, 1 = none, anything else = could not read.
    if (res.code !== 0 && res.code !== 1) {
      const error = res.stderr.trim() || `git grep exited ${res.code}`;
      await fs.writeFile(path.join(tdir, "ERROR.txt"), error + "\n", "utf8");
      results.push({ kind: t.kind, name: t.name, token: t.token, commit: t.commit, status: "error", hits: 0, files, error });
      coverage.unreadable.push(`${t.token}: ${error}`);
      coverage.targets.push({ token: t.token, name: t.name, kind: t.kind, files, status: "UNREADABLE", note: error });
      continue;
    }
    const hits = parseGrepZ(res.stdout, t.kind === "branch" ? `${t.commit}:` : "");
    const short = t.commit.slice(0, 12);
    const lines = hits.map((h) => `${repoName}@${short}:${quotePath(h.path)}:${h.line}:${h.text}`);
    await fs.writeFile(path.join(tdir, "hits.txt"), lines.length ? lines.join("\n") + "\n" : "", "utf8");
    await fs.writeFile(path.join(tdir, "hits.json"), JSON.stringify({ repo: repoName, commit: t.commit, hits }, null, 2) + "\n", "utf8");
    results.push({ kind: t.kind, name: t.name, token: t.token, commit: t.commit, status: "ok", hits: hits.length, files });
    coverage.targets.push({ token: t.token, name: t.name, kind: t.kind, files, status: `${hits.length} hit(s)` });
    if (t.kind === "branch") coverage.branches.searched++;
    else coverage.worktrees.searched++;
  }
  await fs.writeFile(
    path.join(qdir, "summary.json"),
    JSON.stringify({ pattern, mode: opts.mode, repo: repoName, targets: results, errors, coverage }, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(qdir, "summary.md"),
    coverageMarkdown(`myco search ${JSON.stringify(pattern)} (${opts.mode})`, coverage, [
      "| target | name | commit | files | hits / status |",
      "|---|---|---|---|---|",
      ...results.map((r) => `| ${r.token} | ${mdCell(r.name)} | ${r.commit.slice(0, 12)} | ${r.files ?? "?"} | ${r.status === "ok" ? r.hits : `UNREADABLE: ${mdCell(r.error ?? "")}`} |`),
    ]),
    "utf8",
  );
  return { dir: qdir, results, errors, filterErrors, coverage };
}

function mdCell(s: string): string {
  return JSON.stringify(s).slice(1, -1).replace(/\|/g, "\\|");
}

// ---------------------------------------------------------------------------
// Compare

export interface CompareRow {
  kind: Target["kind"]; name: string; token: string; commit: string;
  state: "identical" | "changed" | "missing" | "error"; detail?: string;
}

/** Base ("latest"): main's HEAD, else master, else HEAD. */
export async function baseCommit(top: string): Promise<{ ref: string; commit: string } | null> {
  for (const ref of ["refs/heads/main", "refs/heads/master", "HEAD"]) {
    const r = await git(top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    if (r.code === 0) return { ref: ref.replace(/^refs\/heads\//, ""), commit: r.stdout.trim() };
  }
  return null;
}

async function blobOf(top: string, commit: string, p: string): Promise<string | null> {
  const r = await git(top, ["rev-parse", "--verify", "-q", `${commit}:${p}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** `git diff` exit 0 = same, 1 = differs; anything else is an error. */
function diffOk(code: number): boolean {
  return code === 0 || code === 1;
}

export interface ThreadEntry {
  sha: string;
  time: number;
  author: string;
  subject: string;
  branches: string[];
  hunks: Array<{ old: string; new: string }>;
}

/** Parse `git log -p -U0 --format=%x00%H%x00%ct%x00%an%x00%s` output. */
export function parseThreadLog(out: string): Array<Omit<ThreadEntry, "branches">> {
  const parts = out.split("\0");
  const res: Array<Omit<ThreadEntry, "branches">> = [];
  for (let i = 1; i + 3 < parts.length; i += 4) {
    const rest = parts[i + 3] ?? "";
    const nl = rest.indexOf("\n");
    const subject = nl < 0 ? rest : rest.slice(0, nl);
    const body = nl < 0 ? "" : rest.slice(nl + 1);
    const hunks = [...body.matchAll(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/gm)].map((m) => ({ old: m[1]!, new: m[2]! }));
    res.push({ sha: parts[i]!, time: Number(parts[i + 1]), author: parts[i + 2]!, subject, hunks });
  }
  return res;
}

function lineRange(r: string): string {
  const [start, count] = r.split(",");
  const s = Number(start);
  const n = count === undefined ? 1 : Number(count);
  if (n === 0) return `none (after line ${s})`;
  return n === 1 ? `line ${s}` : `lines ${s}-${s + n - 1}`;
}

/** Compare one repo-relative path across every branch/worktree against main HEAD. */
export async function compareTree(
  root: string,
  top: string,
  relPath: string,
  filter?: TargetFilter,
): Promise<{
  dir: string;
  base: { ref: string; commit: string } | null;
  baseMissing: boolean;
  rows: CompareRow[];
  errors: string[];
  filterErrors: string[];
  thread: ThreadEntry[];
  coverage: Coverage;
}> {
  const p = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const { targets, errors, filterErrors, all } = await listTargets(top, filter);
  const qdir = path.join(root, ".myco", "results", `compare__${queryToken(p)}`);
  const coverage: Coverage = {
    command: "compare",
    repo: path.basename(top),
    limited: filterActive(filter) ? filter! : null,
    branches: { searched: 0, total: all.branches },
    worktrees: { searched: 0, total: all.worktrees },
    targets: [],
    skipped: [],
    unreadable: [...errors],
    refused: [...filterErrors],
  };
  const base = await baseCommit(top);
  if (filterErrors.length > 0) {
    return { dir: qdir, base, baseMissing: true, rows: [], errors, filterErrors, thread: [], coverage };
  }
  await fs.rm(qdir, { recursive: true, force: true });
  await fs.mkdir(qdir, { recursive: true });
  const tmp = path.join(qdir, ".tmp");
  await fs.mkdir(tmp, { recursive: true });
  const emptyFile = path.join(tmp, "empty");
  await fs.writeFile(emptyFile, "");
  const rows: CompareRow[] = [];
  let baseBlob = "";
  let baseFile = emptyFile;
  if (base) {
    baseBlob = (await blobOf(top, base.commit, p)) ?? "";
    if (baseBlob) {
      const content = await gitBuffer(top, ["cat-file", "blob", baseBlob]);
      if (content.code === 0) {
        baseFile = path.join(tmp, "base");
        await fs.writeFile(baseFile, content.stdout);
      } else errors.push(`base blob unreadable: ${content.stderr.trim()}`);
    }
  } else {
    errors.push("no base commit (main/master/HEAD) could be resolved");
  }
  const baseLabel = base ? `${base.ref}@${base.commit.slice(0, 12)}` : "(no base)";
  for (const t of targets) {
    const tdir = path.join(qdir, t.token);
    await fs.mkdir(tdir, { recursive: true });
    await writeTargetJson(tdir, t);
    let row: CompareRow;
    let diffText: string | null = null;
    if (t.kind === "branch") {
      coverage.branches.searched++;
      const blob = await blobOf(top, t.commit, p);
      if (blob === null) {
        row = { ...pick(t), state: "missing" };
      } else if (blob === baseBlob) {
        row = { ...pick(t), state: "identical" };
      } else {
        // Git-style unified diff straight from git, blob to blob.
        const diff = baseBlob
          ? await git(top, ["diff", "--no-color", `${base!.commit}:${p}`, `${t.commit}:${p}`])
          : await git(top, ["diff", "--no-color", "--no-index", "--", emptyFile, await extract(top, blob, tmp, t.token)]);
        if (!diffOk(diff.code)) row = { ...pick(t), state: "error", detail: diff.stderr.trim() };
        else {
          diffText = diff.stdout;
          row = { ...pick(t), state: "changed", detail: baseBlob ? "diff.patch" : "absent at base; content in diff.patch" };
        }
      }
    } else {
      coverage.worktrees.searched++;
      const abs = path.join(t.dir!, ...p.split("/"));
      const exists = await fs.stat(t.dir!).then((s) => s.isDirectory(), () => false);
      if (!exists) {
        row = { ...pick(t), state: "error", detail: `worktree path not readable: ${t.dir}` };
      } else if (!(await fs.stat(abs).then((s) => s.isFile(), () => false))) {
        row = { ...pick(t), state: "missing" };
      } else {
        const h = await git(t.dir!, ["hash-object", "--", abs]);
        if (h.code !== 0) row = { ...pick(t), state: "error", detail: h.stderr.trim() };
        else if (h.stdout.trim() === baseBlob) row = { ...pick(t), state: "identical" };
        else {
          const diff = await git(t.dir!, ["diff", "--no-color", "--no-index", "--", baseFile, abs]);
          if (!diffOk(diff.code)) row = { ...pick(t), state: "error", detail: diff.stderr.trim() };
          else {
            diffText = diff.stdout;
            row = { ...pick(t), state: "changed", detail: baseBlob ? "diff.patch" : "absent at base; content in diff.patch" };
          }
        }
      }
    }
    if (diffText !== null) {
      const header = `# myco compare ${quotePath(p)}: ${baseLabel} -> ${t.token} (${t.commit.slice(0, 12)})\n`;
      await fs.writeFile(path.join(tdir, "diff.patch"), header + diffText, "utf8");
    }
    if (row.state === "error") {
      await fs.writeFile(path.join(tdir, "ERROR.txt"), (row.detail ?? "") + "\n", "utf8");
      coverage.unreadable.push(`${t.token}: ${row.detail ?? ""}`);
    }
    await fs.writeFile(path.join(tdir, "result.txt"), `${row.state}${row.detail ? ` ${row.detail}` : ""}\n`, "utf8");
    coverage.targets.push({ token: t.token, name: t.name, kind: t.kind, files: null, status: row.state, note: row.detail });
    rows.push(row);
  }

  const thread = await buildThread(top, p, base, targets);
  await fs.writeFile(path.join(qdir, "thread.json"), JSON.stringify({ path: p, thread }, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(qdir, "thread.md"), renderThread(p, thread), "utf8");
  await fs.rm(tmp, { recursive: true, force: true });

  await fs.writeFile(
    path.join(qdir, "summary.json"),
    JSON.stringify({ path: p, base, baseMissing: baseBlob === "", rows, errors, coverage }, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(qdir, "summary.md"),
    coverageMarkdown(`myco compare ${quotePath(p)} vs ${baseLabel}${baseBlob === "" ? " (absent at base)" : ""}`, coverage, [
      "| target | name | commit | state | detail |",
      "|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.token} | ${mdCell(r.name)} | ${r.commit.slice(0, 12)} | ${r.state} | ${mdCell(r.detail ?? "")} |`),
      "",
      "Per-branch line history: thread.md",
    ]),
    "utf8",
  );
  return { dir: qdir, base, baseMissing: baseBlob === "", rows, errors, filterErrors, thread, coverage };
}

async function extract(top: string, blob: string, tmp: string, name: string): Promise<string> {
  const out = path.join(tmp, `blob-${name}`);
  const r = await gitBuffer(top, ["cat-file", "blob", blob]);
  await fs.writeFile(out, r.code === 0 ? r.stdout : Buffer.alloc(0));
  return out;
}

/**
 * The 'thread' view: every commit that touched the path, ordered by commit time
 * across branches, each labelled with the branch(es) that carry it and the lines
 * it changed. main's full history for the path, plus each other branch's commits
 * not on main, plus each worktree's uncommitted change.
 */
async function buildThread(
  top: string,
  p: string,
  base: { ref: string; commit: string } | null,
  targets: Target[],
): Promise<ThreadEntry[]> {
  const bySha = new Map<string, ThreadEntry>();
  const fmt = "--format=%x00%H%x00%ct%x00%an%x00%s";
  const add = (label: string, out: string): void => {
    for (const e of parseThreadLog(out)) {
      const prev = bySha.get(e.sha);
      if (prev) {
        if (!prev.branches.includes(label)) prev.branches.push(label);
      } else bySha.set(e.sha, { ...e, branches: [label] });
    }
  };
  if (base) {
    const r = await git(top, ["log", "--no-color", "-p", "-U0", fmt, base.commit, "--", literal(p)]);
    if (r.code === 0) add(base.ref, r.stdout);
  }
  const entries: ThreadEntry[] = [];
  for (const t of targets) {
    if (t.kind === "branch") {
      if (base && t.name === base.ref) continue;
      const range = base ? `${base.commit}..${t.commit}` : t.commit;
      const r = await git(top, ["log", "--no-color", "-p", "-U0", fmt, range, "--", literal(p)]);
      if (r.code === 0) add(t.name, r.stdout);
    } else {
      const exists = await fs.stat(t.dir!).then((s) => s.isDirectory(), () => false);
      if (!exists || !t.commit) continue;
      const r = await git(t.dir!, ["diff", "--no-color", "-U0", "HEAD", "--", literal(p)]);
      if (r.code !== 0 || r.stdout === "") continue;
      const hunks = [...r.stdout.matchAll(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/gm)].map((m) => ({ old: m[1]!, new: m[2]! }));
      const st = await fs.stat(path.join(t.dir!, ...p.split("/"))).catch(() => undefined);
      entries.push({
        sha: "(uncommitted)",
        time: Math.floor((st?.mtimeMs ?? Date.now()) / 1000),
        author: "",
        subject: `uncommitted change in worktree ${t.name}`,
        branches: [t.token],
        hunks,
      });
    }
  }
  entries.push(...bySha.values());
  entries.sort((a, b) => a.time - b.time || a.sha.localeCompare(b.sha));
  return entries;
}

function renderThread(p: string, thread: ThreadEntry[]): string {
  const out = [`# Thread: ${quotePath(p)}`, "", "Every version, oldest first, across branches and worktrees.", ""];
  for (const e of thread) {
    out.push(`## ${new Date(e.time * 1000).toISOString()} ${e.sha.slice(0, 12)} [${e.branches.join(", ")}]${e.author ? ` ${e.author}` : ""}: ${e.subject}`);
    if (e.hunks.length === 0) out.push("- (no text hunks: binary, mode-only or rename)");
    for (const h of e.hunks) out.push(`- was ${lineRange(h.old)} -> now ${lineRange(h.new)}`);
    out.push("");
  }
  return out.join("\n");
}

function pick(t: Target): Pick<CompareRow, "kind" | "name" | "token" | "commit"> {
  return { kind: t.kind, name: t.name, token: t.token, commit: t.commit };
}
