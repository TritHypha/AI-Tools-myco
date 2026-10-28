// indexer.ts — build or refresh the search graph for a root directory.
//
// Incremental by construction: an existing index is loaded, the tree is walked
// for metadata only, and a file is re-read + re-tokenized ONLY when its mtime or
// size changed. Unchanged files reuse their stored term counts; vanished files
// are dropped. That is what makes a re-index after editing one file nearly free.

import { createHash } from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { createReadStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";

import { SearchGraph } from "../graph/model.ts";
import type { UnknownMarker } from "../graph/model.ts";
import { loadGraph, saveGraph } from "../graph/store.ts";
import type { SaveOutcome } from "../graph/store.ts";
import { looksBinary } from "../util/binary.ts";
import { countTerms } from "./tokenize.ts";
import { walk } from "./walk.ts";

export interface IndexOptions {
  maxFileSize: number;
  useGitignore: boolean;
  includeVendored?: boolean; // descend into node_modules (default false; skips reported)
  /** Stream-hash over-size files (bounded streamed read, never tokenized). Default false. */
  hashOversize?: boolean;
  /** Index git-tracked files that .gitignore matches (default true; reported). */
  includeTrackedIgnored?: boolean;
}

export interface IndexStats {
  files: number; // files in the index after the run
  added: number; // newly indexed
  updated: number; // re-indexed because they changed
  unchanged: number; // reused from the previous index
  removed: number; // dropped because they vanished
  skippedBinary: number; // detected as binary and skipped
  skippedLarge: number; // skipped for exceeding maxFileSize (reported, never silent)
  skippedVendored: number; // vendored dirs (node_modules) pruned by default (reported, never silent)
  omittedOverlongTerms: number; // overlong token occurrences omitted from term edges
  filesWithOmittedOverlongTerms: number; // files retained with omission metadata
  trackedIgnored: number; // git-tracked files indexed although .gitignore matches them (reported)
  unreadable: number; // listed files whose content read failed this run (reported, never silent)
}

/** "No size cap" — the default since 2026-10-28 (index everything, miss nothing). */
export const UNLIMITED_FILE_SIZE = Number.MAX_SAFE_INTEGER;

export const DEFAULT_INDEX_OPTIONS: IndexOptions = {
  // No default size limit: every file is content-indexed (owner 2026-10-28).
  // --max-size remains an optional, reported cap.
  maxFileSize: UNLIMITED_FILE_SIZE,
  useGitignore: true,
  hashOversize: false,
  includeTrackedIgnored: true,
};

// Largest text one in-process string can hold (bytes >= UTF-16 units for UTF-8).
export const ENGINE_TEXT_LIMIT = Math.min(bufferConstants.MAX_STRING_LENGTH, 2 ** 31 - 1);

async function streamSha256(absPath: string): Promise<string | undefined> {
  try {
    const hash = createHash("sha256");
    await pipeline(createReadStream(absPath), hash);
    return hash.digest("hex");
  } catch {
    // Read error leaves the marker without sha256. Never drop the node.
    return undefined;
  }
}

function oversizeMarker(thresholdBytes: number, sha256?: string): UnknownMarker {
  const marker: UnknownMarker = {
    type: "UNKNOWN",
    state: "INDEXED_UNKNOWN",
    reason: "OVERSIZE",
    thresholdBytes,
  };
  if (sha256 !== undefined) marker.sha256 = sha256;
  return marker;
}

export async function buildIndex(
  root: string,
  opts: IndexOptions = DEFAULT_INDEX_OPTIONS,
): Promise<{
  graph: SearchGraph;
  stats: IndexStats;
  saved: SaveOutcome; // whether the cache actually persisted, and why not
  skippedLargePaths: string[];
  skippedVendoredDirs: string[];
  omittedOverlongTermPaths: string[];
  unreadablePaths: string[];
  trackedIgnoredPaths: string[];
}> {
  const prior = await loadGraph(root);
  const graph = prior?.graph ?? new SearchGraph();

  const stats: IndexStats = {
    files: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skippedBinary: 0,
    skippedLarge: 0,
    skippedVendored: 0,
    omittedOverlongTerms: 0,
    filesWithOmittedOverlongTerms: 0,
    trackedIgnored: 0,
    unreadable: 0,
  };

  const skippedLargePaths: string[] = [];
  const skippedVendoredDirs: string[] = [];
  const unreadablePaths: string[] = [];
  const trackedIgnoredPaths: string[] = [];
  const metas = await walk(root, opts, skippedLargePaths, skippedVendoredDirs, trackedIgnoredPaths);
  const seen = new Set<string>();

  for (const meta of metas) {
    seen.add(meta.relPath);
    const existing = graph.fileByPath(meta.relPath);
    // A file beyond what one JS string can hold cannot be tokenized in-process.
    // It is never dropped: it is name-indexed with an explicit OVERSIZE marker
    // (threshold = the engine limit) and listed in skippedLargePaths.
    const engineLimited = meta.contentSkip !== "large" && meta.size > ENGINE_TEXT_LIMIT;
    if (engineLimited) skippedLargePaths.push(meta.relPath);
    const wantLarge = meta.contentSkip === "large" || engineLimited;
    const threshold = engineLimited ? ENGINE_TEXT_LIMIT : opts.maxFileSize;

    // Incremental reuse when size+mtime match AND the content-skip role is stable.
    // Role changes (cap raised/lowered, binary↔text) fall through and re-classify.
    if (
      existing &&
      existing.mtimeMs === meta.mtimeMs &&
      existing.size === meta.size
    ) {
      if (
        wantLarge
        && existing.contentSkip === "large"
        && existing.unknown?.thresholdBytes === threshold
        && (!opts.hashOversize || existing.unknown?.sha256 !== undefined)
      ) {
        stats.unchanged++;
        continue;
      }
      if (!wantLarge && existing.contentSkip === "binary") {
        stats.unchanged++;
        stats.skippedBinary++; // still binary this run; no re-sniff needed
        continue;
      }
      if (!wantLarge && existing.contentSkip === undefined) {
        stats.unchanged++;
        continue;
      }
      // otherwise: large↔content or content↔large transition under same size —
      // only happens when maxFileSize policy moved; re-apply classification.
    }

    // Over-size: name-index only, never open the file (DESIGN §10).
    if (wantLarge) {
      const sha256 = opts.hashOversize ? await streamSha256(meta.absPath) : undefined;
      graph.setFile(
        meta.relPath,
        meta.mtimeMs,
        meta.size,
        new Map(),
        "large",
        0,
        oversizeMarker(threshold, sha256),
      );
      if (existing) stats.updated++;
      else stats.added++;
      continue;
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(meta.absPath);
    } catch {
      // Races with deletion, permission errors: don't crash, but never silently —
      // the path is reported so a miss cannot read as absence.
      unreadablePaths.push(meta.relPath);
      continue;
    }
    if (looksBinary(buf)) {
      // Name-index only — still findable by `-f`, never opened for content.
      graph.setFile(meta.relPath, meta.mtimeMs, meta.size, new Map(), "binary");
      stats.skippedBinary++;
      if (existing) stats.updated++;
      else stats.added++;
      continue;
    }

    const tokenizeReport = { omittedOverlongTerms: 0 };
    graph.setFile(
      meta.relPath,
      meta.mtimeMs,
      meta.size,
      countTerms(buf.toString("utf8"), tokenizeReport),
      undefined,
      tokenizeReport.omittedOverlongTerms,
    );
    if (existing) stats.updated++;
    else stats.added++;

  }

  // Drop files that were indexed before but are gone (or now ignored) now.
  for (const rec of [...graph.files()]) {
    if (!seen.has(rec.path)) {
      graph.removeFile(rec.path);
      stats.removed++;
    }
  }

  stats.skippedLarge = skippedLargePaths.length;
  stats.skippedVendored = skippedVendoredDirs.length;
  stats.trackedIgnored = trackedIgnoredPaths.length;
  stats.unreadable = unreadablePaths.length;
  stats.files = graph.fileCount();
  const omittedOverlongTermPaths = [...graph.files()]
    .filter((file) => (file.omittedOverlongTerms ?? 0) > 0)
    .map((file) => file.path)
    .sort();
  stats.filesWithOmittedOverlongTerms = omittedOverlongTermPaths.length;
  stats.omittedOverlongTerms = [...graph.files()]
    .reduce((sum, file) => sum + (file.omittedOverlongTerms ?? 0), 0);
  // The save may decline (see saveGraph). Hand the outcome back rather than
  // discarding it: a cache that did not persist is a fact the caller must be
  // able to report, otherwise the next run repeats the work with no explanation.
  const saved = await saveGraph(root, graph);
  return {
    graph,
    stats,
    saved,
    skippedLargePaths,
    skippedVendoredDirs,
    omittedOverlongTermPaths,
    unreadablePaths,
    trackedIgnoredPaths,
  };
}
