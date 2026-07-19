# Changelog

All notable changes to myco are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semantic](https://semver.org/), with the pre-1.0 caveat that minor versions may
still change behaviour.

A theme runs through this file and is worth stating once: **most myco releases
have fixed a case where the tool returned a narrower answer than the truth
without saying so.** Each one is listed as a fix, but the recurring lesson is
that the silence was the defect, not the narrowing.

## [Unreleased]

### Fixed

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
