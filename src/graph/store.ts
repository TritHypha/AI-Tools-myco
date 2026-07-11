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

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { SearchGraph } from "./model.ts";
import type { TermCounts } from "./model.ts";

const FORMAT = 1;
export const INDEX_DIR = ".myco";
export const INDEX_FILE = "index.json";

interface StoredFile {
  p: string; // relative POSIX path
  m: number; // mtimeMs
  s: number; // size
  t: Array<[string, number]>; // term counts (forward edges)
}

interface StoredIndex {
  format: number;
  createdAt: number;
  files: StoredFile[];
}

export interface IndexMeta {
  createdAt: number;
  fileCount: number;
  termCount: number;
}

function indexPath(root: string): string {
  return path.join(root, INDEX_DIR, INDEX_FILE);
}

// Write the graph to <root>/.myco/index.json (creating the dir if needed).
export async function saveGraph(root: string, graph: SearchGraph): Promise<void> {
  const files: StoredFile[] = [];
  for (const rec of graph.files()) {
    const counts = graph.forwardOf(rec.id);
    if (!counts) continue;
    files.push({
      p: rec.path,
      m: rec.mtimeMs,
      s: rec.size,
      t: [...counts],
    });
  }
  const payload: StoredIndex = { format: FORMAT, createdAt: Date.now(), files };
  const dir = path.join(root, INDEX_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(indexPath(root), JSON.stringify(payload), "utf8");
}

// Load the graph from disk, or null if there is no (compatible) index yet.
export async function loadGraph(
  root: string,
): Promise<{ graph: SearchGraph; meta: IndexMeta } | null> {
  let text: string;
  try {
    text = await fs.readFile(indexPath(root), "utf8");
  } catch {
    return null;
  }
  let data: StoredIndex;
  try {
    data = JSON.parse(text) as StoredIndex;
  } catch {
    return null; // corrupt index — treat as absent, a re-index will rewrite it
  }
  if (data.format !== FORMAT) return null;

  const graph = new SearchGraph();
  for (const f of data.files) {
    const counts: TermCounts = new Map(f.t);
    graph.setFile(f.p, f.m, f.s, counts);
  }
  return {
    graph,
    meta: {
      createdAt: data.createdAt,
      fileCount: graph.fileCount(),
      termCount: graph.termCount(),
    },
  };
}
