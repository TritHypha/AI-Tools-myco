import { test } from "node:test";
import assert from "node:assert/strict";

import { countTerms } from "../src/ingest/tokenize.ts";
import { foldCase } from "../src/util/normalize.ts";

test("countTerms folds case and counts occurrences", () => {
  const counts = countTerms("Hello hello HELLO world");
  assert.equal(counts.get("hello"), 3);
  assert.equal(counts.get("world"), 1);
  assert.equal(counts.get("Hello"), undefined); // only the folded form is stored
});

test("countTerms splits on non-word characters, keeps underscores", () => {
  const counts = countTerms("foo_bar foo-bar foo.bar");
  assert.equal(counts.get("foo_bar"), 1); // underscore is a word char
  assert.equal(counts.get("foo"), 2); // the hyphen and dot split
  assert.equal(counts.get("bar"), 2);
});

test("foldCase normalizes case but preserves accents", () => {
  assert.equal(foldCase("CAFÉ"), "café");
  assert.notEqual(foldCase("café"), foldCase("cafe")); // accent is significant
});

test("countTerms handles Unicode letters", () => {
  const counts = countTerms("naïve café Ω_omega");
  assert.equal(counts.get("naïve"), 1);
  assert.equal(counts.get("café"), 1);
  assert.equal(counts.get("ω_omega"), 1);
});
