# myco — design & R&D notes

## 1. Goal and non-goals

**Goal.** A search tool that is *more precise* and *faster on repeat use* than
grep, by treating a directory as a **graph** you traverse rather than a stream of
bytes you re-scan. Precision means: whole-word by default, case-folded but
accent-preserving, filenames and contents in one model, ranked results.

**Non-goals.**
- Beating [ripgrep](https://github.com/BurntSushi/ripgrep) on a cold, one-off
  scan. ripgrep's parallel, SIMD-accelerated Rust is the right tool for that.
  myco's edge is the **persistent graph** (repeat queries, precision, and a
  structure layer), not raw first-scan throughput.
- Being a language server. The optional code-structure layer (§9) is deliberately
  lightweight.

## 2. Prior art (honest positioning)

| Tool | Index | Precision model | myco's difference |
|---|---|---|---|
| `grep` | none | regex/substring, full scan | myco indexes once, then traverses |
| `ripgrep` | none (respects `.gitignore`) | regex, full scan, very fast | myco persists a graph; word-precise default |
| `ctags` | symbol tags | definitions only | myco indexes *all* terms, not just symbols |
| Zoekt / Sourcegraph | trigram | regex over trigram index | myco is a local CLI; word-token graph |
| livegrep | suffix array | substring | myco is token/graph based, incremental |

myco's lineage is closest to a code-search **index engine**, shrunk to a
zero-dependency local CLI and modelled explicitly as a graph so a code-structure
layer can be added without reshaping the store.

## 3. The graph model

A tree of files becomes a bipartite graph:

```
        contains[count]
  (file) ───────────────▶ (content-term)
    │
    │ named-by
    ▼
  (name-term)
```

- **File nodes** carry `{ path, mtimeMs, size }` — the last two drive incremental
  re-indexing.
- **Content-term nodes** are case-folded word tokens found in file contents.
- **Name-term nodes** are the word tokens of a file's path.
- **Edges** are the postings: `file --contains[n]--> term`. A search is a lookup
  of a term node followed by a walk of its edges to the file nodes.

Implementation: the nodes/edges are backed by `Map`s for O(1) lookup
(`src/graph/model.ts`). The graph is the *model*; the maps are the
*representation*.

### Three indexes, one source of truth

- **Forward** (`file → term counts`) — the **persisted** source of truth.
- **Inverted** (`term → files`) — derived in memory; the edges a query walks.
- **Name** (`path-term → files`) — derived in memory from paths.

Only the forward index is written to disk (`.myco/index.json`). The inverted and
name indexes are rebuilt on load. This is what makes incremental indexing cheap:
to update a file we replace one forward entry and patch the derived edges; to
persist we serialize the forward entries. It also means the on-disk format never
stores absolute paths (see §8).

## 4. Indexing pipeline (`src/ingest`)

1. **Walk** (`walk.ts`) — enumerate files, metadata only (no reads). Apply ignore
   rules (§7), skip symlinks, skip files over the size cap.
2. **Change check** (`indexer.ts`) — compare `mtimeMs`+`size` against the loaded
   index. Unchanged ⇒ reuse the stored term counts. Changed/new ⇒ read.
3. **Binary sniff** (`binary.ts`) — a NUL byte in the first 8 KB ⇒ skip (the same
   heuristic git uses).
4. **Tokenize** (`tokenize.ts`) — split on Unicode word runs, case-fold, count.
5. **Update graph** — `setFile()` replaces the node and patches every derived
   edge; vanished files are dropped.

Incremental by construction: re-indexing after editing one file re-reads exactly
one file.

## 5. Query pipeline (`src/query/search.ts`)

Two phases:

1. **Prune** — from the query's word-terms, compute candidate files by walking the
   inverted index. No file I/O.
   - *word*: intersection of the exact term → files sets.
   - *substring*: for each token, union of every dictionary term that contains it,
     then intersect across tokens (still index-driven).
   - *regex*: no reliable prune → scan all indexed files (documented cost).
2. **Verify** — read only the candidate files and confirm real matches with a
   precise `RegExp` (word-boundary / substring / raw regex), honoring smart-case.

Because phase 1 uses the graph, a selective query reads a handful of files where
grep reads the whole tree. The AND-intersection means a two-word query is *more*
selective, not less.

### Smart-case

`caseSensitive: "smart"` ⇒ the query is case-sensitive **iff** it contains an
upper-case letter. Lower-case queries fold; a deliberate capital opts into
precision. Overridable with `-i` / `-S`.

### Ranking

Files with more hits rank first, then shorter paths, then alphabetical; lines
ascend within a file. The most relevant file lands at the top instead of
filesystem order.

## 6. Normalization

`foldCase(s) = s.normalize("NFC").toLowerCase()` — NFC so composed/decomposed
accents compare equal, then case-fold. We **do not** strip accents: a capital is
noise, an accent is a different word. The same `WORD_CHAR` class
(`[\p{L}\p{N}_]`) defines "a word" for both the tokenizer and the word-boundary
matcher, so they can never drift.

