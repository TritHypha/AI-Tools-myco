import * as path from "node:path";

export const MAX_INDEX_PATH_LENGTH = 4096;
export const MAX_INDEX_TERM_LENGTH = 4096;
export const MAX_INDEX_FILES = 250_000;
export const MAX_INDEX_TERMS_PER_FILE = 100_000;
export const MAX_INDEX_TERM_EDGES = 2_000_000;
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;

export interface IndexLimits {
  maxFiles: number;
  maxTermsPerFile: number;
  maxTermEdges: number;
}

export const DEFAULT_INDEX_LIMITS: Readonly<IndexLimits> = Object.freeze({
  maxFiles: MAX_INDEX_FILES,
  maxTermsPerFile: MAX_INDEX_TERMS_PER_FILE,
  maxTermEdges: MAX_INDEX_TERM_EDGES,
});

/** Optional content-skip tag on a stored file (format 1, additive).
 *  Absent ⇒ content indexed. `b` binary · `l` over-size. */
export type StoredContentSkip = "b" | "l";

export interface StoredFile {
  p: string;
  m: number;
  s: number;
  t: Array<[string, number]>;
  /** Name-only: content was not tokenized (DESIGN §10). */
  k?: StoredContentSkip;
}

export interface StoredIndex {
  format: 1;
  createdAt: number;
  files: StoredFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length
    && actual.every((key, index) => key === required[index]);
}

export function isCanonicalIndexPath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_INDEX_PATH_LENGTH
    || value.includes("\0")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  if (segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === "..")) {
    return false;
  }
  return path.posix.normalize(value) === value;
}

export function validateStoredIndex(
  value: unknown,
  limits: Readonly<IndexLimits> = DEFAULT_INDEX_LIMITS,
): StoredIndex | null {
  if (
    !Number.isSafeInteger(limits.maxFiles)
    || limits.maxFiles < 0
    || limits.maxFiles > MAX_INDEX_FILES
    || !Number.isSafeInteger(limits.maxTermsPerFile)
    || limits.maxTermsPerFile < 0
    || limits.maxTermsPerFile > MAX_INDEX_TERMS_PER_FILE
    || !Number.isSafeInteger(limits.maxTermEdges)
    || limits.maxTermEdges < 0
    || limits.maxTermEdges > MAX_INDEX_TERM_EDGES
    || !isRecord(value)
    || !hasExactKeys(value, ["format", "createdAt", "files"])
    || value.format !== 1
    || typeof value.createdAt !== "number"
    || !Number.isFinite(value.createdAt)
    || value.createdAt < 0
    || !Array.isArray(value.files)
    || value.files.length > limits.maxFiles
  ) {
    return null;
  }

  const paths = new Set<string>();
  const files: StoredFile[] = [];
  let termEdges = 0;

  for (const candidate of value.files) {
    if (
      !isRecord(candidate)
      || !isCanonicalIndexPath(candidate.p)
      || typeof candidate.m !== "number"
      || !Number.isFinite(candidate.m)
      || candidate.m < 0
      || typeof candidate.s !== "number"
      || !Number.isSafeInteger(candidate.s)
      || candidate.s < 0
      || !Array.isArray(candidate.t)
      || candidate.t.length > limits.maxTermsPerFile
      || paths.has(candidate.p)
    ) {
      return null;
    }
    // Closed shape: required p/m/s/t; optional k ∈ {b,l} for name-only nodes.
    // Unknown keys still refuse (hostile cache). Exact {p,m,s,t} remains valid.
    const keys = Object.keys(candidate).sort().join(",");
    if (keys !== "m,p,s,t" && keys !== "k,m,p,s,t") return null;
    let contentSkip: StoredContentSkip | undefined;
    if (keys === "k,m,p,s,t") {
      if (candidate.k !== "b" && candidate.k !== "l") return null;
      contentSkip = candidate.k;
      // Name-only files must not carry term postings (would re-open content paths).
      if (candidate.t.length !== 0) return null;
    }
    paths.add(candidate.p);

    const terms = new Set<string>();
    const storedTerms: Array<[string, number]> = [];
    for (const entry of candidate.t) {
      if (
        !Array.isArray(entry)
        || entry.length !== 2
        || typeof entry[0] !== "string"
        || entry[0].length === 0
        || entry[0].length > MAX_INDEX_TERM_LENGTH
        || entry[0].includes("\0")
        || entry[0].normalize("NFC") !== entry[0]
        || typeof entry[1] !== "number"
        || !Number.isSafeInteger(entry[1])
        || entry[1] <= 0
        || terms.has(entry[0])
      ) {
        return null;
      }
      terms.add(entry[0]);
      storedTerms.push([entry[0], entry[1]]);
      termEdges += 1;
      if (termEdges > limits.maxTermEdges) return null;
    }

    const stored: StoredFile = {
      p: candidate.p,
      m: candidate.m,
      s: candidate.s,
      t: storedTerms,
    };
    if (contentSkip) stored.k = contentSkip;
    files.push(stored);
  }

  return {
    format: 1,
    createdAt: value.createdAt,
    files,
  };
}
