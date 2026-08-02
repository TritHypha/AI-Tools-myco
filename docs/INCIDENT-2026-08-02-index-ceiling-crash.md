# Incident — 2026-08-02 — `myco` aborts with exit 134 at a multi-repository root

Post-mortem for the crash fixed in `836a742`. Written for a maintainer who was
not present: what happened, why, what changed, and what is still open.

Companion R&D record: `ZTF-Knowledge-Bases/RD-0678-myco-index-ceiling-regression-and-fix.md`.

---

## 1 · What occurred

Running a content search from a directory containing several sibling
repositories killed the process:

```text
$ myco "branch predict"
<no output>
$ echo $?
134
```

Exit 134 is `SIGABRT` — the V8 heap abort. No message, no partial result, no
indication of which limit was hit or what the user should do differently. The
same command had worked before, and no myco release had changed the search path.

Reproduced twice, identically, before any diagnosis was attempted.

## 2 · What was actually wrong

The crash was the third event in a chain, not the fault itself.

`810058c` (2026-07-31) introduced a bounded index contract, including
`MAX_INDEX_TERM_EDGES = 2_000_000`. It was enforced **only when reading**. Three
consequences followed, in order:

**① The writer produced files the reader must reject.** `saveGraph()` had no
limit check at all. Any tree above the ceiling serialised happily to
`.myco/index.json`, and `validateStoredIndex()` then rejected that same file on
the next run. A contract enforced on one side is not a contract — it is a
guarantee that the two halves will disagree.

**② The rejection was indistinguishable from an absence.** `loadGraph()`
returned `null` both for "no index on disk" and for "index present but refused".
The CLI branched on that single value:

```ts
if ((await loadGraph(root)) === null) {
  process.stdout.write(`myco: indexing ${path.resolve(root)} (first run)…\n`);
}
```

So a permanently-rejected cache announced `(first run)` on **every** invocation.
The tool was not silent — it was wrong in a reassuring direction, which is why
this survived a week unnoticed.

**③ The rebuild then exhausted the heap.** Having discarded the cache, myco
re-indexed the whole tree, produced a graph that exceeded the same ceiling
again, and died while serialising it. Every run repeated the full cost, and on a
tree this size the cost was the process.

### Measured, not inferred

The index at the multi-repository root was **42,585,553 bytes (40.6 MiB)**.
Instrumenting the load pipeline stage by stage:

| stage | heap after |
|---|---:|
| start | 4.7 MB |
| `readFile` | 85.9 MB |
| `JSON.parse` | 371.7 MB |
| validator's rebuild (a second copy of every edge) | 539.3 MB |
| in-memory graph (forward + inverted) | 883.4 MB |
| **peak RSS** | **1,024 MB** |

Contents: **11,110 files · 3,063,529 term edges · 131,685 distinct terms.**

Against the contract:

| limit | value | this index |
|---|---:|---|
| `MAX_INDEX_BYTES` | 64 MiB | 40.6 MiB — passes |
| `MAX_INDEX_FILES` | 250,000 | 11,110 — passes |
| `MAX_INDEX_TERMS_PER_FILE` | 100,000 | 6,744 — passes |
| `MAX_INDEX_TERM_EDGES` | 2,000,000 | **3,063,529 — exceeds** |

One limit of four, exceeded by 53 %, discovered only after ~540 MB had been
spent proving it.

### Why the ceiling could not self-correct

```text
2026-07-25 18:51   index.json written by 0.2.0 — no ceiling existed yet
2026-07-31 00:07   810058c adds MAX_INDEX_TERM_EDGES, read side only
```

The hardening commit is sound work and its limits are the right ones. But it
added a reader-side ceiling with **no writer-side counterpart and no migration
path**, which silently invalidated every pre-existing index above the limit —
and left the tool no way to recover, because re-indexing reproduced the same
over-ceiling file.

### Where the gap really came from

`docs/superpowers/plans/2026-07-30-zero-trust-index-hardening.md` states the
goal as making the index *"a bounded, canonical, non-authorizing cache that
cannot make Myco read outside its indexed root"*, with the constraint that
*"unknown, malformed, duplicate, over-budget or escaping data refuses"*.

Every task under it concerns validating **decoded untrusted input**: hostile
paths, Windows-drive and UNC forms, duplicate terms, symlinked index
directories. The threat model was **a hostile index file supplied by someone
else**. It never asked what happens when *our own writer* emits a file our own
reader refuses.

The implementation executed the plan faithfully. **The omission is in the threat
model, not the code** — which is why the tests all passed and the defect shipped
anyway. A validator that only ever considers adversarial input will not notice
that the friendly input is also out of range.

