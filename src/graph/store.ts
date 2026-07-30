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

import { MAX_INDEX_BYTES, validateStoredIndex } from "./index-contract.ts";
import type { StoredFile, StoredIndex } from "./index-contract.ts";
import { SearchGraph } from "./model.ts";
import type { TermCounts } from "./model.ts";

const FORMAT = 1;
export const INDEX_DIR = ".myco";
export const INDEX_FILE = "index.json";

export interface IndexMeta {
  createdAt: number;
  fileCount: number;
  termCount: number;
}

export interface LoadGraphOptions {
  /** Tests may tighten this ceiling; callers cannot raise the fixed maximum. */
  maxIndexBytes?: number;
}

function indexPath(root: string): string {
  return path.join(root, INDEX_DIR, INDEX_FILE);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
      t: [...counts].sort(([left], [right]) => compareCodeUnits(left, right)),
    });
  }
  files.sort((left, right) => compareCodeUnits(left.p, right.p));
  const payload: StoredIndex = { format: FORMAT, createdAt: Date.now(), files };
  const dir = path.join(root, INDEX_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(indexPath(root), JSON.stringify(payload), "utf8");
}

// Load the graph from disk, or null if there is no (compatible) index yet.
export async function loadGraph(
  root: string,
  options: LoadGraphOptions = {},
): Promise<{ graph: SearchGraph; meta: IndexMeta } | null> {
  const maxIndexBytes = options.maxIndexBytes ?? MAX_INDEX_BYTES;
  if (
    !Number.isSafeInteger(maxIndexBytes)
    || maxIndexBytes < 1
    || maxIndexBytes > MAX_INDEX_BYTES
  ) {
    return null;
  }
  let text: string;
  try {
    const requestedIndex = indexPath(root);
    const [realRoot, realIndex] = await Promise.all([
      fs.realpath(root),
      fs.realpath(requestedIndex),
    ]);
    const relativeIndex = path.relative(realRoot, realIndex);
    if (
      relativeIndex === ""
      || relativeIndex === ".."
      || relativeIndex.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeIndex)
    ) {
      return null;
    }
    const stat = await fs.lstat(requestedIndex);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxIndexBytes) {
      return null;
    }
    text = await fs.readFile(requestedIndex, "utf8");
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return null; // corrupt index — treat as absent, a re-index will rewrite it
  }
  const data = validateStoredIndex(decoded);
  if (data === null) return null;

  const graph = new SearchGraph();
  try {
    for (const f of data.files) {
      const counts: TermCounts = new Map(f.t);
      graph.setFile(f.p, f.m, f.s, counts);
    }
  } catch {
    return null;
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
