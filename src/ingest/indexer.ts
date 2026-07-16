// indexer.ts — build or refresh the search graph for a root directory.
//
// Incremental by construction: an existing index is loaded, the tree is walked
// for metadata only, and a file is re-read + re-tokenized ONLY when its mtime or
// size changed. Unchanged files reuse their stored term counts; vanished files
// are dropped. That is what makes a re-index after editing one file nearly free.

import { promises as fs } from "node:fs";

import { SearchGraph } from "../graph/model.ts";
import { loadGraph, saveGraph } from "../graph/store.ts";
import { looksBinary } from "../util/binary.ts";
import { countTerms } from "./tokenize.ts";
import { walk } from "./walk.ts";

export interface IndexOptions {
  maxFileSize: number;
  useGitignore: boolean;
}

export interface IndexStats {
  files: number; // files in the index after the run
  added: number; // newly indexed
  updated: number; // re-indexed because they changed
  unchanged: number; // reused from the previous index
  removed: number; // dropped because they vanished
  skippedBinary: number; // detected as binary and skipped
  skippedLarge: number; // skipped for exceeding maxFileSize (reported, never silent)
}

export const DEFAULT_INDEX_OPTIONS: IndexOptions = {
  maxFileSize: 5 * 1024 * 1024,
  useGitignore: true,
};

export async function buildIndex(
  root: string,
  opts: IndexOptions = DEFAULT_INDEX_OPTIONS,
): Promise<{ graph: SearchGraph; stats: IndexStats; skippedLargePaths: string[] }> {
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
  };

  const skippedLargePaths: string[] = [];
  const metas = await walk(root, opts, skippedLargePaths);
  const seen = new Set<string>();

  for (const meta of metas) {
    seen.add(meta.relPath);
    const existing = graph.fileByPath(meta.relPath);
    if (
      existing &&
      existing.mtimeMs === meta.mtimeMs &&
      existing.size === meta.size
    ) {
      stats.unchanged++;
      continue;
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(meta.absPath);
    } catch {
      continue; // races with deletion, permission errors — skip, don't crash
    }
    if (looksBinary(buf)) {
      if (existing) graph.removeFile(meta.relPath); // e.g. a file turned binary
      stats.skippedBinary++;
      continue;
    }

    graph.setFile(meta.relPath, meta.mtimeMs, meta.size, countTerms(buf.toString("utf8")));
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
  stats.files = graph.fileCount();
  await saveGraph(root, graph);
  return { graph, stats, skippedLargePaths };
}
