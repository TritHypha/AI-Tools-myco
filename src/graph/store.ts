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

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_INDEX_LIMITS,
  validateStoredIndex,
} from "./index-contract.ts";
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
    if (rec.contentSkip === "binary") stored.k = "b";
    else if (rec.contentSkip === "large") stored.k = "l";
    else if (rec.omittedOverlongTerms) stored.o = rec.omittedOverlongTerms;
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
  const destination = indexPath(root);
  const temporary = path.join(
    dir,
    `.${INDEX_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(JSON.stringify(validated), "utf8");
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
  } catch (error: unknown) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
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
      return { status: "rejected" };
    }
    const stat = await fs.lstat(requestedIndex);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: "rejected" };
    }
    text = await fs.readFile(requestedIndex, "utf8");
  } catch (error: unknown) {
    // Only a genuinely missing path is absence. Permission failures, invalid
    // paths and I/O faults are rejected evidence, never a reassuring first run.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "rejected" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return { status: "rejected" }; // a file IS there; it is corrupt, not missing
  }
  const data = validateStoredIndex(decoded);
  if (data === null) return { status: "rejected" };

  const graph = new SearchGraph();
  try {
    for (const f of data.files) {
      const counts: TermCounts = new Map(f.t);
      const skip = f.k === "b" ? "binary" as const : f.k === "l" ? "large" as const : undefined;
      graph.setFile(f.p, f.m, f.s, counts, skip, f.o ?? 0);
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
