import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../src/index.ts";

// Drift gate. The CLI prints `VERSION` for `myco --version`; package.json carries the
// real published version. They were found out of sync (VERSION said 0.1.0 while the
// package was 0.1.1) — so `myco --version` lied and a downstream reader (Galerina's
// component-health tracking registry) inherited the stale number. Code is the source of
// truth; this test makes the two agree by construction, forever.
test("VERSION matches package.json (no version drift)", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(await fs.readFile(path.join(here, "..", "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version, "src/index.ts VERSION must equal package.json version");
});
