// file-manifest.ts - per-file sha256 manifest of the indexed source files
// (MYCO-HARD-1 items 3 + 4).
//
// `.myco/index-files.json` is (re)written by every refresh (`myco index`, and the
// refresh a `myco search` does). It lists every file node of the stored graph
// with its byte length, mtime and the sha256 of its content (from the git object
// store when the index is pinned with --at; from disk otherwise), plus the source
// identity `repo@commit` the index was built from.
//
// Readers use it two ways:
//   - verifyFileManifest(): the stored graph and the manifest MUST agree on the
//     file count and the exact path set. Any drift (a truncated / partially
//     written / swapped index, or a manifest from another run) marks the index
//     UNUSABLE: `myco search --no-refresh` flags the result incomplete (exit 2)
//     and `myco check` FAILs. A malformed manifest is UNUSABLE too (fail closed).
//     A missing manifest is "absent" (an index that predates this file): never
//     UNUSABLE, so old indexes keep working; `myco check` reports it.
//   - probeSearch(): `myco check` picks one indexed term from a deterministic file
//     and runs a real search for it; the file must come back. A failed probe is
//     UNUSABLE.
//   - checkContentDrift(): (MYCO-HARD-1c) compare the recorded digests with the
//     content that is there now. Quick mode re-hashes only files whose byte
//     length or mtime moved; --deep re-hashes every file, which also catches an
//     edit that preserved length + mtime (or a manifest whose digests were
//     rewritten). Pinned manifests are re-verified against the blobs of the
//     commit they name. Content drift means search answers come from older
//     content (stale, `myco check` WARN); a digest that changed under unchanged
//     metadata, or a pinned digest that disagrees with its own commit, is FAIL.
// Search results cite `repo@commit:path:line` from the manifest's source (JSON
// field `citation`, additive - existing fields are unchanged).
//
// Counts + paths + digests only; never content.

import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";

import type { SearchGraph } from "../graph/model.ts";
import { INDEX_DIR } from "../graph/store.ts";
import { pinnedListing, readPinnedBlob } from "../ingest/pinned.ts";
import { currentHead } from "./coverage-file.ts";

export const FILE_MANIFEST = "index-files.json";
export const FILE_MANIFEST_KIND = "myco-file-manifest";
export const FILE_MANIFEST_VERSION = 1;
/** Files above this many bytes are listed with sha256 null (bounded refresh cost). */
export const MANIFEST_HASH_CAP_BYTES = 256 * 1024 * 1024;
/** Paths quoted in an UNUSABLE reason (the counts are always complete). */
const MAX_DRIFT_PATHS = 10;

export interface FileManifestEntry { path: string; bytes: number; mtimeMs: number; sha256: string | null; }
export interface ManifestSource { repo: string; commit: string | null; pinned: boolean; }
export interface FileManifest {
  kind: typeof FILE_MANIFEST_KIND;
  version: typeof FILE_MANIFEST_VERSION;
  createdAt: number;
  source: ManifestSource;
  fileCount: number;
  files: FileManifestEntry[];
}

export type ManifestState = "ok" | "absent" | "unusable";
export interface ManifestVerdict {
  state: ManifestState;
  reasons: string[];
  source: ManifestSource | null;
  fileCount: number | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A manifest path must be a plain repo-relative path: no absolute, UNC or drive
 * prefix, no NUL, and no empty / "." / ".." segment (split on "/" and "\\").
 * Anything else could steer a content re-hash outside the repo, so the whole
 * manifest is refused (malformed => UNUSABLE).
 */
export function isSafeManifestPath(p: string): boolean {
  if (p === "" || p.length > 4096 || p.includes("\u0000")) return false;
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:(?:[\\/]|$)/.test(p)) return false;
  // Split on both separators: a backslash is a separator on Windows, so
  // "..\x" must be refused even though it is one posix segment.
  return p.split(/[\\/]/).every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function streamSha256(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(abs).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** Build `repo@commit:path[:line]`. commit is shortened to 12 hex; null => "WORKTREE". */
export function citeOf(source: ManifestSource, relPath: string, line?: number): string {
  const at = source.commit ? source.commit.slice(0, 12) : "WORKTREE";
  return `${source.repo}@${at}:${relPath}${line !== undefined && line > 0 ? `:${line}` : ""}`;
}

export async function readFileManifest(root: string): Promise<FileManifest | "absent" | "invalid"> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, INDEX_DIR, FILE_MANIFEST), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid";
  }
  let v: unknown;
  try { v = JSON.parse(text); } catch { return "invalid"; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "invalid";
  const m = v as Record<string, unknown>;
  const src = m.source as Record<string, unknown> | undefined;
  if (
    m.kind !== FILE_MANIFEST_KIND || m.version !== FILE_MANIFEST_VERSION
    || typeof m.createdAt !== "number" || !Number.isSafeInteger(m.fileCount) || !Array.isArray(m.files)
    || typeof src !== "object" || src === null || typeof src.repo !== "string"
    || !(src.commit === null || (typeof src.commit === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(src.commit)))
    || typeof src.pinned !== "boolean"
  ) return "invalid";
  for (const e of m.files as unknown[]) {
    if (typeof e !== "object" || e === null) return "invalid";
    const f = e as Record<string, unknown>;
    if (typeof f.path !== "string" || !isSafeManifestPath(f.path) || !Number.isSafeInteger(f.bytes) || (f.bytes as number) < 0
      || typeof f.mtimeMs !== "number"
      || !(f.sha256 === null || (typeof f.sha256 === "string" && SHA256_HEX.test(f.sha256)))) return "invalid";
  }
  return v as FileManifest;
}

