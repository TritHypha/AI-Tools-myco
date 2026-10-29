// coverage-file.ts — the persisted index coverage summary (.myco/index-coverage.json).
//
// `myco index` prints its coverage summary; this file keeps the same facts on disk
// so `myco check` can review them later with fixed, deterministic rules (no AI,
// no network). It never stores file CONTENT or secret values — only counts and
// repo-relative paths that the index run already printed.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { git } from "../query/branches.ts";

export const COVERAGE_FILE = "index-coverage.json";

export interface IndexCoverageFile {
  kind: "myco-index-coverage";
  version: 1;
  createdAt: number;
  head: string | null;
  pinnedCommit: string | null;
  saved: boolean;
  options: {
    useGitignore: boolean;
    includeVendored: boolean;
    includeTrackedIgnored: boolean;
    withholdSecrets: boolean;
    maxFileSize: number | null;
  };
  stats: {
    files: number;
    skippedBinary: number;
    skippedLarge: number;
    withheldSecretTerms: number;
    omittedOverlongTerms: number;
  };
  lists: {
    overSize: string[];
    unreadable: string[];
    vendoredDirs: string[];
    symlinks: string[];
    submodules: string[];
    withheldSecret: string[];
    trackedIgnored: string[];
    omittedOverlong: string[];
  };
}

const posix = (p: string): string => p.replace(/\\/g, "/");
const sorted = (xs: string[]): string[] => [...new Set(xs.map(posix))].sort();

export async function currentHead(root: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function writeIndexCoverage(
  root: string,
  data: Omit<IndexCoverageFile, "kind" | "version" | "head" | "lists"> & { lists: IndexCoverageFile["lists"] },
): Promise<void> {
  const carried = await carryForward(root, data);
  const file: IndexCoverageFile = {
    kind: "myco-index-coverage",
    version: 1,
    createdAt: data.createdAt,
    head: await currentHead(root),
    pinnedCommit: data.pinnedCommit,
    saved: data.saved,
    options: data.options,
    stats: data.stats,
    lists: {
      overSize: sorted(data.lists.overSize),
      unreadable: sorted(data.lists.unreadable),
      vendoredDirs: sorted(data.lists.vendoredDirs),
      symlinks: sorted(data.lists.symlinks),
      submodules: sorted(data.lists.submodules),
      withheldSecret: sorted([...data.lists.withheldSecret, ...carried.withheldSecret]),
      trackedIgnored: sorted(data.lists.trackedIgnored),
      omittedOverlong: sorted([...data.lists.omittedOverlong, ...carried.omittedOverlong]),
    },
  };
  const dir = path.join(root, ".myco");
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${COVERAGE_FILE}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  await fs.rename(tmp, path.join(dir, COVERAGE_FILE));
}

/**
 * An incremental `myco index` only re-reads changed files, so its withheld-secret and
 * overlong-term lists cover just those files. To keep the persisted lists cumulative,
 * carry forward entries from the previous coverage file for files that still exist and
 * were NOT modified since that file was written (mtime < previous createdAt), i.e.
 * files the indexer reused unchanged. Pinned runs re-read everything, and a change in
 * the secret-guard option invalidates the old list, so nothing is carried then.
 */
async function carryForward(
  root: string,
  data: { pinnedCommit: string | null; options: IndexCoverageFile["options"]; lists: IndexCoverageFile["lists"] },
): Promise<{ withheldSecret: string[]; omittedOverlong: string[] }> {
  const none = { withheldSecret: [], omittedOverlong: [] };
  if (data.pinnedCommit) return none;
  const prev = await readIndexCoverage(root);
  if (typeof prev === "string" || prev.pinnedCommit) return none;
  const keep = async (list: string[], fresh: string[]): Promise<string[]> => {
    const freshSet = new Set(fresh.map(posix));
    const out: string[] = [];
    for (const rel of list) {
      if (freshSet.has(rel)) continue;
      try {
        const st = await fs.stat(path.join(root, rel));
        if (st.isFile() && st.mtimeMs < prev.createdAt) out.push(rel);
      } catch { /* deleted: drop */ }
    }
    return out;
  };
  return {
    withheldSecret: prev.options.withholdSecrets === data.options.withholdSecrets && data.options.withholdSecrets
      ? await keep(prev.lists.withheldSecret, data.lists.withheldSecret) : [],
    omittedOverlong: await keep(prev.lists.omittedOverlong, data.lists.omittedOverlong),
  };
}

export async function readIndexCoverage(root: string): Promise<IndexCoverageFile | "absent" | "invalid"> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, ".myco", COVERAGE_FILE), "utf8");
  } catch {
    return "absent";
  }
  try {
    const v = JSON.parse(text) as IndexCoverageFile;
    if (v.kind !== "myco-index-coverage" || v.version !== 1 || typeof v.lists !== "object" || v.lists === null) return "invalid";
    for (const k of ["overSize", "unreadable", "vendoredDirs", "symlinks", "submodules", "withheldSecret", "trackedIgnored", "omittedOverlong"] as const) {
      if (!Array.isArray(v.lists[k])) return "invalid";
    }
    return v;
  } catch {
    return "invalid";
  }
}
