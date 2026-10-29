// check.ts — `myco check` (alias `myco review`): a passive, deterministic review
// of an index and its results tree. Fixed rules, no AI, no network, no tokens.
//
// Inputs (all under <root>/.myco): the stored index (index.json or
// index-manifest.json + shards), index-coverage.json (written by `myco index`),
// and results/<query>/ folders written by search and compare. Plus `git ls-files`
// for the tracked-file comparison.
//
// Outputs (default <root>/.myco/review/): review.md (human), review.json
// (machine), baseline.json (stable: no timestamps, so it only changes when a
// reviewed fact changes; the next run diffs against it).
//
// Every check yields PASS / WARN / FAIL with a plain reason. Exit code: 0 all
// PASS, 1 any WARN, 2 any FAIL (or the review itself could not run).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { INDEX_DIR, INDEX_FILE, MANIFEST_FILE, loadGraphOutcome } from "../graph/store.ts";
import { git } from "../query/branches.ts";
import { currentHead, readIndexCoverage } from "./coverage-file.ts";
import type { IndexCoverageFile } from "./coverage-file.ts";

export type Level = "PASS" | "WARN" | "FAIL";
export interface Check { id: string; title: string; status: Level; reason: string; details: string[]; }
export interface Threshold { warnAbove: number | null; failAbove: number | null; }

export interface ReviewRules {
  unexplainedMissing: Threshold;
  gapGrowth: Threshold;
  unreadable: Threshold;
  overSize: Threshold;
  refused: Threshold;
  withheldSecretGrowth: Threshold;
  newSymlinks: Threshold;
  indexAgeHours: Threshold;
  staleHead: Level;
  secretGuardOff: Level;
  missingCoverageFile: Level;
  resultLimit: number;
  cappedResults: Level;
  emptyResults: Level;
  uncoveredTargets: Level;
  unreadableTargets: Level;
  regression: Level;
  maxDetails: number;
}

export const DEFAULT_RULES: Readonly<ReviewRules> = Object.freeze({
  unexplainedMissing: { warnAbove: null, failAbove: 0 },
  gapGrowth: { warnAbove: 0, failAbove: null },
  unreadable: { warnAbove: 0, failAbove: null },
  overSize: { warnAbove: 0, failAbove: null },
  refused: { warnAbove: 0, failAbove: null },
  withheldSecretGrowth: { warnAbove: 0, failAbove: null },
  newSymlinks: { warnAbove: 0, failAbove: null },
  indexAgeHours: { warnAbove: 24, failAbove: null },
  staleHead: "WARN",
  secretGuardOff: "WARN",
  missingCoverageFile: "WARN",
  resultLimit: 1000,
  cappedResults: "WARN",
  emptyResults: "WARN",
  uncoveredTargets: "WARN",
  unreadableTargets: "FAIL",
  regression: "WARN",
  maxDetails: 20,
});

const THRESHOLD_KEYS = ["unexplainedMissing", "gapGrowth", "unreadable", "overSize", "refused", "withheldSecretGrowth", "newSymlinks", "indexAgeHours"] as const;
const LEVEL_KEYS = ["staleHead", "secretGuardOff", "missingCoverageFile", "cappedResults", "emptyResults", "uncoveredTargets", "unreadableTargets", "regression"] as const;
const NUMBER_KEYS = ["resultLimit", "maxDetails"] as const;

const RANK: Record<Level, number> = { PASS: 0, WARN: 1, FAIL: 2 };
export const worst = (levels: Level[]): Level => levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), "PASS");
export const exitCodeFor = (l: Level): number => RANK[l];

/** Threshold rule: value > failAbove → FAIL, else value > warnAbove → WARN, else PASS. null = never. */
export function levelFor(value: number, t: Threshold): Level {
  if (t.failAbove !== null && value > t.failAbove) return "FAIL";
  if (t.warnAbove !== null && value > t.warnAbove) return "WARN";
  return "PASS";
}

// ---------------------------------------------------------------------------
// Rules loading. Unknown keys and wrong types are errors: a typo in a rules file
// must never silently fall back to a default.

