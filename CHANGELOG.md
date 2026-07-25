# Changelog

All notable changes to myco are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semantic](https://semver.org/), with the pre-1.0 caveat that minor versions may
still change behaviour.

A theme runs through this file and is worth stating once: **most myco releases
have fixed a case where the tool returned a narrower answer than the truth
without saying so.** Each one is listed as a fix, but the recurring lesson is
that the silence was the defect, not the narrowing.

## [0.1.4]

Two more silent-narrowing fixes, found the same day by two independent sessions —
this file's standing theme, again: the narrowing was defensible, the silence was not.

### Added

- **`node_modules` is pruned by default — loudly — with `--vendored` to include it.**
  At an un-gitted root (a hub directory of many repos) nothing ignores vendored
  trees, so a hub-level index drowned in them. They are now skipped like build
  infrastructure, but unlike `.git`/`.myco` the skip is REPORTED: `myco index`
  names each pruned dir, a search prints a one-line note, and `--vendored`
  restores full coverage. A vendored miss can no longer read as absence.
- **Regex-intent warning.** A pattern carrying strong regex signals (`a|b`, `\(`,
  `\d`, `.*`, `^`/`$` anchors) outside `-e` runs as a LITERAL — correct, but it
  misled two verification probes in one day (a literal `codePoint\(\)` missed a
  file that contains `codePoint()`). myco now says so up front:
  `pattern looks like a regex but ran as a LITERAL word match; pass -e for regex`.
  Deliberately narrow — `foo(`, `.fungi`, `c++` stay quiet.
- **`(0 searched)` now explains itself.** Phase-1 candidate pruning AND-intersects
  the query's word terms; when no file contains them all, zero files are opened.
  The summary now appends `index pruned all candidates: no file contains ALL the
  query's words — miss ≠ absent (regex? use -e)`, and the JSON summary carries
  `prunedToZero`.

### Fixed

- **A leading `**/` in an ignore rule now matches at any depth.** myco's glob turned
  each `*` into `[^/]*`, so `**` collapsed to a single path segment and git's very
  common `**/build/`, `**/.fungi-cache/`, `**/node_modules/` idiom was silently
  unmatched — a nested build cache that a *correct* `.gitignore` already excluded was
  still indexed (git honoured it; myco did not). A leading `**/` is now stripped so the
  remainder matches by basename at any depth. Deeper mid-path `**` remains unsupported
  (documented). Companion to the nested-`.gitignore` fix below.

- **Nested `.gitignore` / `.mycoignore` files are now honoured, scoped to their own
  subtree.** Previously only the root-level ignore file was read, so a subproject
  that ignored its own build output in *its own* `.gitignore` was silently
  overridden. On a real tree a Rust subproject's `dss-host/.gitignore` `/target`
  was ignored and its cargo `target/` incremental-compilation cache — tens of
  thousands of `.bin` artefacts — was indexed, bloating both the on-disk index and
  the pre-search incremental refresh until a whole-tree search timed out. Each
  directory's own ignore file is now loaded as the walk descends and applied only
  to paths beneath it (a rule from `sub/.gitignore` cannot affect a sibling of
  `sub/`). Measured on that tree: **28k files → 4,059**, **index 361 MB → 10.7 MB**,
  **index/refresh 23.6s → 3.8s**. The recurring lesson holds — the silent scope
  violation (indexing what the project said not to) was the defect, not the size.

- **Whole-word matching no longer discards every call site of a pattern ending in
  punctuation.** The word-boundary lookaround was applied at *both* edges
  unconditionally, including where the pattern's own edge character was already a
  non-word character. For `foo(` the trailing test landed on the character *after*
  the paren, so `foo(bar)` was rejected while `foo("x")`, `foo()` and the
  declaration survived — a total failure that read as a small under-count.
  Boundary tests are now applied **per edge**, only where the pattern's own edge
  character is a word constituent. `foo(` keeps whole-word protection on its left
  (still no match inside `refoo(`) and stops filtering on its right.

  Measured on a real tree: `assembleWAT(` went from **5 files to 99**;
  `renderWAT(` from **2 to 106**.

  This is a deliberate divergence from `grep -w`, which applies both edges
  unconditionally — but grep's *default* is not `-w`, while myco's is, so the same
  semantics become a trap rather than an opt-in.

### Added

- **Word mode now reports what the boundary rule discarded.** When whole-word
  matching rejects files that contain the pattern verbatim, the summary says so
  and names the escape hatch:

  ```
  0 hits · 0 files · (44 searched) · 4 files contain the pattern but were
  excluded by whole-word matching — try -s
  ```

  A legitimately narrow result stays narrow — this is not a semantics change — but
  it can no longer be mistaken for absence. Exposed as `wordBoundaryExcluded` in
  `--json`. A genuinely absent pattern reports zero exclusions.

## [0.1.3] — 2026-07-18

### Added

- **ReDoS guard on user regexes** (`-e`). Patterns that are exponential by
  construction — nested unbounded quantifiers such as `(a+)+`, absurd bounded
  repetition counts — are **refused before compilation**, and matching is bounded
  by an input-length cap and a wall-clock budget. A search can no longer be turned
  into a hang.

  Honest scope: a mitigation, not immunity. Full immunity needs a non-backtracking
  engine; the static refusal plus the bounds close the practical hole.

### Fixed

- `--version` reported `0.1.0` after a release. The version-drift test now pins
  the `VERSION` constant to `package.json` and caught the incomplete bump itself.

## [0.1.2] — 2026-07-16

### Fixed

- **Over-size file skips are no longer silent.** Files above `--max-size` were
  omitted from the index with no indication. They are now counted, listed by
  `myco index`, and noted on the search path. A coverage cap is never a silent one.
- Version drift between `package.json` and the `VERSION` constant, plus a
  regression test that fails if they diverge again.
- Encoding repair in `README.md`, `DESIGN.md` and `package.json`.

## [0.1.1] — 2026-07-16

### Fixed

- **Leading-dot filename queries are extension matches.** `-f .fungi` matched only
  283 of 447 files, because the word-mode lookbehind at the dot demands a non-word
  character while every ordinary stem ends in one — so `stem.fungi` could never
  match. A slash-free filename query beginning with `.` is now an `endsWith` match.
  Smart-case preserved; content search untouched; decoys covered (a directory
  named like the extension, and a `.fungi.bak` suffix).

## [0.1.0] — 2026-07-11

Initial release. *grep, but it grows a graph.*

- Graph index: `file --contains--> term`, with a persisted forward index and
  inverted/filename indexes rebuilt in memory on load.
- Two-phase search — prune via the graph without I/O, then verify by reading only
  candidate files.
- Whole-word matching by default, `-s` substring, `-e` regex.
- Smart-case, Unicode-correct folding (accents preserved, case folded).
- Filename and content search through the same graph.
- Incremental refresh on every search; `--no-refresh` to skip.
- Ranked output, `.gitignore`/`.mycoignore` support, binary and size skips.
- Zero runtime dependencies.

[Unreleased]: https://github.com/TritHypha/myco/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/TritHypha/myco/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/TritHypha/myco/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/TritHypha/myco/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/TritHypha/myco/releases/tag/v0.1.0
