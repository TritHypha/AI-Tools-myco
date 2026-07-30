# Zero-trust Index Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.myco/index.json` a bounded, canonical, non-authorizing cache
that cannot make Myco read outside its indexed root.

**Architecture:** A small graph-index contract module validates untrusted
decoded records before `SearchGraph` construction. `SearchGraph.setFile`
repeats the canonical-path invariant, while the store bounds and contains the
physical index file and serializes records in canonical order.

**Tech Stack:** TypeScript, Node built-ins, `node:test`, no runtime
dependencies.

## Global Constraints

- Keep zero runtime dependencies.
- Unknown, malformed, duplicate, over-budget or escaping data refuses.
- The graph remains advisory and cannot grant artifact or execution authority.
- Write tests first and observe the hostile case fail before production edits.
- Implement in standalone Myco, then copy the exact source/tests into
  Galerina's flat top-level `galerina-tools-myco` package.
- Commit locally and never push.

---

### Task 1: Reproduce and close persisted-index path escape

**Files:**
- Create: `test/store.test.ts`
- Create: `src/graph/index-contract.ts`
- Modify: `src/graph/model.ts`
- Modify: `src/graph/store.ts`

**Interfaces:**
- Produces: `isCanonicalIndexPath(value: unknown): value is string`
- Produces: `validateStoredIndex(value: unknown): StoredIndex | null`
- Produces: bounded constants used by the loader and hostile tests

- [x] **Step 1: Write the failing hostile-index test**

Create a temporary root, an outside file and an index containing
`p: "../outside.txt"`. Assert `loadGraph(root) === null`.

- [x] **Step 2: Run the focused test and confirm RED**

Run:

```text
node --experimental-strip-types --test test/store.test.ts
```

Expected: the hostile record is admitted instead of returning `null`.

- [x] **Step 3: Implement the closed validator**

Validate exact object keys, format, metadata, canonical paths, duplicate
paths, term tuple shapes, duplicate terms, positive counts and collection
budgets. Make `SearchGraph.setFile` throw `MYCO-INDEX-PATH` for a
non-canonical path.

- [x] **Step 4: Bound and contain the physical index**

Use `lstat` before reading, reject non-files/symlinks and over-size bytes, and
compare resolved root/index paths so a symlinked `.myco` cannot escape.
Parse into `unknown`; construct a graph only after validation.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run the Task 1 command. Expected: all store tests pass.

### Task 2: Close shape, budget and determinism gaps

**Files:**
- Modify: `test/store.test.ts`
- Modify: `src/graph/store.ts`

**Interfaces:**
- Consumes: Task 1 validator and constants
- Produces: stable path/term ordering in persisted JSON

- [x] **Step 1: Add failing hostile-shape tests**

Cover Windows-drive, UNC, backslash, empty/dot-segment, duplicate path,
duplicate term, non-positive count, unexpected field and over-budget forms.

- [x] **Step 2: Confirm RED for every newly required refusal**

Run the focused store test and inspect each named failure.

- [x] **Step 3: Complete minimal validation and canonical sorting**

Sort stored files by path and each file's terms by term. Do not use
`createdAt` as semantic identity.

- [x] **Step 4: Confirm focused and complete standalone GREEN**

Run:

```text
npm test
```

Expected: every standalone Myco test passes with zero failures.

### Task 3: Document the evidence boundary

**Files:**
- Modify: `README.md`
- Modify: `DESIGN.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: implemented v0.2 index contract
- Produces: public claim that metadata refresh is advisory, not content proof

- [x] **Step 1: Update threat model and public behavior**

Record hostile index files, the closed loader, `--no-refresh` refusal, and the
difference between metadata freshness and content identity.

- [x] **Step 2: Run documentation-sensitive tests**

Run `npm test`; version and CLI behavior must remain green.

- [ ] **Step 3: Commit standalone Myco**

Commit only the scoped source, tests and documentation. Never push.

### Task 4: Re-vendor exact behavior into Galerina

**Files:**
- Create: `Galerina/packages-galerina/galerina-tools-myco/tests/store.test.ts`
- Create: `Galerina/packages-galerina/galerina-tools-myco/src/graph/index-contract.ts`
- Modify: corresponding Galerina Myco source and package documentation

**Interfaces:**
- Consumes: exact committed standalone Myco implementation
- Produces: byte-matched source behavior in the flat Galerina package

- [ ] **Step 1: Copy the committed source/test slice**

Preserve Galerina-only package metadata and integration wording.

- [ ] **Step 2: Run focused Galerina Myco tests**

Run `npm.cmd test` in `galerina-tools-myco`. Expected: all tests pass.

- [ ] **Step 3: Run the Galerina aggregate and graph checks**

Run the complete package aggregate and the roadmap/graph checks required by
the live TODO.

- [ ] **Step 4: Update TODO/R&D adjudication and commit**

Record the original reproduction, zero-trust score, exact upstream commit,
vendored parity and residual evidence-tier work. Never push.
