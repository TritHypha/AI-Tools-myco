#!/usr/bin/env node
// check-vendor.mjs -- fail loudly if the vendored TriRegex engine is missing or drifted.
//
// myco imports TriRegex from src/vendor/triregex (and dist/vendor/triregex after a
// build). A copy of myco vendored into another project once lost that folder (a
// broad "vendor/" ignore/exclude rule in the consumer) and the next refresh died
// with an opaque ERR_MODULE_NOT_FOUND. This guard names the problem and the fix.
//
// Usage: node scripts/check-vendor.mjs [mycoRoot]   (exit 0 ok, 1 missing/drift)

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(here, ".."));
const dir = path.join(root, "src", "vendor", "triregex");
export const REQUIRED = ["compile.ts", "engine.ts", "find-all.ts", "index.ts", "parser.ts", "types.ts", "LICENSE", "VENDORED.md"];

const problems = [];
for (const f of REQUIRED) {
  if (!existsSync(path.join(dir, f))) problems.push(`missing: src/vendor/triregex/${f}`);
}

// VENDORED.md carries "sha256 <hex> <file>" lines over LF-normalised content.
if (existsSync(path.join(dir, "VENDORED.md"))) {
  const manifest = readFileSync(path.join(dir, "VENDORED.md"), "utf8");
  const re = /^- sha256 ([0-9a-f]{64}) (\S+\.ts)$/gm;
  let m, seen = 0;
  while ((m = re.exec(manifest.replace(/\r\n/g, "\n")))) {
    seen++;
    const p = path.join(dir, m[2]);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    const got = createHash("sha256").update(text).digest("hex");
    if (got !== m[1]) problems.push(`drift: src/vendor/triregex/${m[2]} sha256 ${got} != VENDORED.md ${m[1]}`);
  }
  if (seen !== 6) problems.push(`VENDORED.md lists ${seen} sha256 lines, expected 6`);
}

if (problems.length) {
  console.error("myco: vendored TriRegex engine is incomplete -- myco cannot run without it.");
  for (const p of problems) console.error("  " + p);
  console.error(`  root: ${root}`);
  console.error("  fix: re-copy myco's src/ (including src/vendor/triregex/) from the main myco repo;");
  console.error("       make sure no 'vendor/' ignore or copy-exclude rule drops it. See src/vendor/triregex/VENDORED.md.");
  process.exit(1);
}
console.log(`myco: vendored TriRegex OK (${REQUIRED.length} files) at ${dir}`);
