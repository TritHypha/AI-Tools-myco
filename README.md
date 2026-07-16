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
- **Always fresh, still fast** — every search does a cheap incremental refresh
  first (changed files are re-read, unchanged files are only `stat`'d), so you
  never get stale results. `--no-refresh` skips it for maximum speed.
- **Ranked output** — the file with the most hits comes first, not filesystem
  order.
- **Respects `.gitignore`** (and `.mycoignore`), skips binaries, caps huge files
  — **and says so**: over-size skips are counted, listed by `myco index`, and
  noted on the search path. A coverage cap is never a silent one.
- **Zero runtime dependencies.** Pure Node built-ins.

## Install

Requires Node.js 18+ (Node 22.6+ to run from source without building).

```
git clone <repo> && cd myco
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
| `--json` | machine-readable output |
| `--no-color` | disable ANSI colour |
| `--no-refresh` | search the existing index without refreshing |
| `--no-gitignore` | do not honour `.gitignore` |
| `--max-size N` | skip files larger than N MB (default 5) |

Exit codes: `0` matches found · `1` no matches · `2` error (grep-compatible).

## How it works

Two phases, and that is the whole performance story:

1. **Prune** — use the inverted index (the graph's edges) to find the small set
   of files that *could* match. No file I/O.
2. **Verify** — read only those candidate files and confirm real matches with a
   precise matcher (word boundary / substring / regex).

The index lives in `.myco/index.json` at the root you search. Only the *forward*
index (each file → its term counts) is written; the inverted and filename
indexes are rebuilt in memory on load, which is what makes incremental
re-indexing cheap. See [DESIGN.md](DESIGN.md) for the full model.

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

## License

MIT — see [LICENSE](LICENSE). Contributions welcome.
