# myco

**grep, but it grows a graph.** A search tool that indexes a directory into a
graph of files and terms, so a search is a fast, precise *traversal* — smart-case
by default, whole-word precise, filenames and contents in one query, and instant
on repeat searches.

```
myco "handleRequest"          # search file contents
myco -f auth                  # search file names / paths
myco -f .fungi                # leading-dot = extension match (path endsWith)
myco index                    # (re)build the graph index for the current tree
```

## Why not just grep?

grep re-reads every byte of every file on every query and matches blindly. myco
builds a graph once, then only ever reads the handful of files an edge points at
— and it matches **whole words by default**, which is the big precision win:

```
$ myco graph              # whole-word: 66 hits
$ myco -s graph           # substring:  92 hits   (the 26 extras are inside words
                          #                         like "SearchGraph", "digraph")
```

Searching `cat` will **not** drag in `concatenate`, `category`, or `location` —
unless you ask for a substring (`-s`) or a regex (`-e`). That is the difference
between "find the word I meant" and "find my letters anywhere".

### Word boundaries are applied per edge

A word-boundary test is applied **only at an edge whose own character is a word
character**. That makes call-site search work the way you expect:

```
$ myco "handleRequest("      # finds handleRequest(req), handleRequest(), handleRequest("x")
                             # does NOT match inside reHandleRequest(
```

