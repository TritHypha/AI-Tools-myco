import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessRegexSafety,
  selfTest,
  MAX_REPETITION,
  MAX_REGEX_LINE_LEN,
  SEARCH_TIME_BUDGET_MS,
} from "../src/query/regex-guard.ts";

test("refuses the canonical exponential shapes (nested expanding quantifiers)", () => {
  for (const bad of ["(a+)+", "(a*)*", "(a+)*", "(.*)+", "((ab)+)*", "(a+)+$", "(\\d+)+", "(?:a+)+", "(a{1,3})+", "(\\d+){2,}"]) {
    const v = assessRegexSafety(bad);
    assert.equal(v.safe, false, `should refuse: ${bad}`);
    if (!v.safe) assert.match(v.reason, /star height|repetition/);
  }
});

test("refuses absurd bounded-repetition counts", () => {
  assert.equal(assessRegexSafety("a{5000}").safe, false);
  assert.equal(assessRegexSafety("(ab){1000,}").safe, false);
  assert.equal(assessRegexSafety(`x{${MAX_REPETITION}}`).safe, false);
  assert.equal(assessRegexSafety(`x{${MAX_REPETITION - 1}}`).safe, true); // one under is fine
});

test("allows ordinary safe patterns (low false-positive rate)", () => {
  for (const ok of [
    "foo", "a+", "a+b+", "(abc)+", "(a|b)*", "\\bword\\b", "colou?r",
    "[a-z]+\\d{1,4}", "^import\\s+", "\\(a+\\)+", "[(+]*", "(a+)", "\\d{1,3}(\\.\\d{1,3}){3}",
    "(a+){3}", "(a{3})+",
  ]) {
    const v = assessRegexSafety(ok);
    assert.equal(v.safe, true, `should allow: ${ok}${v.safe ? "" : " — " + v.reason}`);
  }
});

test("escaped parens are literals, not groups; char classes are one atom", () => {
  assert.equal(assessRegexSafety("\\(a+\\)+").safe, true); // (a+) is literal text, not a group
  assert.equal(assessRegexSafety("[a-z]{2,8}").safe, true);
  assert.equal(assessRegexSafety("[)+*]+").safe, true); // metachars inside a class are inert
});

test("the guard ships a passing self-test (baseline)", () => {
  const { failures } = selfTest();
  assert.deepEqual(failures, [], `self-test failures:\n${failures.join("\n")}`);
});

test("constants are sane bounds", () => {
  assert.ok(MAX_REPETITION >= 100);
  assert.ok(MAX_REGEX_LINE_LEN >= 10_000);
  assert.ok(SEARCH_TIME_BUDGET_MS >= 1_000);
});