## 7. Ignore semantics

A *practical subset* of `.gitignore`, chosen to be predictable:

- no `/` ⇒ basename glob, matched at any depth (`*.log`, `node_modules`)
- contains `/` ⇒ path prefix, anchored at root
- trailing `/` ⇒ directory-only
- leading `!` ⇒ negate; last match wins
- `*` and `?` are globs; **`**` and advanced forms are not supported**

`.git` and `.myco` are always skipped. `.mycoignore` and (by default)
`.gitignore` are read from the root. This is not bug-for-bug gitignore
compatibility, and that is deliberate.

## 8. Safety posture

myco reads files and writes only `./.myco/`. Notable choices:

- **No absolute paths persisted.** The index stores paths relative to the root;
  the root is derived from where `.myco/` sits. The artifact is portable and
  never embeds a machine path.
- **Symlinks are not followed** during the walk — avoids cycles and escaping the
  root.
- **No code execution, no network.** Pure Node built-ins; nothing is `eval`'d.
- **Binary + size caps** bound memory and avoid junk terms — and the size cap is
  **visible, never silent**: over-size skips are counted in the index stats,
  named one-per-line by `myco index`, and flagged with a one-line note on the
  search path (stderr only, so piped/JSON stdout stays clean). A bounded
  coverage cap that hides what it dropped turns "no matches" into a lie.
- Regex is user-supplied and run only against file text (no ReDoS mitigation yet
  — see §10).

## 9. Extension: the code-structure layer (roadmap)

The graph is shaped so code-awareness is additive, not a rewrite. New node kind
`symbol` and new edges:

```
  (file) ──defines──▶ (symbol) ◀──references── (file)
                          │
                          └──calls──▶ (symbol)
```

A per-language extractor (tree-sitter or a light parser) emits `defines`/
`references`/`calls` during indexing; queries like "where is `X` defined" or
"who calls `X`" become graph walks alongside the existing term traversal. The
forward/inverted split already supports adding a second edge type.

## 10. Known limitations (honest)

- **In-memory JSON index.** Fine for typical repos; a very large tree will want a
  columnar/binary store and streaming. Roadmapped.
- **No positional index.** Verify re-reads candidate files to get line/col. A
  positional index would let common-term queries skip the re-read.
- **Regex = full scan** of the indexed set (no literal extraction to prune yet).
- **No ReDoS guard** on user regex. A future version should bound backtracking or
  use a linear engine.
- **Ignore is a subset**, not full gitignore (§7).
- **Content-skipped files are name-invisible too.** A binary or over-size file
  gets no file node at all, so `-f` filename search cannot find it either —
  the same "miss reads as absent" failure the over-size reporting now guards
  on the content side (over-size paths are at least listed by `myco index`).
  Candidate fix: index content-skipped files with an empty term set, so the
  name index still sees them; the prune phase would never surface them for
  content queries (no terms), so content search semantics are unchanged.

## 11. Testing

`npm test` runs the `node:test` suite (`test/*.test.ts`) via native TypeScript
type-stripping — no build step. Coverage: tokenization/folding, the ignore walk +
size cap, and the search matrix (word vs substring precision, smart-case,
filename search, regex, no-match). The precision claim (word ⊊ substring) is
pinned by an assertion, not just documented.

## 12. Ternary / 3rd-axis speed R&D (KB RD-0440)

*Design-stage, benchmark-gated; no perf number claimed. Honest framing: myco's edge is the persistent graph, not
cold-scan throughput — these sharpen the repeat-query advantage, they do not make myco ripgrep.*

Where a **genuinely ternary** idea targets a real hot-path cost (both verified in `src/query/search.ts`):

- **Win 1 — a ternary prune-verdict {definite-hit / definite-miss / needs-verify} + a positional index.** For a
  *word* query the posting is authoritative (the file definitely contains the term), so with a `term → (file,
  [line,col])` positional index the verdict is DEFINITE-HIT and the phase-2 **re-read is skipped**; substring/regex
  stay the third value (NEEDS-VERIFY — the posting over-approximates). Targets §10 #2 (the re-read); highest-value, a
  0.2 candidate.
- **Win 2 — a ternary search trie (TST) for the term dictionary.** The substring prune's whole-dictionary `.includes`
  scan is the classic TST case (the 3-way `<=>` branch) for **prefix** candidate lookup. Honest bound: a TST helps
  prefix, not arbitrary contains-substring (that wants a trigram / suffix index).
- **Win 3 — a ternary binary-sniff {text / binary / indeterminate-encoding}.** Adds an INDETERMINATE bucket routed to
  a deeper encoding probe, fixing the UTF-16-sniffed-as-binary skip without slowing the common 2-valued path
  (correctness-first).

**Not applicable (honest):** the governance three-valued logic (K3 authorization) and photonic acceleration are
irrelevant to a local read-only search tool's speed. The word-query prune is already `Map`-fast; the 3rd axis speeds
the *verify*, not the prune. Full assessment: KB `RD-0440`.
