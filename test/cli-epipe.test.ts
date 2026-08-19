// cli-epipe.test.ts — a truncated stdout pipe (`myco … | head`, a pager quit
// early) must NOT crash the CLI. A downstream close makes stdout emit an async
// 'error' (EPIPE) that the promise chain in cli.ts cannot catch; without the
// early `process.stdout.on("error", …)` handler the process exits 255. This
// guards that fix (it goes red if the handler is removed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const CLI_TIMEOUT_MS = 30_000;

test("CLI exits 0 when the stdout pipe closes early (no EPIPE crash)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "myco-epipe-"));
  try {
    // Enough matches that the CLI is still writing when the reader closes,
    // so the EPIPE is actually provoked rather than a small one-chunk write.
    writeFileSync(path.join(dir, "big.txt"), "needle needle needle a b c d\n".repeat(20000));

    const code: number = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", CLI, "-s", "needle", dir, "--no-color", "--no-gitignore"],
        { stdio: ["ignore", "pipe", "ignore"], timeout: CLI_TIMEOUT_MS },
      );
      let closed = false;
      child.stdout.on("data", () => {
        if (!closed) { closed = true; child.stdout.destroy(); } // close read side -> child's next write EPIPEs
      });
      child.on("exit", (c) => resolve(c ?? -1));
    });

    assert.equal(code, 0, `expected a clean exit 0 on a truncated pipe, got ${code} (255 = the EPIPE crash)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
