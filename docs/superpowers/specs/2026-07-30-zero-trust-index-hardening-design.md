# Zero-trust index hardening design

Date: 2026-07-30

Status: approved for implementation by the owner's standing full-auto,
zero-trust direction

## Problem

Myco correctly describes `.myco/index.json` as a rebuildable advisory cache,
but the current loader trusts its decoded paths and term graph. A crafted
record such as `../outside.txt` is admitted and, with `--no-refresh`, reaches
`path.join(root, record.path)`. A fresh reproduction proved that Myco then
reads and returns matching content outside the indexed root.

The new deterministic-graph research also exposes three weaker properties:

- the decoded index has no closed structural or resource contract;
- serialization order follows filesystem/`Map` insertion order rather than a
  canonical order; and
- metadata equality is called “fresh” even though size plus modification time
  is not content identity.

## Considered approaches

### 1. Path check only

Reject `..` and absolute paths while otherwise preserving the loader.

This is the smallest patch, but it leaves malformed graph records, duplicate
identities and unbounded decoded collections inside the cache boundary. It is
necessary but not sufficient.

### 2. Hash every file before every search

Re-hash the complete tree and use content digests as the only freshness proof.

This gives the strongest negative-search evidence, but it turns every query
back into a complete byte scan and removes Myco's repeat-search advantage.
It remains appropriate as a future explicit evidence tier, not as the only
interactive mode.

### 3. Bounded typed cache plus explicit evidence tiers

Immediately make the persisted graph a bounded, closed, canonical,
non-authorizing proposal. Independently reject unsafe paths at graph
construction and file resolution. Later add a content-verified mode whose
receipt can support security-sensitive absence claims, while ordinary
metadata-refresh mode remains clearly labelled advisory.

This is the selected approach.

## Immediate security floor

The v0.2 index contract will:

- admit only an exact top-level shape and exact file-record shape;
- bound index bytes, file records, term edges, path length and term length;
- admit only canonical non-empty POSIX-relative paths with no empty, `.`,
  `..`, backslash, POSIX-absolute or Windows-absolute segment;
- reject duplicate paths and duplicate terms;
- admit only finite non-negative metadata and positive safe-integer counts;
- refuse index symlinks or an index whose resolved location escapes the root;
- sort file records and term records before persistence; and
- treat any malformed persisted graph as absent so normal refresh rebuilds it
  and `--no-refresh` refuses rather than searching partial evidence.

`SearchGraph.setFile()` will enforce the path invariant as a second boundary.
The search layer therefore cannot receive an escaping path through either the
persisted loader or a programmatic graph constructor.

## Later R&D lane

The following are deliberately not hidden inside this security patch:

- atomic/durable advisory-cache publication;
- a versioned semantic index digest excluding observational timestamps;
- `METADATA_FRESH`, `CONTENT_VERIFIED` and `INDETERMINATE` evidence states;
- a strict mode that hashes all candidate-affecting source bytes before an
  absence claim;
- seeded index/fault simulations with replay receipts; and
- a signed release-tree receipt for using Myco output in Galerina audits.

These require measured cost and compatibility work. Until then, Myco output
remains discovery evidence and never artifact, policy or execution authority.

## Verification

The implementation is acceptable only when:

- a hostile `../outside.txt` index test fails before the fix and passes after;
- POSIX, Windows-drive, UNC, backslash and dot-segment forms refuse;
- malformed/duplicate/over-budget graph shapes refuse;
- a valid saved index round-trips;
- serialization order is stable apart from `createdAt`;
- all standalone Myco tests pass;
- the exact source/test change is re-vendored into Galerina; and
- Galerina's Myco package and full aggregate pass.

