// walk-completeness.test.ts — the anti-"(1 searched)" invariant, at the walker level.
//
// Field context (2026-07-25): the owned downstream mirror of this tree silently visited 1 file
// of a 470-file tree — its walk.ts had diverged 43 lines short. The class is SILENT NARROWING:
// the walker visits fewer files than the truth and nothing says so. This test pins the invariant
// that makes that class impossible here:
//
//   every git-TRACKED file that exists on disk is either VISITED by walk()
//   or present in a REPORTED skip list (vendored dirs / over-size paths).
//
// A skip is fine — a silent skip is the defect. The invariant passes exactly because this tree's
// skips are loud; a mirror with silent narrowing fails it immediately. Reconciling downstreams
// should carry this test with them (bridge 0359/0362).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { walk } from "../src/ingest/walk.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Infrastructure dirs are the DELIBERATE silent set (walk.ts ALWAYS_SKIP) — excluded from the
// tracked side too, so the invariant only ever binds the loud-skip contract.
const INFRA = [".git/", ".myco/"];

/** The invariant as a pure, unit-testable function: tracked files not visited and not covered by
 *  a reported skip. Empty result = complete; anything returned = a SILENT narrowing. */
function completenessViolations(
  tracked: string[],
  visited: Set<string>,
  vendoredDirs: string[],
  largePaths: string[],
): string[] {
  const large = new Set(largePaths);
  return tracked.filter((rel) => {
    if (INFRA.some((p) => rel.startsWith(p) || rel.includes("/" + p))) return false;
    if (visited.has(rel)) return false;
    if (large.has(rel)) return false; // skipped, but REPORTED — the contract holds
    if (vendoredDirs.some((d) => rel === d || rel.startsWith(d + "/"))) return false; // ditto
    return true; // tracked, on nobody's list — the silent-narrowing defect
  });
}

test("detector self-test: a file on nobody's list IS flagged (non-vacuous by construction)", () => {
  const violations = completenessViolations(
    ["a.ts", "sub/gone.ts", "node_modules/x.js", "big.bin"],
    new Set(["a.ts"]),
    ["node_modules"],
    ["big.bin"],
  );
  // a.ts visited · node_modules/x.js vendored-reported · big.bin size-reported ⇒ only the
  // silently-missing file remains. If this ever returns [], the detector itself is broken.
  assert.deepEqual(violations, ["sub/gone.ts"], "the silently-missing file must be flagged");
});

test("walk() visits every tracked file or reports why not (the loud-skip contract)", async () => {
  const tracked = execSync("git ls-files", { cwd: REPO, encoding: "utf8" })
    .trim().split(/\r?\n/).filter(Boolean)
    .filter((rel) => existsSync(path.join(REPO, rel))); // staged-deletes can linger in ls-files
  assert.ok(tracked.length >= 20, `control: the repo must actually have tracked files (got ${tracked.length})`);

  const skippedLarge: string[] = [];
  const skippedVendored: string[] = [];
  const metas = await walk(
    REPO,
    { maxFileSize: 5 * 1024 * 1024, useGitignore: true },
    skippedLarge,
    skippedVendored,
  );
  const visited = new Set(metas.map((m) => m.relPath));
  assert.ok(visited.size >= 20, `control: the walk must actually visit files (got ${visited.size})`);

  const violations = completenessViolations(tracked, visited, skippedVendored, skippedLarge);
  assert.deepEqual(violations, [],
    `silent narrowing: tracked files neither visited nor on any reported skip list:\n  ${violations.join("\n  ")}`);
});

test("a tiny size cap narrows coverage but NEVER silently — every miss lands on the reported list", async () => {
  const tracked = execSync("git ls-files", { cwd: REPO, encoding: "utf8" })
    .trim().split(/\r?\n/).filter(Boolean)
    .filter((rel) => existsSync(path.join(REPO, rel)));

  const skippedLarge: string[] = [];
  const skippedVendored: string[] = [];
  // 200 bytes: most files exceed it, so this drives the skip path HARD — the invariant must
  // hold precisely because every skipped file is named.
  const metas = await walk(REPO, { maxFileSize: 200, useGitignore: true }, skippedLarge, skippedVendored);
  assert.ok(skippedLarge.length > 0, "control: the tiny cap must actually skip something");

  const visited = new Set(metas.map((m) => m.relPath));
  const violations = completenessViolations(tracked, visited, skippedVendored, skippedLarge);
  assert.deepEqual(violations, [], "narrowed coverage is fine ONLY while it is fully reported");
});
