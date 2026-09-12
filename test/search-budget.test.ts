import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildIndex, search, isError } from "../src/index.ts";

for (const scenario of [
  { mode: "word" as const, files: false },
  { mode: "regex" as const, files: false },
  { mode: "regex" as const, files: true },
]) {
  for (const elapsed of [6_000, 119_000, 120_001]) {
    test(`${scenario.mode} ${scenario.files ? "name" : "content"} search at ${elapsed}ms retains the two-minute ceiling`, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "myco-search-budget-"));
      try {
        await fs.writeFile(path.join(root, "needle.txt"), "needle\n");
        const { graph } = await buildIndex(root, { maxFileSize: 1024, useGitignore: false });
        // Control only wall-clock observation; file IO, graph and regex worker remain real.
        let first = true;
        t.mock.method(Date, "now", () => {
          if (first) { first = false; return 1_000_000; }
          return 1_000_000 + elapsed;
        });
        const result = await search(root, graph, "needle", {
          ...scenario, caseSensitive: "smart", limit: 10, context: 0,
        });
        assert.ok(!isError(result));
        if (isError(result)) return;
        const expired = elapsed > 120_000;
        assert.equal(result.searchTimeBudgetExceeded, expired);
        assert.equal(result.truncated, expired);
        assert.equal(result.matches.length, expired ? 0 : 1);
        assert.equal(result.regexTimedOut, false);
        assert.equal(result.resultLimitExceeded, false);
      } finally {
        t.mock.restoreAll();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}

