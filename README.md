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

## Search time budget

The search verification phase has a **120-second** wall-clock budget (previously
five seconds), allowing broader documentation-corpus searches to finish.
This is not an overall CLI deadline: index loading, rebuilding and refresh are
separate. A single isolated regex operation still has a **250 ms** deadline;
pattern refusal, line/file-size limits and result caps are unchanged.
Reaching a limit still reports incomplete coverage, never a verified absence.

## Features

- **Graph index** — files and terms are nodes; `file --contains--> term` are
  edges. A query looks up the term node and walks to its files. Files carrying
  an explicitly recorded overlong-term omission are also directly verified, so
  the bounded graph cannot turn an omitted edge into a false absence.
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
  compilation, patterns over 10,000 UTF-16 code units are refused, and every
  remaining JavaScript regex operation runs in a worker
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

`myco status` reports **unique content terms** (case-folded vocabulary entries,
not token occurrences) separately from **file-term links** (distinct file/term
pairs; repeated appearances in one file count once). Filename/path tokens use a
separate name index and are not included in the content-term total. Overlong
content terms omitted from the graph are reported separately. These are index
statistics, not document counts, verified facts, or a measure of corpus coverage.

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
| `--max-size N` | skip files larger than N MB (default: no size cap) |

Exit codes: `0` matches found · `1` no matches · `2` error or incomplete
coverage. Regex timeout, whole-search timeout, and regex line-cap truncation
are incomplete and therefore fail closed with `2`; JSON carries partial results,
skipped paths, unreadable paths, and the completeness state. Human-readable output
escapes terminal control characters found in source paths and lines. JSON also
escapes C1 terminal controls as Unicode escapes, which parse back to the original
characters without issuing terminal commands.

## Git worktree-aware search

For a Git repository with linked worktrees, use the shared AGENTS coordinator rather
than reusing one Myco index across different checkouts. From the AGENTS checkout:

```bash
node tools/myco-hypha-worktree-scan.mjs myco <repository> --query <literal> --current-worktree-only --format text
node tools/myco-hypha-worktree-scan.mjs myco <repository> --query <literal> --include-worktrees --format json
```

The coordinator records each registered worktree's branch or detached state, HEAD,
lock and dirty-state identity alongside bounded Myco findings. It invokes Myco with
`--no-refresh`: results do not refresh or mix indexes, and a zero-result query is
`UNKNOWN`, not proof that a term is absent. It never checks out branches or changes
Git state. The tool and its limits are maintained in the sibling AGENTS repository
at `tools/myco-hypha-worktree-scan.mjs`; see that tool's README entry for the full
report contract. This integration is an operator workflow, not part of the published
Myco package or a guarantee that every worktree has a fresh index.

## How it works

Two phases, and that is the whole performance story:

