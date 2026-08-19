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
