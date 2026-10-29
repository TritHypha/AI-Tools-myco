#!/usr/bin/env node
// mutate-review.mjs — mutation check for the `myco check` rules.
// Each mutation breaks one key rule in src/review/check.ts; test/review.test.ts
// must FAIL for every one ("killed"). The source is always restored.
// Usage: node scripts/mutate-review.mjs   (exit 0 = all killed, 1 = a survivor)
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "src/review/check.ts";
const MUTANTS = [
  ["threshold strict > becomes >=", "value > t.warnAbove) return \"WARN\"", "value >= t.warnAbove) return \"WARN\""],
  ["FAIL threshold ignored", "if (t.failAbove !== null && value > t.failAbove) return \"FAIL\";", ""],
  ["exit code always 0", "export const exitCodeFor = (l: Level): number => RANK[l];", "export const exitCodeFor = (_l: Level): number => 0;"],
  ["unexplained tracked files not counted", "else unexplained.push(p);", "else void p;"],
  ["shard sha256 mismatch ignored", "if (sha !== e.sha256) problems.push(", "if (false) problems.push("],
  ["gap growth inverted", "const growth = gap - prev.metrics.gap;", "const growth = prev.metrics.gap - gap;"],
  ["secret growth ignored", "const growth = prev ? withheldFiles - prev.metrics.withheldSecretFiles : 0;", "const growth = 0;"],
  ["missing summary.md ignored", "if (!hasMd) missingSummary.push(", "if (false) missingSummary.push("],
  ["capped-at-limit off by one", "if (hits >= rules.resultLimit) capped.push(", "if (hits > rules.resultLimit) capped.push("],
  ["diff.patch header not checked", "else if (!patch.startsWith(\"# myco compare \"))", "else if (false)"],
  ["diff.patch hunk not checked", "else if (!/^@@ -\\d+(,\\d+)? \\+\\d+(,\\d+)? @@/m.test(patch))", "else if (false)"],
];

const original = readFileSync(FILE, "utf8");
let survivors = 0;
try {
  for (const [name, from, to] of MUTANTS) {
    if (!original.includes(from)) { console.log(`MISSING ANCHOR  ${name}`); survivors++; continue; }
    writeFileSync(FILE, original.replace(from, to));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", "test/review.test.ts"], { encoding: "utf8" });
    const killed = r.status !== 0;
    if (!killed) survivors++;
    console.log(`${killed ? "KILLED  " : "SURVIVED"}  ${name}`);
  }
} finally {
  writeFileSync(FILE, original);
}
console.log(`${MUTANTS.length - survivors}/${MUTANTS.length} mutants killed`);
process.exit(survivors ? 1 : 0);
