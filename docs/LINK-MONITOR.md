# Foreground local-link monitor

Launch explicitly after building Myco:

```text
node dist/cli.js links watch <root> --snapshot <outside-root-directory>/links.json
node dist/cli.js links --help
```

The snapshot parent must already exist. The snapshot must be outside the monitored
root. Ctrl+C/SIGTERM closes directory watchers, waits for the active reconciliation,
publishes `INCOMPLETE` with `STOPPED` and `running: false`, and removes its writer
lock. No service, login startup or scheduled task is installed. The CLI exits 2
on a publication failure. A forced kill cannot publish STOPPED; readers must enforce
freshness. A crash can leave `<snapshot>.lock`: check the recorded PID before
manually removing that file. Concurrent writers to the same snapshot are refused.

Myco alone scans source and publishes findings. This state is independent of the
search index. Hypha consumes the snapshot as advisory evidence; it does not scan
the source or insert link findings into its capability database.

## Scope and interpretation

This release reads all `.md`, `.markdown`, and `.txt` files under the selected root,
including untracked/ignored documents. It excludes directory/file entries named
`.git`, `node_modules`, `.myco`, `dist`, or `build`. These exclusions and extensions
are stamped in every snapshot. No Git command, hook or CI runs.

Supported syntax (`local-paths-v1`): Markdown inline/image destinations, including
balanced parentheses, angle-delimited paths with spaces and optional quoted titles;
single-line reference definitions; full/collapsed reference uses (undefined IDs are
unparseable); and Windows drive-absolute/file-URL paths in prose or quoted with a
backtick, double quote or angle brackets. Quote plain paths containing spaces.
All reference definitions are checked, including unused definitions. Paths in code
examples are checked too: this tool detects lexical dependencies, not author intent.

This is not a complete Markdown parser. Shortcut references, HTML attributes,
multiline destinations, Markdown escapes beyond parentheses/spaces, arbitrary plain
relative/POSIX paths, heading existence, and code-language imports are outside its
grammar. Anchor/query suffixes on relative Markdown links are ignored for file
existence. HTTP(S), mail and data URLs are outside local-path coverage. It does not
make network requests. UNC paths and unsupported URI schemes are EXCLUDED. A Windows
drive path on another host is UNAVAILABLE, never confirmed missing. Symlink sources
are not traversed and make coverage incomplete. Targets use filesystem existence;
this is not a sandbox against adversarial directory replacement.

Findings preserve source-relative file, one-based line, target, kind and a `temp`
flag. The snapshot contains local absolute provenance/targets and should remain
local; it is not suitable for automatic public upload.

| Kind | Meaning |
| --- | --- |
| BROKEN | Native filesystem reports ENOENT or ENOTDIR for a supported target. |
| TEMP_REFERENCE | Target exists but includes a Temp/tmp segment; fragile dependency. |
| UNAVAILABLE | Target cannot be checked on this host or an I/O error prevents checking. |
| EXCLUDED | Target is outside supported check coverage. |
| UNPARSEABLE | Malformed/unsupported supported-link expression, encoding or target. |

`CLEAN` means a completed bounded scan found no findings within the declared scope.
`FINDINGS` means confirmed missing targets or existing Temp dependencies were found.
`INCOMPLETE` overrides both when coverage or observation is uncertain, while retaining
any known findings. Source decoding/read errors, scan limits, invalid parser input,
watch failures, observed changes during a scan, and event overflow prevent CLEAN.
Overflow remains INCOMPLETE for its reconciliation; a subsequent complete cycle can
recover. This is a time-stamped observation, not an atomic filesystem transaction.

## Events, missed events and limits

Per-directory filesystem notifications accelerate full reconciliation. A coalescing
set holds at most `maxQueue` unique paths; overflow discards event detail, marks the
cycle incomplete and still performs the full scan. No file content is cached on
mtime/size. Independent periodic scans re-read all supported documents and targets,
so missed notifications, external target changes and newly created directories are
eventually detected. Only one scan and one publication run at a time.