## 3 · What the fix changes

Committed `836a742`. **The ceiling is unchanged** — it was correct. What changed
is when it applies and whether it speaks.

| change | effect |
|---|---|
| `saveGraph()` returns a `SaveOutcome` and **declines** to write an over-ceiling index | no artifact is left that the reader is obliged to refuse; the cache-miss loop cannot start |
| `loadGraphOutcome()` returns `ok` / `absent` / `rejected` | the two states that need different remedies stop sharing a signal; `loadGraph()` is kept as a wrapper so existing callers are untouched |
| `buildIndex()` stops at the ceiling with `MYCO-INDEX-TOO-LARGE` | a named refusal with the limit, the file count reached and the remedy — instead of a heap abort |
| `SearchGraph.termEdgeCount()` maintains the total incrementally | the budget is checkable in O(1) after every file, rather than discovered once the graph is too large to hold |
| the ceiling is tightenable for tests, clamped against being raised | the refusal paths are covered without a multi-million-edge fixture, and no caller can lift a limit the reader enforces |

### Behaviour, before and after

Before — exit 134, no output at all.

After:

```text
myco: existing index at <root>/.myco was REFUSED (over a contract limit,
corrupt, or an incompatible format) — re-indexing…
myco: MYCO-INDEX-TOO-LARGE: <root> exceeds the index ceiling of 2,000,000
term edges (reached at 9581 files). Index a narrower root — e.g. a single
repository rather than a directory of repositories.
```

Exit 2.

### Evidence

- Build clean; suite **77/77** (69 pre-existing, 8 new).
- Every new refusal test is paired with a **control exercising the permitted
  axis** — a permitted save writes a file, a tree under the ceiling indexes
  cleanly, a valid index loads as `ok`. Without those, the refusal tests would
  still pass if the code simply never did anything.
- Verified end to end on the tree that crashed, and on unaffected repositories:
  a search over a normal repo returns real hits and `myco status` reports
  normally.

## 4 · Still open

- **Stale caches elsewhere.** Two sibling `.myco` indexes (~17.9 MB and
  ~12.7 MB) were written before the ceiling existed and are likely over it. They
  are inert and will now announce themselves as `REFUSED`, but they are dead
  bytes until deleted. `.myco` is a gitignored, regenerable cache.
- **The Galerina mirror is unported.** `galerina-tools-myco` is also 0.2.1 and
  carries the same defect. Task 4 of the hardening plan (re-vendor into
  Galerina) is unchecked, as is Task 3 Step 3. This is a reconcile-not-copy job
  under a different session's custody.
- **Is 2,000,000 the right number?** The refusal is correct fail-closed
  behaviour, but a genuinely large tree now has no supported path except
  narrowing the root. Whether the ceiling should scale — or whether an index
  should shard per subtree — is a design question this fix does not answer.
- **Not pushed.** `836a742` sits on `codex/zero-trust-index-hardening`.

## 5 · Post-incident closure - 2026-08-02

- The Galerina mirror is now reconciled with the upstream fix rather than
  independently rewritten.
- A second TDD pass found and closed one remaining distinction error: the loader
  treated every filesystem exception as absence. Only `ENOENT` now means
  absent; invalid-path, permission and I/O failures are rejected.
- Fresh upstream evidence: no-emit TypeScript check passed, build passed, and
  **78/78** tests passed.
- Fresh Galerina-mirror evidence: typecheck passed, build passed, and **80/80**
  tests passed, including CLI status controls.
- The 40.61 MiB repository-parent cache remains on disk by owner-safe choice.
  It is derived, inert and explicitly refused; it was not deleted.

The remaining design question is sharding or another bounded large-tree index,
not correctness of the fixed ceiling contract.

## 6 · The transferable lesson

> **A limit enforced on one side of a contract is worse than no limit.** It
> converts a bounded resource problem into an unbounded silent one. Before this
> commit myco had a ceiling; what it lacked was a ceiling anything could act on.

And the second, which myco had already solved elsewhere and simply had not
applied here:

> **A refusal that shares a signal with an absence will be read as an absence.**

Compare the query path, which gets this exactly right:

```text
0 hits · 0 files · (0 searched) · 14 candidates outside --in (not searched) ·
⚠ --in matched NO indexed path — the scope is empty, so this zero says nothing
about the tree (check the glob; paths are root-relative)
```

That is the standard. `null` meaning both "no index" and "index refused" was the
same defect the project had already fixed for search results, left unfixed one
layer down.
