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
   A term of at most 4,096 UTF-16 code units is admitted. Longer terms are
   omitted without truncation and counted on the file record.
5. **Update graph** — `setFile()` replaces the node and patches every derived
   edge; vanished files are dropped.

Incremental by construction: re-indexing after editing one file re-reads exactly
one file. This is deliberately labelled **metadata freshness**, not content
identity. A filesystem or hostile tool can preserve size and modification time
while changing bytes. Any future use that needs to prove absence must use a
content-verified evidence tier rather than promoting this fast path to
authority.

## 5. Query pipeline (`src/query/search.ts`)

Two phases:

1. **Prune** — from the query's word-terms, compute candidate files by walking the
   inverted index. No file I/O.
   - *word*: intersection of the exact term → files sets.
   - *substring*: for each token, union of every dictionary term that contains it,
     then intersect across tokens (still index-driven).
   - *regex*: no reliable prune → scan all indexed files (documented cost).
   - *omission fallback*: word/substring modes union every file marked with an
     overlong-term omission into the candidate set. This bounded direct scan is
     required because the omitted term edge cannot safely prove non-membership.
2. **Verify** — read only the candidate files and confirm real matches. Word and
   substring modes use the local precise matcher. Raw regex operations execute in
   a killable worker with a per-operation deadline, plus whole-search and input
   bounds; patterns over 10,000 UTF-16 code units are refused before parsing or
   compilation, and every reached bound is represented in `SearchResult`.

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
- matching uses a fixed operation budget; an overlong pattern or exhausted budget
  fails the walk with an explicit error rather than silently changing coverage

`.git` and `.myco` are always skipped. `.mycoignore` and (by default)
`.gitignore` files are read at every visited directory and their rules apply only
below that directory. This is not bug-for-bug gitignore compatibility, and that is
deliberate.

## 8. Safety posture

myco reads files and writes only `./.myco/`. Notable choices:

- **No absolute paths persisted.** The index stores paths relative to the root;
  the root is derived from where `.myco/` sits. The artifact is portable and
  never embeds a machine path.
- **The persisted graph is untrusted.** Loading requires an exact closed shape,
  bounded bytes/files/term edges, canonical non-empty POSIX-relative paths,
  positive counts and unique file/term identities. Windows/POSIX absolute,
  backslash, empty, dot and parent segments refuse the complete index.
- **The writer validates before writing.** A programmatic graph that violates
  the reader contract is refused before `.myco/index.json` is created or
  replaced; the cache cannot knowingly poison its next read.
- **Containment is re-derived.** A symlinked `.myco` directory whose real index
  resolves outside the search root refuses. `SearchGraph.setFile()` repeats the
  canonical-path invariant so a programmatic graph cannot bypass the loader.
- **Persistence order is canonical.** File records sort by path and term records
  sort by term. `createdAt` remains observational metadata and is not semantic
  graph identity.
- **Symlinks are not followed** during the walk — avoids cycles and escaping the
  root. The walk uses `lstat` for every file (a symlink swapped in between the
  directory read and the stat is refused, not followed) and every symlink or
  junction it meets is **listed** by `myco index` and in the coverage summary, so
  a link's target is never silently missing (MYCO-HARD-1).