/**
 * Write the manifest for `graph`. Unchanged files (same bytes + mtimeMs as the
 * previous manifest, working-tree mode only) reuse their digest so a refresh
 * stays cheap; everything else is hashed. An unreadable file gets sha256 null.
 */
export async function writeFileManifest(
  root: string,
  graph: SearchGraph,
  opts: { pinnedCommit?: string | null; now?: number } = {},
): Promise<FileManifest> {
  const pinnedCommit = opts.pinnedCommit ?? null;
  const prev = pinnedCommit ? null : await readFileManifest(root);
  const prior = new Map<string, FileManifestEntry>();
  if (prev !== null && typeof prev !== "string") for (const e of prev.files) prior.set(e.path, e);
  const blobs = new Map<string, string>();
  if (pinnedCommit) for (const e of pinnedListing(root, pinnedCommit).entries) blobs.set(e.relPath, e.blob);

  const files: FileManifestEntry[] = [];
  const recs = [...graph.files()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const rec of recs) {
    let digest: string | null = null;
    const old = prior.get(rec.path);
    if (old && old.bytes === rec.size && old.mtimeMs === rec.mtimeMs && old.sha256 !== null) {
      digest = old.sha256;
    } else if (rec.size <= MANIFEST_HASH_CAP_BYTES) {
      try {
        if (pinnedCommit) {
          const blob = blobs.get(rec.path);
          digest = blob === undefined ? null : sha256(readPinnedBlob(root, blob));
        } else {
          digest = await streamSha256(path.join(root, ...rec.path.split("/")));
        }
      } catch {
        digest = null;
      }
    }
    files.push({ path: rec.path, bytes: rec.size, mtimeMs: rec.mtimeMs, sha256: digest });
  }
  const top = await gitTop(root);
  const manifest: FileManifest = {
    kind: FILE_MANIFEST_KIND,
    version: FILE_MANIFEST_VERSION,
    createdAt: opts.now ?? Date.now(),
    source: {
      repo: path.basename(top ?? path.resolve(root)),
      commit: pinnedCommit ?? (await currentHead(root)),
      pinned: pinnedCommit !== null,
    },
    fileCount: files.length,
    files,
  };
  const dir = path.join(root, INDEX_DIR);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${FILE_MANIFEST}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(manifest));
  await fs.rename(tmp, path.join(dir, FILE_MANIFEST));
  return manifest;
}

async function gitTop(root: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", ["-C", root, "rev-parse", "--show-toplevel"], { windowsHide: true }, (err, out) => {
      resolve(err ? null : String(out).trim() || null);
    });
  });
}

/** Compare the stored graph with the manifest. Drift or a malformed manifest => UNUSABLE. */
export async function verifyFileManifest(root: string, graph: SearchGraph): Promise<ManifestVerdict> {
  const m = await readFileManifest(root);
  if (m === "absent") return { state: "absent", reasons: [], source: null, fileCount: null };
  if (m === "invalid") {
    return { state: "unusable", reasons: [`${INDEX_DIR}/${FILE_MANIFEST} is malformed`], source: null, fileCount: null };
  }
  return { ...compareManifest(m, [...graph.files()].map((r) => r.path)), source: m.source, fileCount: m.fileCount };
}

/** Pure comparison (exported for tests). */
export function compareManifest(m: FileManifest, graphPaths: string[]): { state: ManifestState; reasons: string[] } {
  const reasons: string[] = [];
  if (m.fileCount !== m.files.length) {
    reasons.push(`manifest fileCount ${m.fileCount} != ${m.files.length} listed entries`);
  }
  const listed = new Set<string>();
  for (const e of m.files) {
    if (listed.has(e.path)) reasons.push(`manifest lists ${JSON.stringify(e.path)} twice`);
    listed.add(e.path);
  }
  const inGraph = new Set(graphPaths);
  if (inGraph.size !== m.fileCount) {
    reasons.push(`file count drift: index has ${inGraph.size} file(s), manifest records ${m.fileCount}`);
  }
  const missing = [...listed].filter((p) => !inGraph.has(p)).sort();
  const extra = [...inGraph].filter((p) => !listed.has(p)).sort();
  if (missing.length > 0) {
    reasons.push(`${missing.length} manifest file(s) missing from the index: ${missing.slice(0, MAX_DRIFT_PATHS).join(", ")}${missing.length > MAX_DRIFT_PATHS ? ", ..." : ""}`);
  }
  if (extra.length > 0) {
    reasons.push(`${extra.length} indexed file(s) not in the manifest: ${extra.slice(0, MAX_DRIFT_PATHS).join(", ")}${extra.length > MAX_DRIFT_PATHS ? ", ..." : ""}`);
  }
  return { state: reasons.length > 0 ? "unusable" : "ok", reasons };
}

