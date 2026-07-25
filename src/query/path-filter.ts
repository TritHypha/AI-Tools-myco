// path-filter.ts — restrict a search to part of the indexed tree (`--in`).
//
// WHY THIS EXISTS: without it, scoping a search meant pointing myco at a subtree
// as its ROOT, which builds a SECOND index there (`<subtree>/.myco`). So "search
// only the compiler's src" cost a whole extra index, and the two indexes then
// drifted independently. Field report 2026-07-25: a session wanted "does this
// token appear anywhere under packages-galerina/**/src" and had no way to ask.
//
// WHY IT IS DANGEROUS, AND WHAT THAT FORCES: a path filter is a COVERAGE CAP the
// user asked for. myco's whole contract (DESIGN §8/§10) is that a cap which hides
// what it dropped turns "no matches" into a lie — the same rule that makes the
// over-size skip and the word-boundary exclusion report themselves. A filter is
// worse than those two, because a typo'd glob (`--in src/` on a tree that stores
// `source/`) excludes EVERYTHING and returns a clean, confident zero that is
// indistinguishable from a genuine absence. So this module reports:
//   - how many candidates the filter removed  (`excluded`)
//   - whether it matched NOTHING in the index (`matchedNothing`) — the typo case
// and the caller is expected to surface both. Nothing here silently narrows.
//
// GLOB SEMANTICS — deliberately NOT the same as the ignore-file compiler in
// walk.ts, and the divergence is the point:
//   - walk.ts globs are ANCHORED whole-path/basename tests for ignore rules, and
//     support `*`/`?` only. Extending that compiler would change ignore semantics
//     for every rule in every .gitignore in the tree — a much larger blast radius
//     than this feature earns.
//   - here a metacharacter-free pattern is a SEGMENT-AWARE PREFIX, because that is
//     what a person means by `--in packages-galerina`: everything underneath it.
//     Prefix matching on raw strings would also match `packages-galerina-enterprise`,
//     which is a different project — so the boundary is the `/`, not the character.
// Supported: `*` (within one segment) · `**` (across segments) · `?` (one non-slash).
// Paths tested are POSIX and root-relative — the form walk.ts stores (walk.ts:27).

/** A compiled `--in` filter: the predicate plus what it was built from, for reporting. */
export interface PathFilter {
  /** True when this path is INSIDE the requested scope. */
  test(relPath: string): boolean;
  /** The original patterns, for the error/summary text. */
  patterns: string[];
}

const META = /[*?]/;

/** Compile one pattern to an anchored regex source. */
function compileOne(pattern: string): string {
  // Normalise: accept Windows separators from a shell-completed path, and a
  // trailing slash (`--in src/`), which means the same as `--in src`.
  let p = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p.startsWith("./")) p = p.slice(2);

  if (!META.test(p)) {
    // No metacharacters => segment-aware prefix: the path IS this, or starts with
    // this followed by a separator. `src` matches `src/a.ts` and `src`, never
    // `srcfoo/a.ts`.
    const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return `${esc}(?:/.*)?`;
  }

  // Metacharacters present => translate. `**` is consumed before `*` so the
  // cross-segment form is not built out of two single-segment ones.
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] ?? "";
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // `**/` at a boundary should also match ZERO segments, so
        // `packages/**/src` matches `packages/src/a.ts` as well as
        // `packages/x/y/src/a.ts`. Without this a user must write two patterns.
        if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; continue; }
        re += ".*"; i += 1; continue;
      }
      re += "[^/]*";
      continue;
    }
    if (ch === "?") { re += "[^/]"; continue; }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A glob naming a directory should still capture what is under it.
  return `${re}(?:/.*)?`;
}

/**
 * Build a filter from one or more `--in` patterns. Multiple patterns UNION (OR):
 * "search here or here" is what a list of places means.
 * Returns a string describing the problem instead of throwing — the CLI turns
 * that into exit 2 rather than silently searching everything (fail-closed: a
 * filter that cannot be honoured must stop the search, never widen it).
 */
export function buildPathFilter(patterns: string[]): PathFilter | string {
  const cleaned = patterns.map((p) => p.trim()).filter((p) => p !== "");
  if (cleaned.length === 0) return "empty --in pattern";
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${cleaned.map(compileOne).join("|")})$`);
  } catch (e) {
    return `invalid --in pattern: ${(e as Error).message}`;
  }
  return {
    patterns: cleaned,
    test: (relPath: string) => re.test(relPath.replace(/\\/g, "/")),
  };
}

/**
 * Apply a filter to a list of records, returning the survivors and the count
 * removed. Kept separate from `test` so every call site reports the same way and
 * none can drop files without producing the number.
 */
export function applyPathFilter<T extends { path: string }>(
  records: T[],
  filter: PathFilter | undefined,
): { kept: T[]; excluded: number } {
  if (!filter) return { kept: records, excluded: 0 };
  const kept = records.filter((r) => filter.test(r.path));
  return { kept, excluded: records.length - kept.length };
}
