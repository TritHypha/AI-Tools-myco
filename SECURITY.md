# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately, either way:

1. **GitHub private security advisory** — preferred. Go to the repository's
   **Security → Advisories → Report a vulnerability**. This keeps the report,
   the discussion and the fix private until a release is ready, and gives us a
   path to a CVE if one is warranted.
2. **Email** — `hello@trithypha.dev`, if you would rather not use GitHub or the
   advisory form is unavailable.

Please include: what you found, how to reproduce it, the myco version
(`myco --version`) and Node version, and what you think the impact is. A minimal
reproducing pattern or file tree is worth more than a long description.

**What to expect:** an acknowledgement within a few days, an assessment of
severity and scope, and a fix or an explicit "won't fix, and here is why". If we
disagree that something is a vulnerability we will say so plainly rather than let
the report go quiet. Credit in the changelog and the advisory unless you prefer
otherwise.

myco is maintained by a small team, so please allow reasonable time before public
disclosure. We would rather coordinate than race.

## Supported versions

myco is pre-1.0. Only the latest released version receives security fixes.

| Version | Supported |
|---|---|
| 0.1.x (latest) | ✅ |
| older 0.1.x | ❌ — upgrade |

## Threat model — what myco actually does

Being clear about the shape of the tool makes reports easier to judge:

- myco **reads** files and **writes one index** (`.myco/index.json`) under the
  directory you point it at. It does not execute anything it finds.
- It makes **no network requests**, has **zero runtime dependencies**, and does
  not read credentials or environment secrets.
- Its inputs are: your search pattern, the CLI flags, and the contents and paths
  of the tree you search. **A hostile *tree* is a real input** — myco may be run
  over a repository someone else wrote.

### In scope

- **ReDoS / catastrophic backtracking** via `-e` user regexes. There is an
  existing static guard (`src/query/regex-guard.ts`), but it is not treated as a
  proof. Every accepted JavaScript regex operation runs in a worker; exceeding
  the deadline terminates that worker and produces an explicitly incomplete
  result. A pattern that blocks the main process, escapes the deadline, or returns
  an unlabelled partial result is a valid report. A certified-linear TriRegex
  find-all backend remains the preferred long-term replacement.
- **Path traversal / writing outside the search root** — the indexer walks a tree
  and must not follow symlinks out of it or write anywhere but `.myco/`.
- **Crashes or unbounded memory** on hostile input: adversarial filenames,
  enormous or malformed files, deeply nested directories, encoding edge cases.
- **Index poisoning** — a crafted tree or a tampered `.myco/index.json` causing
  myco to report matches that do not exist, or to hide matches that do.
- **Silent under-reporting.** myco's contract is that a coverage cap is never a
  silent one: over-size skips, time-budget truncation and whole-word exclusions
  are all reported. **A result that is narrower than the truth without saying so
  is treated as a security-relevant defect**, not a cosmetic one — a miss reads
  as absence, and people make decisions on absence.

### Out of scope

- Anything requiring an attacker to already have code execution or write access
  to your machine.
- Resource use proportionate to the tree you asked myco to index.
- Vulnerabilities in Node.js itself, or in development-time dependencies
  (TypeScript, `@types/node`) that are never shipped in the published package.
- The absence of sandboxing: myco is a local CLI run with your privileges by
  design, not a privilege boundary.

## Cryptography

myco performs no cryptographic operations and stores no secrets. Its index
contains file paths and folded word terms drawn from the tree you index — so
treat `.myco/index.json` with the same care as the tree itself. It is gitignored
by default; do not commit one.
