// store.ts — persist and reload the search graph.
//
// Only the FORWARD index is written to disk (each file with its term counts);
// the inverted and name indexes are rebuilt in memory by SearchGraph.setFile()
// on load. That keeps the on-disk format small and makes it the single source
// of truth for incremental re-indexing.
//
// The index lives at <root>/.myco/index.json. We deliberately do NOT store the
// absolute root path — it is derived from where the index file sits — so the
// artifact never embeds a machine-specific path.

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_INDEX_LIMITS,
  validateStoredIndex,
} from "./index-contract.ts";
import type { StoredFile, StoredIndex } from "./index-contract.ts";
import { SearchGraph } from "./model.ts";
import type { TermCounts, UnknownMarker } from "./model.ts";

const FORMAT = 1;
export const INDEX_DIR = ".myco";
export const INDEX_FILE = "index.json";
// Sharded layout (written when the index exceeds one shard's budget): a manifest
// listing index-NNN.json shards with sha256, byte length and counts. Loading
// verifies EVERY shard and fails closed (rejected) on any mismatch or absence.
export const MANIFEST_FILE = "index-manifest.json";
export const SHARD_FORMAT = 2;
export interface ShardBudget { maxEntries: number; maxChars: number; }
export const DEFAULT_SHARD_BUDGET: Readonly<ShardBudget> = Object.freeze({
  maxEntries: 250_000,
  maxChars: 32 * 1024 * 1024,
});
const SHARD_NAME = /^index-(\d{3,})\.json$/;
function shardName(i: number): string { return `index-${String(i).padStart(3, "0")}.json`; }

interface ShardPiece extends StoredFile { c?: 1; }
interface ManifestEntry { name: string; sha256: string; bytes: number; pieces: number; terms: number; }
interface Manifest {
  format: 2; kind: "myco-manifest"; createdAt: number;
  fileCount: number; termEdges: number; shards: ManifestEntry[];
}

// Split stored files into shards. A file whose terms exceed the budget is split
// into consecutive pieces (continuation pieces carry c:1 and only p/m/s/t).
export function planShards(files: StoredFile[], budget: Readonly<ShardBudget>): ShardPiece[][] {
  const shards: ShardPiece[][] = [];
  let current: ShardPiece[] = [];
  let entries = 0;
  let chars = 0;
  const flush = () => { if (current.length > 0) { shards.push(current); current = []; entries = 0; chars = 0; } };
  for (const file of files) {
    let piece: ShardPiece = { ...file, t: [] };
    let first = true;
    const startPiece = () => { entries += 1; chars += file.p.length + 64; };
    if (entries + 1 > budget.maxEntries || chars + file.p.length + 64 > budget.maxChars) flush();
    startPiece();
    for (const term of file.t) {
      const cost = term[0].length + 16;
      if (entries + 1 > budget.maxEntries || chars + cost > budget.maxChars) {
        if (piece.t.length > 0 || first) current.push(piece);
        flush();
        first = false;
        piece = { p: file.p, m: file.m, s: file.s, t: [], c: 1 };
        startPiece();
      }
      piece.t.push(term);
      entries += 1;
      chars += cost;
    }
    current.push(piece);
  }
  flush();
  return shards;
}