export function mergeRules(partial: unknown, source: string): ReviewRules {
  const out: ReviewRules = JSON.parse(JSON.stringify(DEFAULT_RULES)) as ReviewRules;
  if (partial === undefined) return out;
  if (typeof partial !== "object" || partial === null || Array.isArray(partial)) throw new Error(`${source}: review rules must be a JSON object`);
  for (const [k, v] of Object.entries(partial as Record<string, unknown>)) {
    if (k === "$comment") continue;
    if ((THRESHOLD_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== "object" || v === null) throw new Error(`${source}: ${k} must be {"warnAbove": n|null, "failAbove": n|null}`);
      const t = { ...(out[k as (typeof THRESHOLD_KEYS)[number]]) };
      for (const [tk, tv] of Object.entries(v as Record<string, unknown>)) {
        if (tk !== "warnAbove" && tk !== "failAbove") throw new Error(`${source}: ${k}.${tk} is not a threshold key`);
        if (tv !== null && (typeof tv !== "number" || !Number.isFinite(tv))) throw new Error(`${source}: ${k}.${tk} must be a number or null`);
        t[tk] = tv as number | null;
      }
      out[k as (typeof THRESHOLD_KEYS)[number]] = t;
    } else if ((LEVEL_KEYS as readonly string[]).includes(k)) {
      if (v !== "PASS" && v !== "WARN" && v !== "FAIL") throw new Error(`${source}: ${k} must be "PASS", "WARN" or "FAIL"`);
      out[k as (typeof LEVEL_KEYS)[number]] = v;
    } else if ((NUMBER_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${source}: ${k} must be a positive integer`);
      out[k as (typeof NUMBER_KEYS)[number]] = v;
    } else {
      throw new Error(`${source}: unknown review rule "${k}"`);
    }
  }
  return out;
}

/** Rules source order: explicit --rules file, .myco/review-rules.json, myco.config.json "review", defaults. */
export async function loadRules(root: string, explicit?: string): Promise<{ rules: ReviewRules; source: string }> {
  const tryRead = async (p: string): Promise<string | null> => fs.readFile(p, "utf8").catch(() => null);
  if (explicit !== undefined) {
    const text = await tryRead(explicit);
    if (text === null) throw new Error(`rules file not found: ${explicit}`);
    return { rules: mergeRules(parseJson(text, explicit), explicit), source: explicit };
  }
  const local = path.join(root, INDEX_DIR, "review-rules.json");
  const lt = await tryRead(local);
  if (lt !== null) return { rules: mergeRules(parseJson(lt, local), local), source: ".myco/review-rules.json" };
  const cfg = path.join(root, "myco.config.json");
  const ct = await tryRead(cfg);
  if (ct !== null) {
    const parsed = parseJson(ct, cfg) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && "review" in parsed) {
      return { rules: mergeRules(parsed["review"], `${cfg} (review)`), source: "myco.config.json" };
    }
  }
  return { rules: mergeRules(undefined, "defaults"), source: "defaults" };
}

function parseJson(text: string, source: string): unknown {
  try { return JSON.parse(text); } catch (e) { throw new Error(`${source}: invalid JSON (${(e as Error).message})`); }
}

// ---------------------------------------------------------------------------
// Baseline (stable: sorted, no timestamps)

export interface Baseline {
  kind: "myco-review-baseline";
  version: 1;
  metrics: { tracked: number | null; indexed: number | null; gap: number | null; unexplained: number | null; unreadable: number; overSize: number; withheldSecretFiles: number; resultsFolders: number; };
  symlinks: string[];
  checks: Record<string, Level>;
}

async function readBaseline(file: string): Promise<Baseline | null> {
  try {
    const b = JSON.parse(await fs.readFile(file, "utf8")) as Baseline;
    return b.kind === "myco-review-baseline" && b.version === 1 ? b : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

export interface ReviewOptions { rules?: ReviewRules; rulesSource?: string; outDir?: string; baselineFile?: string; now?: number; write?: boolean; }
export interface ReviewResult {
  kind: "myco-review"; version: 1; root: string; generatedAt: string; rulesSource: string;
  status: Level; exitCode: number; counts: Record<Level, number>; checks: Check[];
  outDir: string; baseline: Baseline;
}

const posix = (p: string): string => p.replace(/\\/g, "/");

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

function cap(list: string[], max: number): string[] {
  return list.length <= max ? list : [...list.slice(0, max), `… and ${list.length - max} more`];
}

async function gitList(root: string, args: string[]): Promise<string[] | null> {
  const r = await git(root, args);
  if (r.code !== 0) return null;
  return r.stdout.split("\0").filter((s) => s !== "").map(posix);
}

export async function reviewRepo(rootIn: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
  const root = path.resolve(rootIn);
  const rules = opts.rules ?? mergeRules(undefined, "defaults");
  const max = rules.maxDetails;
  const now = opts.now ?? Date.now();
  const outDir = opts.outDir ?? path.join(root, INDEX_DIR, "review");
  const baselineFile = opts.baselineFile ?? path.join(outDir, "baseline.json");
  const prev = await readBaseline(baselineFile);
  const checks: Check[] = [];
  const add = (id: string, title: string, status: Level, reason: string, details: string[] = []): void => {
    checks.push({ id, title, status, reason, details: cap(details, max) });
  };

  // 1. index present and loadable ------------------------------------------
  const loaded = await loadGraphOutcome(root);
  if (loaded.status === "ok") {
    add("index.present", "Index present and loadable", "PASS", `index loads: ${loaded.meta.fileCount} file(s), built ${new Date(loaded.meta.createdAt).toISOString()}`);
  } else if (loaded.status === "absent") {
    add("index.present", "Index present and loadable", "FAIL", `no index at ${INDEX_DIR}/ — run: myco index`);
  } else {
    add("index.present", "Index present and loadable", "FAIL", "an index exists but the loader REFUSED it (malformed, tampered or incompatible) — delete .myco index files and run: myco index");
  }

  // 2. shard integrity ------------------------------------------------------
  const idir = path.join(root, INDEX_DIR);
  const names = await fs.readdir(idir).catch(() => [] as string[]);
  if (names.includes(MANIFEST_FILE)) {
    const problems: string[] = [];
    let manifest: { shards?: Array<{ name?: unknown; sha256?: unknown; bytes?: unknown }> } | null = null;
    try { manifest = JSON.parse(await fs.readFile(path.join(idir, MANIFEST_FILE), "utf8")); } catch { problems.push(`${MANIFEST_FILE}: not valid JSON`); }
    const listed = new Set<string>();
    for (const e of manifest?.shards ?? []) {
      const name = String(e.name);
      listed.add(name);
      if (!/^index-\d{3,}\.json$/.test(name)) { problems.push(`manifest entry has an invalid shard name: ${name}`); continue; }
      let bytes: Buffer;
      try { bytes = await fs.readFile(path.join(idir, name)); } catch { problems.push(`${name}: listed in manifest but MISSING`); continue; }
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== e.sha256) problems.push(`${name}: sha256 mismatch (manifest ${String(e.sha256).slice(0, 12)}…, on disk ${sha.slice(0, 12)}…)`);
      if (bytes.length !== e.bytes) problems.push(`${name}: byte length ${bytes.length} != manifest ${String(e.bytes)}`);
    }
    if (manifest !== null && (manifest.shards ?? []).length === 0) problems.push("manifest lists no shards");
    const orphans = names.filter((n) => /^index-\d{3,}\.json$/.test(n) && !listed.has(n));
    if (problems.length > 0) add("index.integrity", "Shard sha256 integrity", "FAIL", `${problems.length} shard problem(s) — the index cannot be trusted`, problems);
    else if (orphans.length > 0) add("index.integrity", "Shard sha256 integrity", "WARN", `${listed.size} shard(s) verified; ${orphans.length} orphan shard file(s) not in the manifest`, orphans);
    else add("index.integrity", "Shard sha256 integrity", "PASS", `${listed.size} shard(s), every sha256 and byte length matches the manifest`);
  } else if (names.includes(INDEX_FILE)) {
    add("index.integrity", "Shard sha256 integrity", "PASS", "single-file (legacy) layout — no shards to verify; the loader validates index.json");
  } else {
    add("index.integrity", "Shard sha256 integrity", "PASS", "no stored index — nothing to verify (see index.present)");
  }

  // 3. coverage file ----------------------------------------------------------
  const cov = await readIndexCoverage(root);
  const covOk: IndexCoverageFile | null = typeof cov === "object" ? cov : null;
  if (covOk) add("index.coverage-file", "Index coverage summary on disk", "PASS", `${INDEX_DIR}/index-coverage.json from ${new Date(covOk.createdAt).toISOString()}`);
  else if (cov === "invalid") add("index.coverage-file", "Index coverage summary on disk", "FAIL", `${INDEX_DIR}/index-coverage.json is malformed`);
  else add("index.coverage-file", "Index coverage summary on disk", rules.missingCoverageFile, `${INDEX_DIR}/index-coverage.json is missing — the index predates \`myco check\`; re-run: myco index`);

  // 4. indexed vs git ---------------------------------------------------------
  let tracked: string[] | null = null;
  let gap: number | null = null;
  let unexplainedCount: number | null = null;
  const indexed = loaded.status === "ok" ? new Set([...loaded.graph.files()].map((f) => posix(f.path))) : null;
  const pinned = covOk?.pinnedCommit ?? null;
  tracked = pinned
    ? await gitList(root, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", pinned])
    : await gitList(root, ["ls-files", "-z", "--cached"]);
  if (tracked !== null) tracked = tracked.filter((p) => p !== ".myco" && !p.startsWith(".myco/"));
  if (tracked === null) {
    add("index.vs-git", "Indexed files vs git ls-files", "PASS", "not a git repository — nothing to compare against");
  } else if (indexed === null) {
    add("index.vs-git", "Indexed files vs git ls-files", "FAIL", `${tracked.length} tracked file(s) but no loadable index`);
  } else {
    const deleted = pinned ? new Set<string>() : new Set(await gitList(root, ["ls-files", "-z", "--deleted"]) ?? []);
    const ignoredTracked = covOk && !covOk.options.includeTrackedIgnored
      ? new Set(await gitList(root, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]) ?? [])
      : new Set<string>();
    const l = covOk?.lists;
    const symlinks = new Set(l?.symlinks ?? []);
    const submodules = new Set(l?.submodules ?? []);
    const unreadable = new Set(l?.unreadable ?? []);
    const vendored = (l?.vendoredDirs ?? []).map((d) => d.replace(/\/+$/, "") + "/");
    const why = { symlink: 0, submodule: 0, vendored: 0, unreadable: 0, deleted: 0, "tracked-ignored excluded": 0 };
    const unexplained: string[] = [];
    let missing = 0;
    for (const p of tracked) {
      if (indexed.has(p)) continue;
      missing++;
      if (symlinks.has(p)) why.symlink++;
      else if (submodules.has(p)) why.submodule++;
      else if (vendored.some((v) => p.startsWith(v))) why.vendored++;
      else if (unreadable.has(p)) why.unreadable++;
      else if (deleted.has(p)) why.deleted++;
      else if (ignoredTracked.has(p)) why["tracked-ignored excluded"]++;
      else unexplained.push(p);
    }
    const trackedSet = new Set(tracked);
    const untracked = [...indexed].filter((p) => !trackedSet.has(p)).length;
    gap = missing;
    unexplainedCount = unexplained.length;
    const explainedText = Object.entries(why).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ") || "none";
    add(
      "index.vs-git",
      "Indexed files vs git ls-files",
      levelFor(unexplained.length, rules.unexplainedMissing),
      `${tracked.length - missing} of ${tracked.length} ${pinned ? `files at pinned ${pinned.slice(0, 12)}` : "tracked files"} indexed; gap ${missing} `
        + `(explained: ${explainedText}; UNEXPLAINED: ${unexplained.length}); ${untracked} untracked/extra file(s) also indexed`,
      unexplained.map((p) => `not indexed, no recorded reason: ${p}`),
    );
  }

  // 5. gap growth -----------------------------------------------------------
  if (gap === null) add("index.gap-growth", "Gap growth since last run", "PASS", "no gap measured this run (see index.vs-git)");
  else if (!prev || prev.metrics.gap === null) add("index.gap-growth", "Gap growth since last run", "PASS", `no previous baseline — gap ${gap} recorded as the baseline`);
  else {
    const growth = gap - prev.metrics.gap;
    add("index.gap-growth", "Gap growth since last run", levelFor(growth, rules.gapGrowth), `gap ${prev.metrics.gap} → ${gap} (${growth >= 0 ? "+" : ""}${growth})`);
  }

  // 6–7. unreadable / over-size ---------------------------------------------
  const lists = covOk?.lists;
  const unreadableN = lists?.unreadable.length ?? 0;
  const overSizeN = lists?.overSize.length ?? 0;
  add("index.unreadable", "Files unreadable during indexing", levelFor(unreadableN, rules.unreadable),
    covOk ? `${unreadableN} file(s) could not be read and are NOT indexed` : "unknown (no coverage file)", lists?.unreadable ?? []);
  add("index.skipped", "Files skipped (over-size / vendored / binary)", levelFor(overSizeN, rules.overSize),
    covOk ? `${overSizeN} over-size file(s) name-indexed only (content NOT searchable); ${lists!.vendoredDirs.length} vendored dir(s) skipped; ${covOk.stats.skippedBinary} binary file(s) name-only`
      : "unknown (no coverage file)",
    [...(lists?.overSize ?? []).map((p) => `over-size: ${p}`), ...(lists?.vendoredDirs ?? []).map((p) => `vendored dir: ${p}`)]);

  // 8. secret guard ----------------------------------------------------------
  const withheldFiles = lists?.withheldSecret.length ?? 0;
  if (!covOk) add("index.secret-guard", "Secret guard", "PASS", "unknown (no coverage file)");
  else if (!covOk.options.withholdSecrets) add("index.secret-guard", "Secret guard", rules.secretGuardOff, "secret guard was OFF (--no-secret-guard): secret-looking terms may be stored in .myco");
  else {
    const growth = prev ? withheldFiles - prev.metrics.withheldSecretFiles : 0;
    add("index.secret-guard", "Secret guard", levelFor(growth, rules.withheldSecretGrowth),
      `guard on: ${covOk.stats.withheldSecretTerms} secret-looking term(s) withheld this run; ${withheldFiles} indexed file(s) carry withheld terms${prev ? ` (${growth >= 0 ? "+" : ""}${growth} file(s) since last run)` : ""}; values are never stored or printed`,
      lists!.withheldSecret);
  }

  // 9. symlinks ---------------------------------------------------------------
  const symlinkList = lists?.symlinks ?? [];
  const prevSym = new Set(prev?.symlinks ?? []);
  const newSym = prev ? symlinkList.filter((s) => !prevSym.has(s)) : [];
  add("index.symlinks", "Symlinks listed (never followed)", levelFor(newSym.length, rules.newSymlinks),
    `${symlinkList.length} symlink(s) listed, target content not indexed${prev ? `; ${newSym.length} new since last run` : ""}`,
    [...newSym.map((s) => `NEW: ${s}`), ...symlinkList.filter((s) => !newSym.includes(s))]);

  // 10. staleness ------------------------------------------------------------
  const head = await currentHead(root);
  if (!covOk) add("index.stale", "Index vs HEAD", "PASS", "unknown (no coverage file)");
  else if (head === null) add("index.stale", "Index vs HEAD", "PASS", "not a git repository");
  else if (pinned) add("index.stale", "Index vs HEAD", "PASS", `pinned index at ${pinned.slice(0, 12)} (HEAD ${head.slice(0, 12)}) — pinning is deliberate`);
  else if (covOk.head !== head) add("index.stale", "Index vs HEAD", rules.staleHead, `index built at ${covOk.head ? covOk.head.slice(0, 12) : "(no commit)"}, HEAD is now ${head.slice(0, 12)} — re-run: myco index`);
  else add("index.stale", "Index vs HEAD", "PASS", `index built at HEAD ${head.slice(0, 12)}`);
  if (covOk) {
    const hours = Math.max(0, (now - covOk.createdAt) / 3_600_000);
    add("index.age", "Index age", levelFor(hours, rules.indexAgeHours), `index is ${hours.toFixed(1)} hour(s) old`);
  }

  // 11. results tree ----------------------------------------------------------
  const resultsFolders = await reviewResults(root, rules, add);

  // 12. regression vs baseline ------------------------------------------------
  const statusNow: Record<string, Level> = {};
  for (const c of checks) statusNow[c.id] = c.status;
  if (prev) {
    const worse = Object.entries(statusNow).filter(([id, s]) => RANK[s] > RANK[prev.checks[id] ?? "PASS"]);
    const better = Object.entries(statusNow).filter(([id, s]) => prev.checks[id] !== undefined && RANK[s] < RANK[prev.checks[id]!]);
    add("review.regression", "Change since last baseline", worse.length > 0 ? rules.regression : "PASS",
      worse.length > 0 ? `${worse.length} check(s) got worse since the last run` : `no check got worse since the last run${better.length ? ` (${better.length} improved)` : ""}`,
      [...worse.map(([id, s]) => `worse: ${id} ${prev.checks[id] ?? "PASS"} → ${s}`), ...better.map(([id, s]) => `better: ${id} ${prev.checks[id]} → ${s}`)]);
  } else {
    add("review.regression", "Change since last baseline", "PASS", "first run — baseline created");
  }

  const status = worst(checks.map((c) => c.status));
  const counts: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const c of checks) counts[c.status]++;
  const baseline: Baseline = {
    kind: "myco-review-baseline",
    version: 1,
    metrics: {
      tracked: tracked?.length ?? null,
      indexed: indexed?.size ?? null,
      gap,
      unexplained: unexplainedCount,
      unreadable: unreadableN,
      overSize: overSizeN,
      withheldSecretFiles: withheldFiles,
      resultsFolders,
    },
    symlinks: [...symlinkList].sort(),
    checks: Object.fromEntries(Object.entries(statusNow).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
  const result: ReviewResult = {
    kind: "myco-review", version: 1, root, generatedAt: new Date(now).toISOString(), rulesSource: opts.rulesSource ?? "defaults",
    status, exitCode: exitCodeFor(status), counts, checks, outDir, baseline,
  };
  if (opts.write !== false) {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "review.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
    await fs.writeFile(path.join(outDir, "review.md"), renderReviewMarkdown(result), "utf8");
    await fs.mkdir(path.dirname(baselineFile), { recursive: true });
    await fs.writeFile(baselineFile, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Results tree

type Add = (id: string, title: string, status: Level, reason: string, details?: string[]) => void;

async function readJson(p: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return undefined; }
}

async function lineCount(p: string): Promise<number | null> {
  try {
    const t = await fs.readFile(p, "utf8");
    if (t === "") return 0;
    return t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
  } catch {
    return null;
  }
}

async function reviewResults(root: string, rules: ReviewRules, add: Add): Promise<number> {
  const rdir = path.join(root, INDEX_DIR, "results");
  let folders: string[];
  try {
    folders = (await fs.readdir(rdir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    add("results.present", "Results tree", "PASS", "no .myco/results yet — nothing to review");
    return 0;
  }
  const missingSummary: string[] = [];
  const counts: string[] = [];
  const countProblems: string[] = [];
  const capped: string[] = [];
  const empty: string[] = [];
  const uncovered: string[] = [];
  const coveredLines: string[] = [];
  const unreadable: string[] = [];
  const refused: string[] = [];
  const compareProblems: string[] = [];
  let searches = 0;
  let compares = 0;

  for (const q of folders) {
    const qdir = path.join(rdir, q);
    const hasMd = await exists(path.join(qdir, "summary.md"));
    const summary = await readJson(path.join(qdir, "summary.json")) as Record<string, unknown> | undefined;
    if (!hasMd) missingSummary.push(`${q}: summary.md missing`);
    if (summary === undefined || typeof summary !== "object" || summary === null) { missingSummary.push(`${q}: summary.json missing or not valid JSON`); continue; }
    const cov = summary["coverage"] as { limited?: unknown; branches?: { searched: number; total: number }; worktrees?: { searched: number; total: number }; refused?: string[] } | undefined;
    if (cov) {
      const b = cov.branches ?? { searched: 0, total: 0 };
      const w = cov.worktrees ?? { searched: 0, total: 0 };
      coveredLines.push(`${q}: branches ${b.searched}/${b.total}, worktrees ${w.searched}/${w.total}${cov.limited ? " (LIMITED run)" : ""}`);
      if (cov.limited || b.searched < b.total || w.searched < w.total) {
        uncovered.push(`${q}: branches ${b.searched}/${b.total}, worktrees ${w.searched}/${w.total}${cov.limited ? " — LIMITED by --branch/--worktree" : ""}`);
      }
      for (const r of cov.refused ?? []) refused.push(`${q}: ${r}`);
    }
    if (Array.isArray(summary["rows"])) {
      compares++;
      for (const f of ["thread.md", "thread.json"]) if (!(await exists(path.join(qdir, f)))) compareProblems.push(`${q}: ${f} missing`);
      for (const row of summary["rows"] as Array<{ token?: string; state?: string; detail?: string }>) {
        const tok = String(row.token);
        const tdir = path.join(qdir, tok);
        if (!(await exists(tdir))) { compareProblems.push(`${q}/${tok}: target folder missing`); continue; }
        const result = await fs.readFile(path.join(tdir, "result.txt"), "utf8").catch(() => null);
        if (result === null) compareProblems.push(`${q}/${tok}: result.txt missing`);
        else if (result.split(/[\s]/)[0] !== row.state) compareProblems.push(`${q}/${tok}: result.txt says "${result.trim()}" but summary says ${String(row.state)}`);
        if (row.state === "changed") {
          const patch = await fs.readFile(path.join(tdir, "diff.patch"), "utf8").catch(() => null);
          if (patch === null) compareProblems.push(`${q}/${tok}: state changed but diff.patch missing`);
          else if (!patch.startsWith("# myco compare ")) compareProblems.push(`${q}/${tok}: diff.patch lacks the "# myco compare" header`);
          else if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(patch)) compareProblems.push(`${q}/${tok}: diff.patch has no unified-diff hunk`);
        } else if (row.state === "error") {
          if (!(await exists(path.join(tdir, "ERROR.txt")))) compareProblems.push(`${q}/${tok}: error row without ERROR.txt`);
          unreadable.push(`${q}/${tok}: ${row.detail ?? "error"}`);
        }
      }
      counts.push(`${q} (compare): ${(summary["rows"] as unknown[]).length} target(s)`);
    } else if (Array.isArray(summary["targets"])) {
      searches++;
      const targets = summary["targets"] as Array<{ token?: string; status?: string; hits?: number; error?: string }>;
      let total = 0;
      const seen = new Set<string>();
      for (const t of targets) {
        const tok = String(t.token);
        seen.add(tok);
        const tdir = path.join(qdir, tok);
        if (!(await exists(tdir))) { countProblems.push(`${q}/${tok}: target folder missing`); continue; }
        if (t.status === "error") {
          unreadable.push(`${q}/${tok}: ${t.error ?? "error"}`);
          if (!(await exists(path.join(tdir, "ERROR.txt")))) countProblems.push(`${q}/${tok}: error target without ERROR.txt`);
          continue;
        }
        const hits = typeof t.hits === "number" ? t.hits : -1;
        const lines = await lineCount(path.join(tdir, "hits.txt"));
        if (lines === null) countProblems.push(`${q}/${tok}: hits.txt missing`);
        else if (lines !== hits) countProblems.push(`${q}/${tok}: hits.txt has ${lines} line(s) but summary says ${hits}`);
        total += Math.max(0, hits);
        if (hits >= rules.resultLimit) capped.push(`${q}/${tok}: ${hits} hit(s) ≥ limit ${rules.resultLimit} — results may be truncated`);
      }
      const onDisk = (await fs.readdir(qdir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      for (const d of onDisk) if (!seen.has(d)) countProblems.push(`${q}/${d}: folder on disk not listed in summary.json`);
      counts.push(`${q} (search ${JSON.stringify(summary["pattern"])}): ${targets.length} target(s), ${total} hit(s)`);
      if (total === 0 && targets.length > 0) empty.push(`${q}: 0 hits across ${targets.length} target(s)`);
    } else {
      missingSummary.push(`${q}: summary.json is neither a search nor a compare summary`);
    }
  }

  add("results.summaries", "Every results folder has summary.md + summary.json", missingSummary.length ? "FAIL" : "PASS",
    missingSummary.length ? `${missingSummary.length} problem(s) in ${folders.length} folder(s)` : `${folders.length} folder(s) (${searches} search, ${compares} compare), all summaries present`, missingSummary);
  add("results.counts", "Result counts consistent", countProblems.length ? "FAIL" : "PASS",
    countProblems.length ? `${countProblems.length} inconsistency(ies) between summary.json and the files` : `${searches} search folder(s): hits.txt line counts match summary.json`, [...countProblems, ...counts]);
  add("results.capped", "Folders capped at the limit", capped.length ? rules.cappedResults : "PASS",
    capped.length ? `${capped.length} target(s) reached the result limit (${rules.resultLimit})` : `no target reached the result limit (${rules.resultLimit})`, capped);
  add("results.empty", "Empty results", empty.length ? rules.emptyResults : "PASS",
    empty.length ? `${empty.length} search(es) returned 0 hits everywhere — confirm that absence is expected` : "every search folder has at least one hit", empty);
  add("results.coverage", "Branches/worktrees covered vs skipped", uncovered.length ? rules.uncoveredTargets : "PASS",
    uncovered.length ? `${uncovered.length} folder(s) did not cover every branch/worktree` : "every results folder covered all branches and worktrees", [...uncovered, ...coveredLines.filter((l) => !uncovered.some((u) => u.startsWith(l.split(":")[0]! + ":")))]);
  add("results.unreadable", "Unreadable branch/worktree targets", unreadable.length ? rules.unreadableTargets : "PASS",
    unreadable.length ? `${unreadable.length} target(s) could not be read` : "every target was read", unreadable);
  add("results.refused", "Refused (regex guard etc.)", levelFor(refused.length, rules.refused),
    `${refused.length} refusal(s) recorded in results coverage`, refused);
  add("compare.wellformed", "Compare/diff outputs well-formed", compareProblems.length ? "FAIL" : "PASS",
    compareProblems.length ? `${compareProblems.length} malformed compare output(s)` : `${compares} compare folder(s) well-formed`, compareProblems);
  return folders.length;
}

// ---------------------------------------------------------------------------

function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function renderReviewMarkdown(r: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`# myco review — ${r.status}`);
  lines.push("");
  lines.push(`- root: \`${r.root}\``);
  lines.push(`- generated: ${r.generatedAt}`);
  lines.push(`- rules: ${r.rulesSource}`);
  lines.push(`- result: ${r.counts.PASS} PASS, ${r.counts.WARN} WARN, ${r.counts.FAIL} FAIL (exit ${r.exitCode})`);
  lines.push("");
  lines.push("| status | check | reason |");
  lines.push("|---|---|---|");
  for (const c of r.checks) lines.push(`| ${c.status} | ${c.id} | ${mdCell(c.reason)} |`);
  const detailed = r.checks.filter((c) => c.details.length > 0 && c.status !== "PASS");
  if (detailed.length > 0) {
    lines.push("");
    lines.push("## Details");
    for (const c of detailed) {
      lines.push("");
      lines.push(`### ${c.status} ${c.id} — ${c.title}`);
      lines.push("");
      for (const d of c.details) lines.push(`- ${mdCell(d)}`);
    }
  }
  lines.push("");
  lines.push("Deterministic rules only (no AI). Exit: 0 PASS, 1 WARN, 2 FAIL.");
  lines.push("");
  return lines.join("\n");
}

export function renderReviewText(r: ReviewResult): string {
  const out = [`myco review: ${r.status} (${r.counts.PASS} pass, ${r.counts.WARN} warn, ${r.counts.FAIL} fail)`];
  for (const c of r.checks) out.push(`  ${c.status.padEnd(4)} ${c.id.padEnd(20)} ${c.reason}`);
  out.push(`  wrote ${path.join(r.outDir, "review.md")} and review.json`);
  return out.join("\n");
}
