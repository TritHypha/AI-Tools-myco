// indexer.ts — build or refresh the search graph for a root directory.
//
// Incremental by construction: an existing index is loaded, the tree is walked
// for metadata only, and a file is re-read + re-tokenized ONLY when its mtime or
// size changed. Unchanged files reuse their stored term counts; vanished files
// are dropped. That is what makes a re-index after editing one file nearly free.

import { promises as fs } from "node:fs";

import { SearchGraph } from "../graph/model.ts";
import { clampTermEdgeCeiling, loadGraph, saveGraph } from "../graph/store.ts";
import type { SaveOutcome } from "../graph/store.ts";
import { looksBinary } from "../util/binary.ts";
import { countTerms } from "./tokenize.ts";
import { walk } from "./walk.ts";

export interface IndexOptions {
  maxFileSize: number;
  useGitignore: boolean;
  includeVendored?: boolean; // descend into node_modules (default false; skips reported)
  /** Tests may tighten this ceiling; callers cannot raise the fixed maximum. */
  maxTermEdges?: number;
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
}

export const DEFAULT_INDEX_OPTIONS: IndexOptions = {
  maxFileSize: 5 * 1024 * 1024,
  useGitignore: true,
};

export async function buildIndex(
  root: string,
  opts: IndexOptions = DEFAULT_INDEX_OPTIONS,
): Promise<{
  graph: SearchGraph;
  stats: IndexStats;
  saved: SaveOutcome; // whether the cache actually persisted, and why not
  skippedLargePaths: string[];
  skippedVendoredDirs: string[];
}> {
  const prior = await loadGraph(root);
  const graph = prior?.graph ?? new SearchGraph();
  const termEdgeCeiling = clampTermEdgeCeiling(opts.maxTermEdges);

  const stats: IndexStats = {
    files: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skippedBinary: 0,
    skippedLarge: 0,
    skippedVendored: 0,
  };

  const skippedLargePaths: string[] = [];
  const skippedVendoredDirs: string[] = [];
  const metas = await walk(root, opts, skippedLargePaths, skippedVendoredDirs);
  const seen = new Set<string>();

  for (const meta of metas) {
    seen.add(meta.relPath);
    const existing = graph.fileByPath(meta.relPath);
    const wantLarge = meta.contentSkip === "large";

    // Incremental reuse when size+mtime match AND the content-skip role is stable.
    // Role changes (cap raised/lowered, binary↔text) fall through and re-classify.
    if (
      existing &&
      existing.mtimeMs === meta.mtimeMs &&
      existing.size === meta.size
    ) {
      if (wantLarge && existing.contentSkip === "large") {
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
      graph.setFile(meta.relPath, meta.mtimeMs, meta.size, new Map(), "large");
      if (existing) stats.updated++;
      else stats.added++;
      continue;
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(meta.absPath);
    } catch {
      continue; // races with deletion, permission errors — skip, don't crash
    }
    if (looksBinary(buf)) {
      // Name-index only — still findable by `-f`, never opened for content.
      graph.setFile(meta.relPath, meta.mtimeMs, meta.size, new Map(), "binary");
      stats.skippedBinary++;
      if (existing) stats.updated++;
      else stats.added++;
      continue;
    }

    graph.setFile(meta.relPath, meta.mtimeMs, meta.size, countTerms(buf.toString("utf8")));
    if (existing) stats.updated++;
    else stats.added++;

    // Stop the moment the graph passes the ceiling the persisted format allows.
    // Carrying on would build a structure that cannot be saved and, at the sizes
    // this triggers on, exhausts the heap while serialising — the process dies
    // with an abort and no diagnosis. Refusing here costs the user a message
    // instead of a crash, and the message names the remedy: index a narrower
    // root. A tree too big for the contract is a scope mistake, not a bug to
    // absorb silently.
    if (graph.termEdgeCount() > termEdgeCeiling) {
      throw new Error(
        `MYCO-INDEX-TOO-LARGE: ${root} exceeds the index ceiling of `
          + `${termEdgeCeiling.toLocaleString()} term edges `
          + `(reached at ${stats.added + stats.updated + stats.unchanged} files). `
          + `Index a narrower root — e.g. a single repository rather than a `
          + `directory of repositories.`,
      );
    }
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
  stats.files = graph.fileCount();
  // The save may decline (see saveGraph). Hand the outcome back rather than
  // discarding it: a cache that did not persist is a fact the caller must be
  // able to report, otherwise the next run repeats the work with no explanation.
  const saved = await saveGraph(root, graph, { maxTermEdges: termEdgeCeiling });
  return { graph, stats, saved, skippedLargePaths, skippedVendoredDirs };
}