async function atomicWrite(dir: string, name: string, data: string): Promise<void> {
  const temporary = path.join(dir, `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx");
    try { await handle.writeFile(data, "utf8"); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(dir, name));
  } catch (error: unknown) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Stored layout for coverage summaries: legacy single file, or manifest + N shards. */
export async function storedIndexLayout(root: string): Promise<{ layout: "none" | "legacy" | "sharded"; shards: number }> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(root, INDEX_DIR));
  } catch {
    return { layout: "none", shards: 0 };
  }
  if (names.includes(MANIFEST_FILE)) {
    return { layout: "sharded", shards: names.filter((n) => SHARD_NAME.test(n)).length };
  }
  return names.includes(INDEX_FILE) ? { layout: "legacy", shards: 1 } : { layout: "none", shards: 0 };
}

/** Total bytes of the stored index (legacy single file or manifest + shards). */
export async function storedIndexBytes(root: string): Promise<number> {
  const dir = path.join(root, INDEX_DIR);
  let total = 0;
  for (const name of await fs.readdir(dir)) {
    if (name === INDEX_FILE || name === MANIFEST_FILE || SHARD_NAME.test(name)) {
      total += (await fs.stat(path.join(dir, name))).size;
    }
  }
  return total;
}

export interface IndexMeta {
  createdAt: number;
  fileCount: number;
  termCount: number;
  omittedOverlongTerms: number;
  filesWithOmittedOverlongTerms: number;
}

function indexPath(root: string): string {
  return path.join(root, INDEX_DIR, INDEX_FILE);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// A structurally invalid payload is the only graph-contract refusal. There is
// no fixed aggregate file, edge, or serialized-byte budget.
export type SaveOutcome =
  | { written: true }
  | { written: false; reason: "invalid-payload" };

// Write the graph to <root>/.myco/index.json (creating the dir if needed).
//
export async function saveGraph(
  root: string,
  graph: SearchGraph,
  budget: Readonly<ShardBudget> = DEFAULT_SHARD_BUDGET,
): Promise<SaveOutcome> {
  const files: StoredFile[] = [];
  for (const rec of graph.files()) {
    const counts = graph.forwardOf(rec.id);
    if (!counts) continue;
    const stored: StoredFile = {
      p: rec.path,
      m: rec.mtimeMs,
      s: rec.size,
      t: [...counts].sort(([left], [right]) => compareCodeUnits(left, right)),
    };
    // Persist name-only reason so a reload does not re-open content search.
    if (rec.contentSkip === "binary") {
      if (rec.unknown !== undefined) {
        throw new Error("MYCO-INDEX-UNKNOWN: marker iff over-size node");
      }
      stored.k = "b";
    } else if (rec.contentSkip === "large") {
      const marker = rec.unknown;
      if (
        marker === undefined
        || marker.type !== "UNKNOWN"
        || marker.state !== "INDEXED_UNKNOWN"
        || marker.reason !== "OVERSIZE"
      ) {
        throw new Error("MYCO-INDEX-UNKNOWN: marker iff over-size node");
      }
      stored.k = "l";
      if (marker.thresholdBytes !== "NOT_RECORDED") {
        if (
          !Number.isSafeInteger(marker.thresholdBytes)
          || marker.thresholdBytes <= 0
          || rec.size <= marker.thresholdBytes
        ) {
          throw new Error("MYCO-INDEX-UNKNOWN: invalid oversize threshold");
        }
        stored.u = {
          st: "INDEXED_UNKNOWN",
          r: "OVERSIZE",
          th: marker.thresholdBytes,
          ...(marker.sha256 ? { h: marker.sha256 } : {}),
        };
      }
    } else if (rec.contentSkip !== undefined) {
      throw new Error("MYCO-INDEX-UNKNOWN: unlisted contentSkip");
    } else if (rec.unknown !== undefined) {
      throw new Error("MYCO-INDEX-UNKNOWN: marker iff over-size node");
    } else if (rec.omittedOverlongTerms) {
      stored.o = rec.omittedOverlongTerms;
    }
    files.push(stored);
  }
  files.sort((left, right) => compareCodeUnits(left.p, right.p));
  const payload: StoredIndex = { format: FORMAT, createdAt: Date.now(), files };
  const validated = validateStoredIndex(payload, DEFAULT_INDEX_LIMITS);
  if (validated === null) {
    return { written: false, reason: "invalid-payload" };
  }
  const dir = path.join(root, INDEX_DIR);
  await fs.mkdir(dir, { recursive: true });
  const shards = planShards(validated.files, budget);
  const existing = await fs.readdir(dir).catch(() => [] as string[]);
  if (shards.length <= 1) {
    // Fits one shard: keep the legacy single-file layout (format 1).
    await atomicWrite(dir, INDEX_FILE, JSON.stringify(validated));
    await fs.unlink(path.join(dir, MANIFEST_FILE)).catch(() => undefined);
    for (const name of existing) {
      if (SHARD_NAME.test(name)) await fs.unlink(path.join(dir, name)).catch(() => undefined);
    }
    return { written: true };
  }
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < shards.length; i += 1) {
    const name = shardName(i);
    const text = JSON.stringify({ format: SHARD_FORMAT, kind: "myco-shard", index: i, files: shards[i] });
    await atomicWrite(dir, name, text);
    entries.push({
      name,
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      bytes: Buffer.byteLength(text, "utf8"),
      pieces: shards[i]!.length,
      terms: shards[i]!.reduce((sum, piece) => sum + piece.t.length, 0),
    });
  }
  const manifest: Manifest = {
    format: 2,
    kind: "myco-manifest",
    createdAt: validated.createdAt,
    fileCount: validated.files.length,
    termEdges: validated.files.reduce((sum, file) => sum + file.t.length, 0),
    shards: entries,
  };
  await atomicWrite(dir, MANIFEST_FILE, JSON.stringify(manifest));
  await fs.unlink(path.join(dir, INDEX_FILE)).catch(() => undefined);
  const keep = new Set(entries.map((entry) => entry.name));
  for (const name of existing) {
    if (SHARD_NAME.test(name) && !keep.has(name)) await fs.unlink(path.join(dir, name)).catch(() => undefined);
  }
  return { written: true };
}

// Why a load produced no graph. `absent` = nothing to read (a genuine first
// run); `rejected` = an index EXISTS on disk but failed the contract.
//
// These are different facts and must not share a signal. A malformed index is
// refused, never mislabeled as a first run.
export type LoadStatus = "ok" | "absent" | "rejected";

// Load the graph from disk, or null if there is no (compatible) index yet.
// Kept for callers that only need the graph; `loadGraphOutcome` is the form
// that can tell "no index" apart from "index refused".
export async function loadGraph(
  root: string,
): Promise<{ graph: SearchGraph; meta: IndexMeta } | null> {
  const outcome = await loadGraphOutcome(root);
  return outcome.status === "ok"
    ? { graph: outcome.graph, meta: outcome.meta }
    : null;
}

// Load the graph and SAY WHY when there is none.
export async function loadGraphOutcome(
  root: string,
): Promise<
  | { status: "ok"; graph: SearchGraph; meta: IndexMeta }
  | { status: "absent" | "rejected" }
> {
  const read = await readStoredIndex(root);
  if (read.status !== "ok") return { status: read.status };
  const decoded = read.value;
  const data = validateStoredIndex(decoded);
  if (data === null) return { status: "rejected" };

  const graph = new SearchGraph();
  try {
    for (const f of data.files) {
      const counts: TermCounts = new Map(f.t);
      let skip: "binary" | "large" | undefined;
      let unknown: UnknownMarker | undefined;
      if (f.k === "b") {
        skip = "binary";
      } else if (f.k === "l") {
        skip = "large";
        // legacy k:"l" without u loads as UNKNOWN with thresholdBytes "NOT_RECORDED"
        unknown = {
          type: "UNKNOWN",
          state: "INDEXED_UNKNOWN",
          reason: "OVERSIZE",
          thresholdBytes: f.u?.th ?? "NOT_RECORDED",
          ...(f.u?.h ? { sha256: f.u.h } : {}),
        };
      } else if (f.k !== undefined) {
        throw new Error("MYCO-INDEX-UNKNOWN: unlisted k");
      }
      graph.setFile(f.p, f.m, f.s, counts, skip, f.o ?? 0, unknown);
    }
  } catch {
    return { status: "rejected" };
  }
  return {
    status: "ok",
    graph,
    meta: {
      createdAt: data.createdAt,
      fileCount: graph.fileCount(),
      termCount: graph.termCount(),
      omittedOverlongTerms: data.files.reduce((sum, file) => sum + (file.o ?? 0), 0),
      filesWithOmittedOverlongTerms: data.files.filter((file) => (file.o ?? 0) > 0).length,
    },
  };
}

// Read a file under <root>/.myco, refusing symlinks and paths escaping the root.
async function readIndexFile(
  root: string,
  name: string,
): Promise<{ status: "ok"; bytes: Buffer } | { status: "absent" | "rejected" }> {
  try {
    const requested = path.join(root, INDEX_DIR, name);
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(requested)]);
    const relative = path.relative(realRoot, realFile);
    if (
      relative === ""
      || relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      return { status: "rejected" };
    }
    const stat = await fs.lstat(requested);
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "rejected" };
    return { status: "ok", bytes: await fs.readFile(requested) };
  } catch (error: unknown) {
    // Only a genuinely missing path is absence. Permission failures, invalid
    // paths and I/O faults are rejected evidence, never a reassuring first run.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "absent" };
    return { status: "rejected" };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Return the decoded format-1 shape, from the manifest+shards layout when a
// manifest exists (every shard verified), else from legacy index.json.
async function readStoredIndex(
  root: string,
): Promise<{ status: "ok"; value: unknown } | { status: "absent" | "rejected" }> {
  const manifestRead = await readIndexFile(root, MANIFEST_FILE);
  if (manifestRead.status === "rejected") return manifestRead;
  if (manifestRead.status !== "ok") {
    const legacy = await readIndexFile(root, INDEX_FILE);
    if (legacy.status !== "ok") return legacy;
    try {
      return { status: "ok", value: JSON.parse(legacy.bytes.toString("utf8")) as unknown };
    } catch {
      return { status: "rejected" }; // a file IS there; it is corrupt, not missing
    }
  }
  let manifest: unknown;
  try { manifest = JSON.parse(manifestRead.bytes.toString("utf8")); } catch { return { status: "rejected" }; }
  if (
    !isPlainRecord(manifest)
    || manifest.format !== 2
    || manifest.kind !== "myco-manifest"
    || typeof manifest.createdAt !== "number"
    || !Number.isSafeInteger(manifest.fileCount)
    || !Number.isSafeInteger(manifest.termEdges)
    || !Array.isArray(manifest.shards)
    || manifest.shards.length === 0
  ) return { status: "rejected" };
  const files: Array<Record<string, unknown>> = [];
  let termEdges = 0;
  for (let i = 0; i < manifest.shards.length; i += 1) {
    const entry = manifest.shards[i] as unknown;
    if (
      !isPlainRecord(entry)
      || entry.name !== shardName(i)
      || typeof entry.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes)
      || !Number.isSafeInteger(entry.pieces)
      || !Number.isSafeInteger(entry.terms)
    ) return { status: "rejected" };
    const shardRead = await readIndexFile(root, entry.name);
    // A MISSING shard is never "absent": the manifest says it exists.
    if (shardRead.status !== "ok") return { status: "rejected" };
    const bytes = shardRead.bytes;
    if (
      bytes.length !== entry.bytes
      || createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    ) return { status: "rejected" };
    let shard: unknown;
    try { shard = JSON.parse(bytes.toString("utf8")); } catch { return { status: "rejected" }; }
    if (
      !isPlainRecord(shard)
      || shard.format !== SHARD_FORMAT
      || shard.kind !== "myco-shard"
      || shard.index !== i
      || !Array.isArray(shard.files)
      || shard.files.length !== entry.pieces
    ) return { status: "rejected" };
    let shardTerms = 0;
    for (const piece of shard.files as unknown[]) {
      if (!isPlainRecord(piece) || !Array.isArray(piece.t)) return { status: "rejected" };
      shardTerms += piece.t.length;
      if (piece.c !== undefined) {
        const prev = files[files.length - 1];
        if (
          piece.c !== 1
          || Object.keys(piece).sort().join(",") !== "c,m,p,s,t"
          || prev === undefined
          || prev.p !== piece.p || prev.m !== piece.m || prev.s !== piece.s
          || prev.k !== undefined
        ) return { status: "rejected" };
        for (const term of piece.t as unknown[]) (prev.t as unknown[]).push(term);
      } else {
        files.push({ ...piece, t: [...(piece.t as unknown[])] });
      }
    }
    if (shardTerms !== entry.terms) return { status: "rejected" };
    termEdges += shardTerms;
  }
  if (files.length !== manifest.fileCount || termEdges !== manifest.termEdges) {
    return { status: "rejected" };
  }
  return { status: "ok", value: { format: 1, createdAt: manifest.createdAt, files } };
}