/**
 * Choose a probe: the first file (by path) with content terms, and its
 * lexicographically first term of 3+ word characters. null if the graph has none.
 */
export function chooseProbe(graph: SearchGraph): { path: string; term: string } | null {
  const recs = [...graph.files()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const rec of recs) {
    if (rec.contentSkip !== undefined) continue;
    const terms = graph.forwardOf(rec.id);
    if (!terms) continue;
    const cands = [...terms.keys()].filter((t) => /^[a-z_][a-z0-9_]{2,63}$/.test(t)).sort();
    if (cands.length > 0) return { path: rec.path, term: cands[0] as string };
  }
  return null;
}
// ---------------------------------------------------------------------------
// Content drift (MYCO-HARD-1c): recorded digest vs the content there now.

export type DriftMode = "quick" | "deep" | "pinned" | "pinned-deep";
export interface ContentDriftReport {
  mode: DriftMode;
  /** Entries whose current content was actually hashed and compared. */
  checked: number;
  /** Content differs from the recorded digest (file edited since the refresh). */
  changed: string[];
  /** Listed in the manifest but no longer a regular file (deleted / replaced / now a symlink). */
  deleted: string[];
  /**
   * Digest differs although bytes + mtime match the record (deep), or a pinned
   * digest disagrees with the commit the manifest names: an mtime-preserving
   * edit or a rewritten manifest. Never benign.
   */
  silent: string[];
  /** Metadata moved but the digest still matches (e.g. touch / checkout). */
  touched: number;
  /** Recorded sha256 is null (over the hash cap, or unreadable at refresh). */
  unhashed: string[];
  /** Exists but could not be read now. */
  unreadable: string[];
  /** Set when the comparison could not run at all (e.g. pinned commit gone). */
  error: string | null;
}

function emptyReport(mode: DriftMode): ContentDriftReport {
  return { mode, checked: 0, changed: [], deleted: [], silent: [], touched: 0, unhashed: [], unreadable: [], error: null };
}

/**
 * Compare `m` with the content now on disk (or, for a pinned manifest, in the
 * commit it names). Never follows symlinks; never reads outside `root` (paths
 * were validated by readFileManifest). Read-only.
 */
export async function checkContentDrift(
  root: string,
  m: FileManifest,
  opts: { deep?: boolean } = {},
): Promise<ContentDriftReport> {
  const deep = opts.deep === true;
  if (m.source.pinned) {
    const r = emptyReport(deep ? "pinned-deep" : "pinned");
    if (!deep) return r;
    if (m.source.commit === null) { r.error = "pinned manifest names no commit"; return r; }
    let blobs: Map<string, string>;
    try {
      blobs = new Map(pinnedListing(root, m.source.commit).entries.map((e) => [e.relPath, e.blob] as [string, string]));
    } catch (e) {
      r.error = `pinned commit ${m.source.commit.slice(0, 12)} cannot be listed: ${(e as Error).message}`;
      return r;
    }
    for (const e of m.files) {
      if (e.sha256 === null) { r.unhashed.push(e.path); continue; }
      const blob = blobs.get(e.path);
      if (blob === undefined) { r.silent.push(e.path); continue; }
      let digest: string;
      try { digest = sha256(readPinnedBlob(root, blob)); } catch { r.unreadable.push(e.path); continue; }
      r.checked++;
      if (digest !== e.sha256) r.silent.push(e.path);
    }
    return r;
  }
  const r = emptyReport(deep ? "deep" : "quick");
  const unsafe = m.files.find((e) => !isSafeManifestPath(e.path));
  if (unsafe !== undefined) { r.error = `manifest path ${JSON.stringify(unsafe.path)} is not a safe repo-relative path`; return r; }
  for (const e of m.files) {
    const abs = path.join(root, ...e.path.split("/"));
    let st: import("node:fs").Stats;
    try {
      st = await fs.lstat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") r.deleted.push(e.path);
      else r.unreadable.push(e.path);
      continue;
    }
    if (!st.isFile()) { r.deleted.push(e.path); continue; }
    const sameMeta = st.size === e.bytes && st.mtimeMs === e.mtimeMs;
    if (e.sha256 === null) {
      if (!sameMeta) r.changed.push(e.path);
      else r.unhashed.push(e.path);
      continue;
    }
    if (sameMeta && !deep) continue;
    if (st.size > MANIFEST_HASH_CAP_BYTES) { r.changed.push(e.path); continue; }
    let digest: string;
    try { digest = await streamSha256(abs); } catch { r.unreadable.push(e.path); continue; }
    r.checked++;
    if (digest === e.sha256) { if (!sameMeta) r.touched++; continue; }
    if (sameMeta) r.silent.push(e.path);
    else r.changed.push(e.path);
  }
  return r;
}
