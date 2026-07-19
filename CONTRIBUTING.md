# Contributing to myco

Thanks for looking. myco is small, dependency-free and deliberately opinionated,
so this is short.

## Getting set up

Requires Node.js 18+ (Node 22.6+ to run from source without building).

```
git clone https://github.com/TritHypha/myco.git && cd myco
npm install
npm test          # 23 tests, should be green before you change anything
npm run build     # tsc -> dist/
```

Run from source with no build step:

```
node --experimental-strip-types src/cli.ts "pattern" .
```

## The one rule that matters

**A search result that is narrower than the truth must say so.**

myco's whole value is that you can trust a miss. If a cap, a boundary rule, a
time budget or a skip removes something, the summary line reports it and names
the flag that gets it back. We have shipped this bug before — whole-word matching
silently discarded every call site of `foo(` and reported the remainder as though
it were the whole answer, and a real decision was made on the wrong number. So:

- If your change can make a result narrower, it must also make that visible.
- Prefer failing loudly over succeeding quietly.
- A count that could be a subset should never be printed as if it were a total.

The over-size skip note and the whole-word exclusion note are the two worked
examples in the code; follow their shape.

## Design constraints

These are not up for casual change — open an issue first if you want to argue
with one:

- **Zero runtime dependencies.** Node built-ins only. Dev dependencies
  (TypeScript, `@types/node`) are fine; they never ship.
- **Erasable-syntax TypeScript only** — no enums, no parameter properties, no
  decorators. The source must run directly under `node --experimental-strip-types`.
- **The index is derived, never authoritative.** `.myco/index.json` stores the
  forward index only; everything else is rebuilt in memory on load. It must never
  contain an absolute path.
- **Two-phase search stays two-phase** — prune via the graph without I/O, then
  verify by reading only candidates.

## Tests

`npm test` runs `node --test` over `test/*.ts`. Every behavioural change needs a
test, and please make it a *real* one:

- **Pin the bug you fixed, in the shape it actually appeared.** Our regression
  fixtures use the real-world case (`assembleWAT(cleanWat)`), not a synthetic
  `foo(bar)`, because the synthetic version passed while the tool was broken.
- **Prove non-vacuity.** A test that would pass with the feature removed is not a
  test. Where it is cheap, assert both directions: the thing matches *and* the
  decoy does not.
- Keep tests hermetic — build a temp fixture tree, clean it up in `finally`.

## Pull requests

- One logical change per PR; a green `npm test` and a clean `npm run build`.
- Explain **what you measured**, not just what you changed. "Before: 5 files.
  After: 99." is the most useful sentence in a search-tool PR.
- Update `README.md` if you change user-visible behaviour, and `CHANGELOG.md`
  under `Unreleased`.
- Do not commit `dist/`, `node_modules/`, or any `.myco/` index.

## Reporting bugs

Open an issue with the pattern, the flags, what you expected, and what you got.
If it is a *precision* bug — myco found too few or too many — include the
comparison against `-s` (substring) or `grep`, since the difference is usually
the whole diagnosis.

**Security issues do not go in the tracker** — see [SECURITY.md](SECURITY.md).

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

myco is Apache-2.0. Contributions are accepted under the same licence
(Apache-2.0 §5) — you keep your copyright, and you grant the project the licence
in the file. There is no CLA.
