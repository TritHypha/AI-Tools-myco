// cli-streams.test.ts — owner-directed CLI defects (bridge 0138+), each guarded:
//
//   Defect 1 — informational notes/summary went to STDERR while exiting 0, so a
//   benign run was indistinguishable from a real failure at the shell/tool boundary
//   (PowerShell wraps native stderr as an error). Fix: info → stdout, stderr = errors
//   only. Guard: a successful search leaves stderr EMPTY; a real error does not.
//
//   Defect 2 — a FILE path arg died `ENOTDIR` (the per-directory index mkdir'd under
//   the file). Fix: a file path searches just that file (searchFile, no index).
//   Guard: `-s "a.b" <file>` returns the match (exit 0), and treats `.` literally.
//
//   Defect 3 — a NONEXISTENT path fell through to buildIndex, whose saveGraph()
//   recursively mkdir'd `<root>/.myco`, MATERIALISING a directory at a path the user
//   only queried (fail-open: a read-only search with a filesystem side effect; the
//   stray dir could then be matched by a test-runner glob → spurious failure). Fix:
//   cmdSearch + cmdIndex guard on existence → missing path exits 2, creates NOTHING.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderCoverage } from "../src/query/branches.ts";
import { terminalJson } from "../src/util/terminal.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const CLI_TIMEOUT_MS = 30_000;
const CLI_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLI_TIMEOUT_MS,
    });
    let out = "", err = "";
    let outputBytes = 0;
    const append = (current: string, chunk: Buffer): string => {
      outputBytes += chunk.byteLength;
      if (outputBytes > CLI_OUTPUT_LIMIT_BYTES) {
        child.kill();
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (d: Buffer) => { out = append(out, d); });
    child.stderr.on("data", (d: Buffer) => { err = append(err, d); });
    child.on("exit", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "myco-cli-"));
  writeFileSync(path.join(dir, "f.ts"), "let x = cache.read(k);\nlet y = a.b + 1;\nlet z = axb;\n");
  return dir;
}