Signals arriving during an active reconciliation are tracked by generation even
if their debounce already fired and joined the active promise. After a successful
cycle settles, a changed generation schedules exactly one coalesced follow-up on
the next event-loop turn. Further signals during that follow-up can require another
cycle. Shutdown cancels this work; a failed publication does not start a retry loop.

**Targets outside the root are periodically checked, not event-watched.** A link
such as `../external.bin` is statted during every full scan, but its parent directory
is not added to the watcher set. Deleting it can leave the previous CLEAN snapshot
unchanged until the next periodic scan (default 60 seconds, plus scan/publication
time). That snapshot is historical evidence, not a continuous existence guarantee.
This also applies to targets reached through filesystem indirection whose changes
produce no source-root event. Hypha's snapshot age does not imply external parents
were watched. Use a shorter `--interval-ms` or an encompassing root when this delay
is unacceptable. This release deliberately does not expand watches beyond the
selected source root; network/unavailable target handling remains fail-closed.

Default limits (CLI kebab-case spellings, also shown by `links --help`):

| Setting | Default |
| --- | ---: |
| interval-ms | 60000 |
| debounce-ms | 200 |
| max-queue | 256 |
| max-dirs (also bounds directory watchers) | 2048 |
| max-entries | 100000 |
| max-files | 10000 |
| max-file-bytes | 1048576 |
| max-total-bytes | 67108864 |
| max-references | 100000 |
| max-findings | 5000 |
| scan-budget-ms | 30000 |

Limits must be positive integers, at most ten times their defaults. Lines are bounded
at 16,384 characters, targets at 4,096 and issue messages at 100 per scan. Reaching
a scan cap is reported; CLEAN cannot result from partial coverage. Directory entries
are streamed. Each source read allocates the minimum of its pre-read stat size,
`max-file-bytes`, and remaining `max-total-bytes`, plus one growth-probe byte.
A three-byte document therefore needs a four-byte read buffer. Growth/shrinkage,
short reads, and size/identity/mtime differences across the read make coverage
incomplete; bytes beyond either cap refuse the scan. This bounds actual reads and
allocations without treating an old stat size as proof that the source stayed still.
If serialized findings exceed 16 MiB, the writer publishes INCOMPLETE with
`SNAPSHOT_SIZE_LIMIT` and an empty findings array; that empty array is not absence
evidence. Narrow the monitored root or reduce the findings limit to investigate.

Timing is best effort: normally debounce plus scan time, or the next periodic scan
for missed events. No OS event-delivery guarantee is claimed. Persistent mutations
in the controlled integration fixtures must be observed within 5 seconds (using
short test intervals). These tests do not prove production-wide 5-second latency.
Scan deadlines are checked between I/O operations; blocked filesystem calls can
exceed them. Snapshot age must therefore be checked independently by consumers.

## Serialization contract: myco.links.v1

Atomic UTF-8 JSON replacement at the explicitly chosen snapshot path. A same-directory
temporary file is written then renamed, with bounded Windows sharing-error retries.
There are at most 50 rename attempts, 40 ms apart (up to 1.96 seconds of waits).
The previous file is never unlinked to force replacement. The writer uses an exclusive
`.lock` file; the snapshot itself is advisory and unsigned.

Required fields:

- `schema: "myco.links.v1"`, `producer: "myco"`, `session` (UUID), `sequence`
  (positive integer increasing within a session), `root` (absolute selected root).
- `startedAt`, `completedAt`, `publishedAt`: ISO dates for this scan/publication;
  `running`: boolean; `status`: CLEAN/FINDINGS/INCOMPLETE.
- `issues`: string array; `findings`: array of `{source, line, target, kind, temp}`;
  `files`, `references`: nonnegative integer observed counters (not total estate size).
- `limits`: the eleven camelCase keys in DEFAULT_LIMITS; `scope` has exact arrays
  `extensions: [".md", ".markdown", ".txt"]`,
  `excludedDirectories: [".git", "node_modules", ".myco", "dist", "build"]`,
  and `grammar: "local-paths-v1"`.

Consumers must validate this version, required fields, selected root, chronology,
scope, status consistency and freshness from **startedAt**, not merely publication
time. Any uncertainty must yield UNKNOWN/INCOMPLETE. Publication identity is not
authenticated proof. Evolving this grammar/scope requires updating both tools'
contract and tests; incompatible changes need a new schema version.