- **Pinned-commit indexing (`myco index --at REV`, MYCO-HARD-1).** The index is
  built from one commit's tree in git objects: `rev-parse --verify --end-of-options
  REV^{commit}` must give a full SHA (empty, option-like, non-commit and unknown
  revisions fail closed, exit 2, before anything is written), `ls-tree -r -z --long
  --full-tree` lists the paths (NUL-separated, so odd names survive) and each file's
  bytes come from `cat-file blob`, never the working folder. Mode 120000 entries
  (symlinks) are listed and never followed; submodules (160000) and unknown modes
  are listed as not indexed. The root must be the repository top. Incremental
  reuse is off in this mode (there is no mtime to trust, and size alone cannot
  prove a blob unchanged). `.git`/`.myco` paths are skipped as in the walk, but
  `.gitignore`/`.mycoignore` rules are not applied: the commit IS the file list.
  `--at` is refused on search/compare and with `--worktree`, rather than ignored.
  Limitation: search still reads line text from the working folder, so a later
  `myco search --no-refresh` shows working-folder lines for a pinned term graph.
- **Secret guard (MYCO-HARD-1, on by default).** Before a term is stored, the
  tokenizer classifies it (`src/ingest/secret-guard.ts`): known credential
  shapes (GitHub, AWS key id, Stripe-style, Slack, Google API key, npm and
  similar prefixes) and long high-entropy terms (at least 32 chars, a letter and
  at least 4 digits, at least 4.0 bits/char after case folding) are **withheld**
  from `.myco`. Pure hex (SHAs, sha256) and snake_case names whose segments are
  letters, digits or at most 6 chars are kept. A withheld term is added to the
  file's omission count, so content search re-reads that file directly and still
  finds the value; `myco index` prints counts and paths, never the value.
  `--no-secret-guard` stores everything. Heuristic, not a scanner: about 3-4% of
  random 32-char lowercase tokens fall under the entropy floor, and the
  withheld-path list covers files read in this run (unchanged reused files stay
  visible through the omitted-term file list).
- **Terminal output treats source controls as data.** C0/C1 control characters in
  paths and matched lines are escaped before human-readable output. JSON preserves
  skipped and unreadable coverage explicitly; C1 controls are JSON-escaped so a
  terminal does not execute them and parsing retains the original text. Incomplete
  coverage exits with 2.
- **No code execution, no network.** Pure Node built-ins; nothing is `eval`'d.
- **Binary + size caps** bound memory and avoid junk terms — and the size cap is
  **visible, never silent**: over-size skips are counted in the index stats,
  named one-per-line by `myco index`, and flagged with a one-line note on the
  search path (stderr only, so piped/JSON stdout stays clean). A bounded
  coverage cap that hides what it dropped turns "no matches" into a lie.
- **Overlong terms are explicit, not truncated.** The persisted file marker
  carries a positive bounded omission count, `index` names affected relative
  paths, and `status` reports aggregate counts without term bodies. Content
  search directly verifies marked files, preserving completeness while keeping
  the term graph within its reader limit.
- Regex is user-supplied. Known catastrophic shapes are statically refused; all
  accepted JavaScript regex operations run in an isolated worker that is
  terminated on deadline. This contains a stalled engine call but does not make
  JavaScript regex linear-time.

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
  columnar/binary store and streaming. There is no fixed aggregate file, edge,
  or serialized-byte rejection threshold: indexing and loading remain bounded
  by available process, disk, and operating-system resources. A resource failure
  is not converted into a smaller or incomplete successful index.
- **Metadata freshness is not content proof.** Size+mtime preserves the repeat
  search advantage but cannot support an authority-sensitive absence claim.
  A future strict mode must hash source bytes and emit a replayable evidence
  receipt.
- **No positional index.** Verify re-reads candidate files to get line/col. A
  positional index would let common-term queries skip the re-read.
- **Regex = full scan** of the indexed set (no literal extraction to prune yet).
- **The current regex engine is still backtracking JavaScript.** Worker
  termination makes it pre-emptible, and every incomplete result is surfaced,
  but a compatible certified-linear TriRegex find-all backend is still pending.
- **Ignore is a subset**, not full gitignore (§7).
- ~~**Content-skipped files are name-invisible too.**~~ **Fixed in 0.2.2.** Binary
  and over-size files are now file nodes with an empty term set and a
  `contentSkip` tag (`binary` | `large`). `-f` finds them; content search
  (including regex full-scan) never opens them. Persisted as optional `k: "b"|"l"`
  on the file record; unknown keys still refuse.
- **Over-size files are INDEXED_UNKNOWN marker nodes.** Skipping the bytes is
  allowed; omitting the node is not. Each over-size file is a graph node with
  `unknown: { type: "UNKNOWN", state: "INDEXED_UNKNOWN", reason: "OVERSIZE",
  thresholdBytes, sha256? }`. Consumers MUST treat it as unknown content, never
  as "no content" or absence. Persisted as additive `u` on `k:"l"` (format stays
  1). Legacy `k:"l"` rows without `u` load as UNKNOWN with
  `thresholdBytes: "NOT_RECORDED"`. Search results carry `unknown[]` and
  `complete: false` whenever any such node is in scope. Optional
  `--hash-oversize` stream-hashes the bytes (never tokenized); a hash error
  leaves the marker without `sha256` and never drops the node.

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

## 13. Passive review (`myco check`, `myco run-all`)

Goal: let a person (or a scheduler) confirm, without reading every file, that an
index and its results tree are complete and well-formed. It is deliberately
**not** AI: every check is a pure function of files on disk plus `git ls-files` /
`ls-tree` / `rev-parse`, so the same state always gives the same verdict.

- **Coverage is persisted.** `myco index` writes `.myco/index-coverage.json`
  (options, counts, and sorted repo-relative path lists: over-size, unreadable,
  vendored dirs, symlinks, submodules, withheld-secret, tracked-ignored, overlong).
  No content and no secret values. An incremental index re-reads only changed files,
  so withheld-secret and overlong lists are carried forward for files whose mtime is
  older than the previous coverage file; pinned runs and a secret-guard option change
  do not carry anything.
- **Every gap must have a reason.** `index.vs-git` subtracts each explained
  category from tracked-minus-indexed; anything left is FAIL by default. This is the
  same principle as the rest of myco: a narrower answer must say it is narrower.
- **Baseline without timestamps.** `baseline.json` holds metrics, symlinks and
  per-check status only, so it changes only when the verdict changes. Growth and
  regression checks compare against it.
- **Rules are data and fail closed.** Unknown keys or wrong types in a rules file
  are errors rather than ignored, so a typo cannot disable a check.
- **run-all** spawns the same node binary and flags for `index`, keeps per-repo logs,
  writes a combined status and appends to `history.jsonl` (append-only).
- **Limitations.** Review is explicit (`check`) or scheduled (`run-all`); it does
  not run after every search. Results counts are checked against the files myco
  wrote, not re-searched. `index.age` uses the coverage file's time.
- **Tests.** `test/review.test.ts` (RV-01..RV-20) builds synthetic repos and results
  for every rule and exit code; `scripts/mutate-review.mjs` breaks 11 key rules and
  requires the suite to catch each one.

## Per-file manifest and citations (MYCO-HARD-1 items 3 + 4)

Every refresh that stores the graph (`myco index`, and the refresh inside
`myco search`) also writes `.myco/index-files.json` (`kind: "myco-file-manifest"`,
`version: 1`): one entry per indexed file with `path`, `bytes`, `mtimeMs` and
`sha256` (null above 256 MiB or if unreadable), plus `source: {repo, commit,
pinned}`. With `--at REV` the digests are of the pinned git blobs and `commit` is
the pinned SHA; otherwise `commit` is HEAD at index time. Unchanged files
(same bytes + mtime) reuse the previous digest, so a refresh stays cheap.

The stored index is **UNUSABLE** when the manifest and the graph disagree (file
count drift, missing/extra/duplicate paths) or the manifest is malformed:
`myco search --no-refresh` keeps its matches as evidence but reports
`complete: false`, prints `myco: index UNUSABLE - <reason>` on stderr and exits 2;
`myco check` FAILs `index.file-manifest`. `myco check` also runs a probe search
(`index.probe`) for a term the index says the first content file holds; a miss
is UNUSABLE (FAIL), a cap/budget hit is WARN. A missing manifest (an index built
before this existed) is never UNUSABLE; `check` reports it at the
`missingCoverageFile` level.

Search JSON gains additive fields only: `matches[].citation`
(`repo@<12-hex commit>:path:line`, or `repo@WORKTREE:...` outside git),
top-level `source` and `indexManifest {state, reasons}`. Text output, exit codes
for healthy indexes, `--max-size` and `--limit` are unchanged.