test("defect 2: a FILE path arg searches that file (no ENOTDIR)", async () => {
  const dir = fixture();
  try {
    const r = await runCli(["-s", "a.b", path.join(dir, "f.ts"), "--no-color", "--no-gitignore"]);
    assert.equal(r.code, 0, `expected exit 0 for a file path, got ${r.code} (2 = the old ENOTDIR crash); err=${r.err}`);
    assert.match(r.out, /a\.b/, "should return the a.b match");
    assert.doesNotMatch(r.out, /axb/, "substring '.' must be literal — must NOT match axb");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("direct-file --max-size refuses over-cap content as incomplete JSON", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "myco-cli-direct-cap-"));
  const file = path.join(dir, "large.txt");
  writeFileSync(file, "x".repeat(1024 * 1024 + 1) + "needle");
  try {
    const r = await runCli(["-s", "needle", file, "--max-size", "1", "--json"]);
    assert.equal(r.code, 2, "unknown over-cap content must not be reported as a clean miss");
    assert.equal(r.err, "");
    const body = JSON.parse(r.out);
    assert.equal(body.complete, false);
    assert.equal(body.unknown[0]?.path, "large.txt");
    assert.equal(body.unknown[0]?.thresholdBytes, 1024 * 1024);
    assert.deepEqual(body.matches, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("defect 1: a successful search leaves STDERR empty (notes/summary on stdout)", async () => {
  const dir = fixture();
  try {
    const r = await runCli(["-s", "cache.read", dir, "--no-color", "--no-gitignore"]);
    assert.equal(r.err, "", `stderr must be empty on a successful run, got: ${JSON.stringify(r.err)}`);
    assert.match(r.out, /hit/, "the summary belongs on stdout now");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("defect 3: a NONEXISTENT search path exits 2 and creates NOTHING (no phantom .myco)", async () => {
  const dir = fixture();
  const missing = path.join(dir, "does-not-exist");
  try {
    const r = await runCli(["-s", "anything", missing, "--no-color", "--no-gitignore"]);
    assert.equal(r.code, 2, `a missing path must exit 2, got ${r.code}`);
    assert.match(r.err, /path not found/, "a missing path must report on stderr");
    // The core guarantee: a read-only query must have NO filesystem side effect.
    assert.equal(existsSync(missing), false, "myco must NOT materialise a directory at a queried path");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("defect 3: `myco index <nonexistent>` also exits 2 and creates NOTHING", async () => {
  const dir = fixture();
  const missing = path.join(dir, "does-not-exist");
  try {
    const r = await runCli(["index", missing, "--no-color"]);
    assert.equal(r.code, 2, `index of a missing path must exit 2, got ${r.code}`);
    assert.equal(existsSync(missing), false, "index must NOT mkdir at a nonexistent path");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a REAL error still goes to stderr and exits non-zero (stderr stays trustworthy)", async () => {
  const dir = fixture();
  try {
    const r = await runCli(["-e", "(a+)+$", dir, "--no-color", "--no-gitignore"]); // ReDoS pattern, refused fail-closed
    assert.equal(r.code, 2, `a refused pattern must exit 2, got ${r.code}`);
    assert.notEqual(r.err, "", "a real error MUST write to stderr");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an incomplete regex result exits 2 even though diagnostic evidence is returned", async () => {
  const dir = fixture();
  const file = path.join(dir, "evil.txt");
  writeFileSync(file, "a".repeat(5000) + "!");
  try {
    const r = await runCli(["-e", "(a|aa)+$", file, "--no-color"]);
    assert.equal(r.code, 2, `incomplete coverage must fail closed, got ${r.code}`);
    assert.match(r.out, /exceeded its deadline and was terminated/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("JSON search preserves skipped and unreadable coverage, and terminal output escapes control data", async () => {
  const dir = fixture();
  const overCap = path.join(dir, "oversize.txt");
  const control = path.join(dir, "control.txt");
  writeFileSync(overCap, "needle".repeat(200));
  writeFileSync(control, `needle\u001b[31mRED\u001b[0m\u0007\u009b[31m\n`);
  try {
    const json = await runCli(["-s", "needle", dir, "--json", "--max-size", "0.0001", "--no-gitignore"]);
    assert.equal(json.code, 2, "omitted over-size coverage must not return a complete success");
    const payload = JSON.parse(json.out) as { complete: boolean; skippedCoverage?: { largePaths: string[] }; unreadablePaths?: string[] };
    assert.equal(payload.complete, false);
    assert.ok(payload.skippedCoverage?.largePaths.includes("oversize.txt"), "machine output names the skipped path");

    const human = await runCli(["-s", "needle", control, "--no-color"]);
    assert.equal(human.code, 0);
    assert.doesNotMatch(human.out, /\u001b\[/, "terminal escape sequences from source text are rendered as data");
    assert.match(human.out, /\\x1b\[31mRED\\x1b\[0m\\x07/);

    const jsonText = await runCli(["-s", "needle", control, "--json"]);
    assert.equal(jsonText.code, 0);
    assert.doesNotMatch(jsonText.out, /\u009b/, "JSON remains safe when displayed in an 8-bit-control terminal");
    assert.equal(JSON.parse(jsonText.out).matches[0].text, `needle\u001b[31mRED\u001b[0m\u0007\u009b[31m`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("index coverage escapes controls in skipped filenames", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows filenames cannot contain terminal control characters");
    return;
  }
  const dir = fixture();
  const hostileName = "\u001b]0;owned\u0007.txt";
  writeFileSync(path.join(dir, hostileName), "x".repeat(200));
  try {
    const result = await runCli(["index", dir, "--max-size", "0.0001", "--no-color"]);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.out, /\u001b|\u0007/, "terminal controls must not reach stdout");
    assert.match(result.out, /\\x1b\]0;owned\\x07\.txt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("branch coverage escapes controls in skipped and unreadable path details", () => {
  const hostile = "\u001b]0;owned\u0007.txt";
  const rendered = renderCoverage({
    command: "search",
    repo: "myco",
    limited: null,
    branches: { searched: 0, total: 0 },
    worktrees: { searched: 0, total: 0 },
    targets: [],
    skipped: [`oversize: ${hostile}`],
    unreadable: [hostile],
    refused: [],
  });
  assert.doesNotMatch(rendered, /\u001b|\u0007/);
  assert.match(rendered, /\\x1b\]0;owned\\x07\.txt/);
});

test("JSON serialization escapes terminal C1 controls and round-trips the same data", () => {
  const value = { path: `name\u009b[31m`, text: "\u007f" };
  const encoded = terminalJson(value);
  assert.doesNotMatch(encoded, /\u009b|\u007f/);
  assert.deepEqual(JSON.parse(encoded), value);
});

test("index and status disclose overlong-term omissions without exposing term bodies", async () => {
  const dir = fixture();
  const overlong = `${"a".repeat(2050)}hiddenneedle${"b".repeat(2050)}`;
  writeFileSync(path.join(dir, "overlong.txt"), `${overlong}\nkeep\n`);
  try {
    const indexed = await runCli(["index", dir, "--no-color", "--no-gitignore"]);
    assert.equal(indexed.code, 0, `index should succeed with a searchable omission marker; err=${indexed.err}`);
    assert.equal(indexed.err, "", "successful omission reporting belongs on stdout");
    assert.match(indexed.out, /1 overlong term\(s\) omitted from the term graph in 1 file\(s\)/);
    assert.match(indexed.out, /overlong\.txt/);
    assert.doesNotMatch(indexed.out, new RegExp(overlong), "the omitted term body must not be disclosed");

    const status = await runCli(["status", dir, "--no-color"]);
    assert.equal(status.code, 0, `the saved index must remain readable; err=${status.err}`);
    assert.equal(status.err, "");
    assert.match(status.out, /omitted overlong terms:\s+1/);
    assert.match(status.out, /files requiring direct verification:\s+1/);
    assert.doesNotMatch(status.out, new RegExp(overlong), "status must report aggregate metadata only");

    const searched = await runCli([
      "-s",
      "hiddenneedle",
      dir,
      "--no-refresh",
      "--no-color",
      "--no-gitignore",
    ]);
    assert.equal(searched.code, 0, `persisted omission metadata must recover the match; err=${searched.err}`);
    assert.match(searched.out, /overlong\.txt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("status distinguishes unique content vocabulary from file-term links", async () => {
  const dir = fixture();
  writeFileSync(path.join(dir, "f.ts"), ""); // fixture path tokens must not affect content-term metrics
  writeFileSync(path.join(dir, "alpha.txt"), "Echo echo echo delta\n");
  writeFileSync(path.join(dir, "beta.md"), "ECHO gamma\n");
  try {
    const indexed = await runCli(["index", dir, "--no-color", "--no-gitignore"]);
    assert.equal(indexed.code, 0, indexed.err);

    const status = await runCli(["status", dir, "--no-color"]);
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /unique content terms:\s+3 \(case-folded; not occurrences; path-name terms are separate\)/);
    assert.match(status.out, /file-term links:\s+4 \(distinct file\/term pairs; repeats in one file count once\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
