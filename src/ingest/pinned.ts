// pinned.ts - index a repo from a PINNED COMMIT instead of the working folder
// (MYCO-HARD-1 item 1).
//
// Why: the working folder is mutable and may hold things the repo does not
// (untracked scratch, half-written edits, a file swapped for a symlink mid-walk).
// Indexing `git ls-tree` of one resolved commit gives an index that is exactly
// "what is in repo@<sha>", reproducible, and immune to working-folder races.
//
// Rules:
//   - The revision is resolved ONCE to a full commit SHA (`rev-parse --verify
//     <rev>^{commit}`); everything after that reads that SHA only.
//   - Regular blobs (modes 100644 / 100755) are listed with their size and blob id.
//   - Symlinks (mode 120000) are NEVER followed or read as a path; they are
//     reported in `symlinks`. Submodules (mode 160000) are reported in
//     `submodules` (their content lives in another repo).
//   - Content is read straight from the object store with `git cat-file blob <id>`
//     (bounded by the caller), never from the working folder.
//   - Every failure fails closed: a revision that does not resolve, or git that is
//     unavailable, throws PinnedIndexError; nothing falls back to the working tree.
// All git calls use argument arrays (no shell) and NUL-separated output, so odd
// filenames (spaces, newlines, quotes, leading '-', Unicode) arrive verbatim.

import { execFileSync } from "node:child_process";

export class PinnedIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedIndexError";
  }
}

export interface PinnedEntry {
  relPath: string; // POSIX, repo-root relative, verbatim from git
  blob: string; // blob object id
  size: number; // bytes, from `ls-tree --long`
  mode: string; // "100644" | "100755"
}

export interface PinnedListing {
  commit: string; // full resolved commit SHA
  entries: PinnedEntry[];
  symlinks: string[]; // mode 120000 - never followed, reported
  submodules: string[]; // mode 160000 - other repos, reported
  other: string[]; // any unexpected mode - reported, not indexed
}

const GIT_MAX_BUFFER = 1024 * 1024 * 1024;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function git(root: string, args: string[], input?: string): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input,
    windowsHide: true,
  });
}

/** Resolve `rev` to one full commit SHA, or throw PinnedIndexError (fail closed). */
export function resolvePinnedCommit(root: string, rev: string): string {
  if (rev === "" || rev.startsWith("-")) {
    throw new PinnedIndexError(`refusing revision ${JSON.stringify(rev)}: empty or option-like`);
  }
  let out: string;
  try {
    out = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`])
      .toString("utf8")
      .trim();
  } catch {
    throw new PinnedIndexError(`revision ${JSON.stringify(rev)} does not resolve to a commit in ${root}`);
  }
  if (!FULL_SHA.test(out)) {
    throw new PinnedIndexError(`revision ${JSON.stringify(rev)} resolved to a non-SHA value`);
  }
  return out;
}

/** Parse `git ls-tree -r -z --long --full-tree <sha>` output. Exported for tests. */
export function parseLsTreeLong(raw: string): Omit<PinnedListing, "commit"> {
  const entries: PinnedEntry[] = [];
  const symlinks: string[] = [];
  const submodules: string[] = [];
  const other: string[] = [];
  for (const rec of raw.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) throw new PinnedIndexError("malformed ls-tree record (no tab)");
    const meta = rec.slice(0, tab).trim().split(/\s+/);
    const relPath = rec.slice(tab + 1);
    if (meta.length !== 4 || relPath === "") {
      throw new PinnedIndexError("malformed ls-tree record (fields)");
    }
    const [mode, type, blob, sizeField] = meta;
    if (mode === "120000") {
      symlinks.push(relPath);
    } else if (mode === "160000" || type === "commit") {
      submodules.push(relPath);
    } else if ((mode === "100644" || mode === "100755") && type === "blob") {
      const size = Number(sizeField);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new PinnedIndexError(`malformed size for ${JSON.stringify(relPath)}`);
      }
      entries.push({ relPath, blob, size, mode });
    } else {
      other.push(relPath);
    }
  }
  return { entries, symlinks, submodules, other };
}

/** List every path at the pinned commit. Never touches the working folder. */
export function pinnedListing(root: string, rev: string): PinnedListing {
  // ls-tree --full-tree paths are repo-top relative, so the index root must BE the
  // repo top; a subdirectory root would silently mis-map every path.
  let prefix: string;
  try {
    prefix = git(root, ["rev-parse", "--show-prefix"]).toString("utf8").trim();
  } catch {
    throw new PinnedIndexError(`${root} is not inside a git work tree`);
  }
  if (prefix !== "") {
    throw new PinnedIndexError(`--at needs the repository top as root (got subdirectory ${JSON.stringify(prefix)})`);
  }
  const commit = resolvePinnedCommit(root, rev);
  let raw: string;
  try {
    raw = git(root, ["ls-tree", "-r", "-z", "--long", "--full-tree", commit]).toString("utf8");
  } catch {
    throw new PinnedIndexError(`git ls-tree failed for ${commit}`);
  }
  return { commit, ...parseLsTreeLong(raw) };
}

/** Read one blob's bytes from the object store (never the working folder). */
export function readPinnedBlob(root: string, blob: string): Buffer {
  if (!FULL_SHA.test(blob)) throw new PinnedIndexError("refusing non-SHA blob id");
  return git(root, ["cat-file", "blob", blob]);
}