The leading `h` is a word character, so the left edge is still protected. The
trailing `(` is not, so myco does not demand a non-word character *after* the
paren — which would reject every call site that passes a variable. (This differs
from `grep -w`, which applies both edges unconditionally; grep's default is not
`-w`, while myco's *is*, so the same rule would be a trap here.)

### A narrow result always says it is narrow

If whole-word matching throws away files that do contain your pattern, myco tells
you, and names the flag that gets them back:

```
$ myco "handleRequest(r"
0 hits · 0 files · (44 searched) · 4 files contain the pattern but were
excluded by whole-word matching — try -s
```

Zero hits there is *correct* — a whole-word pattern has to end at a boundary — but
you should never have to guess whether zero means "absent" or "filtered". Same
rule as the over-size skip note: **a coverage cap is never a silent one.**

## Features

- **Graph index** — files and terms are nodes; `file --contains--> term` are
  edges. A query looks up the term node and walks to its files. No full scan.
- **Whole-word by default** — token-aware matching. `-s` for substring, `-e` for
  regex when you need them.
- **Smart-case** — lower-case query ⇒ case-insensitive; add a capital ⇒
  case-sensitive. (This is the "ignore capitals" you actually want.)
- **Unicode-correct** — `café` matches `CAFÉ`; accents are preserved (they change
  the word), only case is folded.
- **Filenames *and* contents** — `-f` searches paths through the same graph.
- **Metadata-refreshed, still fast** — every search does a cheap incremental
  refresh first (changed files are re-read, unchanged files are only
  `stat`'d). This is an interactive freshness heuristic, not cryptographic
  content identity: preserved size+mtime can evade it. `--no-refresh` searches
  only a previously admitted bounded index; a future content-verified mode is
  required for security-sensitive absence claims.
- **Ranked output** — the file with the most hits comes first, not filesystem
  order.
- **Respects `.gitignore`** (and `.mycoignore`), skips binaries, caps huge files
  — **and says so**: over-size skips are counted, listed by `myco index`, and
  noted on the search path. A coverage cap is never a silent one.
- **Zero runtime dependencies.** Pure Node built-ins.
- **Pre-emptible regex execution** — known exponential shapes are refused before
  compilation, and every remaining JavaScript regex operation runs in a worker
  with a hard deadline. If it stalls, the worker is terminated and the result is
  explicitly marked incomplete. Over-size line prefixes and search/result limits
  are also reported; a narrowed regex result never presents itself as absence.
  TriRegex remains the proposed non-backtracking backend once its find-all and
  Myco-compatibility contract is complete.

## Install

Requires Node.js 18+ (Node 22.6+ to run from source without building).

```
git clone https://github.com/TritHypha/myco.git && cd myco
npm install
npm run build
npm link          # puts `myco` on your PATH
```

Or run straight from source without a build step (Node 22.6+):

```
node --experimental-strip-types src/cli.ts "pattern"
```

## Usage

```
myco <pattern> [path]        search file contents (default)
myco search <pattern> [path] explicit form (when the pattern is a command name)
myco index [path]            build / refresh the graph index
myco status [path]           show index statistics
```

| Flag | Meaning |
|---|---|
| `-s, --substring` | match anywhere in a word (grep-like) |
| `-e, --regex` | regular expression |
| `-f, --files` | search file names / paths instead of contents |
| `-i, --ignore-case` | force case-insensitive |
| `-S, --case-sensitive` | force case-sensitive |
| `-C, --context N` | show N lines of context |
| `-n, --limit N` | max results (default 200) |
| `--in <glob>` | search only under this path; repeatable. A plain path means "and everything under it" (`--in src` never matches `srcfoo/`); `*` within a segment, `**` across, `?` one char. Excluded candidates are counted in the summary, and a glob matching nothing is called out — a scoped zero must never read as a tree-wide absence. |
| `--json` | machine-readable output |
| `--no-color` | disable ANSI colour |
| `--no-refresh` | search the existing index without refreshing |
| `--no-gitignore` | do not honour `.gitignore` |
| `--max-size N` | skip files larger than N MB (default 5) |

Exit codes: `0` matches found · `1` no matches · `2` error or incomplete
coverage. Regex timeout, whole-search timeout, and regex line-cap truncation
are incomplete and therefore fail closed with `2`; JSON still carries the
partial evidence and exact reason.

## How it works

Two phases, and that is the whole performance story:

1. **Prune** — use the inverted index (the graph's edges) to find the small set
   of files that *could* match. No file I/O.
2. **Verify** — read only those candidate files and confirm real matches with a
   precise matcher (word boundary / substring / regex).

The index lives in `.myco/index.json` at the root you search. Only the *forward*
index (each file → its term counts) is written; the inverted and filename
indexes are rebuilt in memory on load, which is what makes incremental
re-indexing cheap. The file is untrusted input: Myco bounds its bytes and
collections, requires a closed record shape and canonical root-relative paths,
rejects duplicate identities, and refuses a symlinked index that resolves
outside the root. See [DESIGN.md](DESIGN.md) for the full model.

## Honest performance notes

myco is **not** trying to beat [ripgrep](https://github.com/BurntSushi/ripgrep)
on a cold scan — ripgrep is superb, and for one-off scans of an unindexed tree it
will usually win. myco's niche is different: a **persistent graph** that makes
*repeat* searches over the same tree cheap, makes whole-word precision the
default, unifies filename and content search, and is built to grow a
code-structure layer (see the roadmap). First index of a tree is O(bytes), like
grep; every search after that reads the index plus only the candidate files.

## Roadmap

- **Code-structure layer** — parse source into symbol nodes (`defines`,
  `references`, `calls`) so you can ask "where is `X` defined / who calls it".
  The graph model is already shaped for this.
- **Name-index content-skipped files** — a binary or over-size file should still
  be findable by `-f` filename search even though its contents are not indexed
  (today it is absent from the name index too; see DESIGN §10).
- Positional index (store line offsets) to skip re-reading candidates.
- Worker-thread parallel indexing for large trees.
- A compact binary index format.
- **TriRegex backend** after certified find-all, smart-case, span-unit and
  supported-subset compatibility gates pass; see
  [TRIREGEX-INTEGRATION.md](TRIREGEX-INTEGRATION.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the
design constraints (zero runtime dependencies, erasable-syntax TypeScript), and
what a good test looks like here.

There is one rule worth repeating outside that file: **a search result that is
narrower than the truth must say so.** myco's whole value is that you can trust a
miss, and every release so far has fixed a case where something was quietly
dropped. If your change can narrow a result, make the narrowing visible.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? **Please do not open a public issue** — use a
[GitHub private security advisory](https://github.com/TritHypha/myco/security/advisories/new)
or email `hello@trithypha.dev`. Full policy, threat model and scope:
[SECURITY.md](SECURITY.md).

## Sponsorship

myco is free, Apache-2.0, and has no runtime dependencies — and it is maintained
in the open by a small team. If it saves you time, you can
[sponsor the work on GitHub](https://github.com/sponsors/TritHypha). Sponsorship
supports maintenance of myco and the wider TritHypha open-source effort. Nothing
in the tool is gated behind it, and nothing ever will be.

For commercial support or sponsorship enquiries: `hello@trithypha.dev`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

**Apache License 2.0** — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Contributions are accepted under the same licence (Apache-2.0 §5): you keep your
copyright, and you grant the project the licence in the file. There is no CLA.

Copyright 2026 Phillip Booth.
