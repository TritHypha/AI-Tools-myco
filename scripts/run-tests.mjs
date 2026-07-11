// run-tests.mjs — cross-platform test runner.
//
// Node's test runner + native TypeScript type-stripping. We enumerate the .ts
// test files ourselves and pass them explicitly so this works identically on
// Windows PowerShell (no shell globbing) and POSIX shells.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(here, "..", "test");

const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(testDir, f));

if (files.length === 0) {
  console.error("no test files found in", testDir);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