1. **Prune** — use the inverted index (the graph's edges) to find the small set
   of files that *could* match. No file I/O.
2. **Verify** — read only those candidate files and confirm real matches with a
   precise matcher (word boundary / substring / regex).

Terms up to and including 4,096 UTF-16 code units are admitted to the graph.
Longer terms are omitted rather than truncated. The index records the omission
count on the affected file, and word/substring searches add every such file to
the direct-verification set. `myco index` names the affected root-relative paths;
`myco status` reports aggregate counts. Neither command prints omitted term
bodies.

The index lives in `.myco/index.json` at the root you search. Only the *forward*
index (each file → its term counts) is written; the inverted and filename
indexes are rebuilt in memory on load, which is what makes incremental
re-indexing cheap. There is no fixed whole-root file-count, term-edge, or index
byte ceiling. The closed record contract still bounds each path, each term, and
the number of terms stored for one file; the OS can still fail a read, write,
or allocation when resources are exhausted. The file is untrusted input:
Myco requires canonical root-relative paths, rejects duplicate identities, and
refuses a symlinked index that resolves outside the root. See
[DESIGN.md](DESIGN.md) for the full model.

The writer validates the complete payload against the same structural contract
as the reader before writing. `myco status` distinguishes “no index exists”
from “an index exists but was refused”; only an `ENOENT` filesystem result
means absent. Permission, invalid-path, malformed-data and other I/O failures
are refused rather than treated as a first run.

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
- ~~**Name-index content-skipped files**~~ — done in 0.2.2 (`-f` finds binaries /
  over-size paths; content search never opens them).
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
## Opt-in local-link monitoring

Run `myco links watch <root> --snapshot <outside-root-directory>/links.json`
to monitor supported Markdown/text paths, including fragile Temp references.
It runs in the foreground until Ctrl+C; no startup installation occurs.
See [the scope, limits and snapshot contract](docs/LINK-MONITOR.md).

## Full index, results tree and compare

- `myco index` indexes everything: no size cap unless you pass `--max-size N`,
  git-tracked files even when `.gitignore` matches them (`--no-tracked-ignored` to
  opt out), sharded store that fails closed on tampering.
- In a git app, `myco <pattern>` also searches every branch (from git objects) and
  every worktree into `.myco/results/<query-token>/` with a `summary.md`.
- `myco compare <path>` gives git unified diffs vs main HEAD plus a `thread.md`
  history across branches.
- `--branch NAME` / `--worktree PATH` (repeatable) limit a run; the coverage
  summary printed by every run states when it was limited.
- Very long lines are searched in full with the vendored TriRegex engine; a refusal is
  reported, never treated as no-hit.

## Passive review: `myco check` and `myco run-all` (no AI)

After an index or a search, `myco check` reviews what is on disk with fixed,
deterministic rules: no AI, no network, the same input always gives the same verdict.

```
myco index .
myco check .            # alias: myco review .
myco check . --json     # machine-readable result on stdout
myco check . --deep     # also re-hash files whose size and mtime look unchanged
```

It reads `.myco/index-manifest.json` (or the legacy `index.json`), the coverage file
`.myco/index-coverage.json` that `myco index` now writes, and every folder under
`.myco/results/`. Each check is **PASS**, **WARN** or **FAIL** with a one-line reason
and, where useful, the paths involved. It writes `.myco/review/review.md`,
`review.json` and `baseline.json` (no timestamps, so it only changes when the
verdict does; the next run compares against it). Exit code: **0** all PASS,
**1** at least one WARN, **2** at least one FAIL.

| Check | Default |
|---|---|
| `index.present` – a loadable index exists | FAIL if absent or refused |
| `index.integrity` – every shard's sha256/bytes match the manifest; orphan shards | FAIL on mismatch/missing, WARN orphan |
| `index.coverage-file` – coverage file present and valid | WARN |
| `index.vs-git` – indexed files vs `git ls-files` (or `ls-tree` for `--at`); gaps explained by symlink, submodule, vendored, over-size, unreadable, deleted, tracked-ignored | FAIL if any gap is unexplained |
| `index.gap-growth` – gap grew since the last review | WARN |
| `index.unreadable` / `index.skipped` – unreadable and over-size files | WARN when > 0 |
| `index.secret-guard` – withheld-secret file count (never values); growth; guard OFF | WARN on growth or OFF |
| `index.symlinks` – new symlinks since the last review | WARN |
| `index.content-digest` – recorded per-file sha256 vs content now (quick: files whose size/mtime moved; `--deep`: every file, or the pinned commit's blobs) | WARN on edited/deleted files (`contentDrift`), FAIL on a digest change under unchanged size + mtime or a pinned digest that disagrees with its commit (`silentEdit`) |
| `index.stale` – index built at a different HEAD | WARN |
| `index.age` – index older than 24 h | WARN |
| `results.present` / `results.summaries` – every results folder has `summary.md` + `summary.json`; no orphan target folders | FAIL |
| `results.counts` – `hits.txt` / `hits.json` / summary counts agree | FAIL |
| `results.capped` – a target reached the result limit (1000) | WARN |
| `results.empty` – a search found nothing anywhere | WARN |
| `results.coverage` – branches/worktrees skipped or limited by a filter | WARN |
| `results.unreadable` – a target errored (`ERROR.txt`) | FAIL |
| `results.refused` – a target was refused (budget/policy) | WARN |
| `compare.wellformed` – compare rows, `result.txt`, `diff.patch` header + hunk, `thread.md`/`thread.json` | FAIL |
| `review.regression` – a check got worse than in `baseline.json` | WARN |

### Rules

Thresholds use `{"warnAbove": n, "failAbove": n}` (strictly greater than; `null` =
never); level rules take `"PASS" | "WARN" | "FAIL"`. Sources, first match wins:
`--rules FILE`, `.myco/review-rules.json`, the `"review"` key of `myco.config.json`,
built-in defaults. Unknown keys and wrong types are errors, so a typo cannot silently
switch a rule off.

```json
{ "unexplainedMissing": { "warnAbove": null, "failAbove": 0 },
  "gapGrowth": { "warnAbove": 0, "failAbove": 10 },
  "indexAgeHours": { "warnAbove": 6, "failAbove": null },
  "staleHead": "FAIL", "emptyResults": "PASS", "resultLimit": 1000, "maxDetails": 20 }
```

### Many repos: `myco run-all`

```
myco run-all --config myco-repos.json [--out DIR] [--no-index]
```

The config lists repos (`path`, optional `name`, `index: false`, `indexArgs`,
`rules`) and an `out` folder; see `scripts/scheduled-review/myco-repos.example.json`.
For each repo it runs `myco index` (log in `out/logs/<name>.index.log`) and then the
review; a missing repo or a failed index is a FAIL. It writes `out/status.json`,
`out/status.md` and appends one line per run to `out/history.jsonl` (never rewritten).
Exit code is the worst repo's.

### Scheduling it

Windows (Task Scheduler, through WSL node). The task runs as you with an
interactive logon, so its PowerShell window is **visible** and stays open with the
result; nothing runs hidden. `-Toast` pops a notification when the run FAILs
(BurntToast if installed, otherwise the built-in WinRT toast).

```powershell
.\scripts\scheduled-review\register-task.ps1 -RepoWsl /mnt/c/path/to/myco -ConfigWsl /mnt/c/path/to/myco-repos.json -Toast
# remove:  Unregister-ScheduledTask -TaskName 'myco review' -Confirm:$false
```

If script execution is restricted, run it with
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\scheduled-review\register-task.ps1 ...`.
Default node is `~/.nvm/versions/node/v24.18.0/bin/node` (change with `-NodeWsl`).

Linux / macOS / WSL cron: see `scripts/scheduled-review/crontab.example`:

```
0 */3 * * *  cd $HOME/src/myco && node --experimental-strip-types --no-warnings src/cli.ts run-all --config $HOME/myco-repos.json >> $HOME/myco-review/cron.log 2>&1
```

Review runs when you call `check`, or on the schedule. It is **not** triggered
automatically after every search.
