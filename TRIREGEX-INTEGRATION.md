# Myco and TriRegex integration review

**Status: PARTIAL — Myco's JavaScript regex path is now pre-emptible; a native
TriRegex backend remains BLOCKED by named compatibility work.**

## Measured baseline

- **MEASURED:** standalone Myco `0.2.1` uses an inverted file/term graph, then
  verifies candidate files. Regex has no safe index prune and scans the selected
  indexed set.
- **MEASURED:** the previous static guard rejected several nested-quantifier
  shapes, but accepted overlapping alternation such as `(a|aa)+$`. Its time
  budget was checked only between files, so one synchronous JavaScript regex
  operation could block the process.
- **MEASURED:** Myco now runs every accepted JavaScript regex operation in a
  worker with a hard deadline. Timeout, result cap, whole-search timeout and
  over-size line-prefix coverage are distinct evidence. Incomplete coverage
  exits `2`; a caller cannot mistake it for proved absence.
- **MEASURED:** TriRegex uses a non-backtracking NFA and produces a compile-time
  work certificate. Its standalone suite includes hostile-pattern, streaming,
  budget, certificate and native-membership differential tests.
- **MEASURED:** Galerina's read-only `@galerina/tools-myco` package is a mirror
  pinned to standalone Myco commit `e5e0e25` and version `0.1.3`; it does not
  contain current standalone Myco `0.2.x` changes.
- **MEASURED:** that mirror is not byte-identical to its declared pin.
  `src/cli.ts`, `src/ingest/walk.ts`, and `src/query/search.ts` have different
  Git blob identities. The vendored `walk.ts` and `search.ts` blobs occur in
  later standalone history around the `0.1.4` fixes; the vendored `cli.ts` blob
  has no exact match in the inspected standalone history. Treat the current
  provenance stamp as incorrect until the Galerina owner reconciles it.

What was not checked: browser runtimes, non-Node JavaScript engines, very large
repository performance, operating-system resource exhaustion, or a production
Galerina integration. No performance claim is made.

## Why TriRegex is not yet a drop-in replacement

| Requirement | Current status | Required closure |
|---|---|---|
| First boolean match | SHIPPED in TriRegex | Retain |
| All non-overlapping line matches | BLOCKED | Certified-linear `findAll`; no suffix-rescan or hidden quadratic work |
| Case-insensitive/smart-case | BLOCKED | Exact declared Unicode or ASCII profile and differential corpus |
| Word boundary `\b` / `\B` | BLOCKED | Streaming boundary semantics and chunk-split tests |
| Span units | BLOCKED | Myco reports UTF-16 columns; TriRegex currently reports code-point spans |
| JavaScript subset compatibility | PARTIAL | Versioned supported/refused matrix; never silently reinterpret syntax |
| Empty/zero-width global matches | BLOCKED | Progress rule identical across whole and chunked inputs |
| Line-oriented `^`/`$` | PARTIAL | Freeze whether Myco supplies one line or one file and how final newlines behave |
| Match/result limits | BLOCKED | Limits must be certificate inputs and produce explicit incomplete evidence |
| Regex literal extraction for graph prune | PROPOSED | Extract only mandatory literals; uncertain extraction scans all candidates |
| Independent differential evidence | PARTIAL | Add Myco corpus against the selected compatibility profile |

## Dependency-ordered backlog

1. **TriRegex:** add a certified-linear, bounded-memory `findAll` contract.
2. **TriRegex:** freeze case, boundary, zero-width and span-unit semantics.
3. **Myco:** introduce a `RegexBackend` interface returning matches plus explicit
   refusal/truncation evidence.
4. **Both:** run one shared valid/refused/malformed/adversarial corpus.
5. **Myco:** make TriRegex the preferred backend for the certified subset.
6. **Myco:** retain the worker-contained JavaScript backend only as an explicit
   compatibility profile; never silently fall back from a TriRegex refusal.
7. **Galerina owner:** first reconcile the three-file undeclared drift, then
   re-vendor Myco only after its own package tests and mirror provenance are
   updated. The Galerina repository was read-only in this review.

## Security invariant

`TriRegex refusal → JavaScript fallback` is **REJECTED** as an automatic rule.
A refused construct is not authority to run it in a less predictable engine.
Any compatibility fallback must be explicitly requested, worker-contained,
bounded, and reported in machine-readable output.