## Direct proof and challenge vectors

`node --experimental-strip-types --test test/links.test.ts` starts the actual monitor
and exercises add/repair/delete/rename/new directory, missed events with notifications
disabled, injected queue overflow, restart, unavailable root, parser failure, size
limits, invalid UTF-8, Windows Temp paths and stop/lock cleanup. Parser tests alone
are not the watcher proof. Hypha's `npm run test:links`, after this repository's
`npm run build`, additionally launches both real command lines with synthetic
documents and checks the consumed publication. No real documents/secrets are used.

## Local verification record (2026-10-09)

Native Windows, Node v24.18.0. Base commits remain Myco
`a60d876f66553a7baa02f48f6d0afd88d64e120b` and Hypha
`9a15296b2589794cb92fed423953a711db7b36c7`; changes are uncommitted.

- Myco `npm run build`: passed.
- Myco `node --experimental-strip-types --test test/links.test.ts`: 7/7 passed
  after the final queue-coalescing and end-of-scan budget corrections.
- Myco `npm test`: initial parallel run 106/107; the existing regex-content
  6000 ms budget test failed its truncation assertion while its worker took
  about 282 ms. No search code or existing test expectations were changed.
- Myco `node --experimental-strip-types --test test/search-budget.test.ts`:
  9/9 passed in isolation.
- Full serial Myco suite: 107/107 passed. Exact PowerShell invocation:
  `$linkTaskTests = (Get-ChildItem -LiteralPath test -Filter '*.test.ts').FullName; node --experimental-strip-types --test --test-concurrency=1 $linkTaskTests`.
  The final two bounded-monitor corrections above were then covered by the focused
  7/7 run and a fresh build. The earlier serial attempt exposed Windows sharing
  failures during snapshot rename; bounded retries were extended to 50 attempts
  before the successful full run. Persistent publication failure still stops the
  monitor and remains an error, never a successful clean result.
- Hypha `npm test`: existing local self-checks passed and all 3 link tests passed.
  Optional external-Galerina integration was explicitly not run (root unset).
- Hypha `npm run test:links`: 3/3 passed, including real Myco/Hypha command-line
  publication and consumption. This is direct combined evidence, not a capability
  map proxy.
- Both repositories `git diff --check`: passed (configured LF/CRLF warnings only).

Existing full-suite fixtures were directed into repository-local test directories
through process-local TEMP/TMP values. The execution policy rejected a requested
cleanup of the leftover synthetic fixture directories; they remain local and must
not be staged. No service was installed, no production root was monitored, no other
repository was edited, and no commit, push or CI command was run.

Outstanding limits: the initial parallel search-test timing failure is not fixed
by this feature; latency beyond controlled fixtures is unmeasured; the grammar is
bounded as documented; Windows 24.18.0 is the runtime tested here (other supported
Node/OS combinations are not established by this run).

### Independent-review corrections (2026-10-09)

The in-flight/debounce race was reproduced against the previous implementation:
the deterministic blocked-stat test timed out after two seconds with the snapshot
still INCOMPLETE/EVENTS_DURING_SCAN, despite a ten-minute periodic interval. After
the fix, a 20-signal burst causes exactly two target checks (the stale cycle and
one follow-up), reaches fresh FINDINGS and CLEAN within two seconds, and does not
restart after stop. The test waits for the debounce callback to actually execute
before releasing the I/O barrier; it does not assume a slow machine will expose
the race by chance.

Allocation tests inspect the real read buffer and mutate real fixture files before
and after the read, with observed mtimes pinned to prove size-change detection.
They cover empty/small/exact-cap files, growth, shrinkage, remaining aggregate
budget and rejecting an oversized file before buffer allocation.

The external-target test proves both limitations and recovery: with source watches
enabled and the periodic interval at ten minutes, deleting a sibling target does
not change the snapshot sequence; with a 200 ms periodic interval, deletion and
repair produce FINDINGS and CLEAN within two seconds. No external watch coverage
is claimed.

`node --experimental-strip-types --test test/links.test.ts`: 10/10 passed.
`npm run build`: passed after these corrections.
