// links-temp-root.test.ts - MYCO-HARD-1c: TEMP_REFERENCE is judged on the part of
// a reference inside the scanned root, so a root that itself lives under /tmp or
// %TEMP% does not flag every absolute / file: URL link. Synthetic temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scanLinks } from "../src/links.ts";

async function tmpRoot(): Promise<{ base: string; root: string }> {
  // os.tmpdir() is /tmp on POSIX and %TEMP% on Windows: exactly the case under test.
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "myco-links-tmp-"));
  const root = path.join(base, "docs");
  await fs.mkdir(root);
  return { base, root };
}

test("file: URL and absolute links inside a root under the temp dir are not TEMP_REFERENCE", async () => {
  const { base, root } = await tmpRoot();
  try {
    await fs.writeFile(path.join(root, "target.md"), "synthetic");
    const lines = [`[url](${pathToFileURL(path.join(root, "target.md")).href})`, "[rel](target.md)"];
    if (process.platform !== "win32") lines.push(`[abs](<${path.join(root, "target.md")}>)`);
    await fs.writeFile(path.join(root, "notes.md"), lines.join("\n"));
    const s = await scanLinks(root);
    assert.deepEqual(s.findings, [], JSON.stringify(s.findings));
    assert.deepEqual(s.issues, []);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("a temp segment inside the root is still a TEMP_REFERENCE, written relative or as a file: URL", async () => {
  const { base, root } = await tmpRoot();
  try {
    await fs.mkdir(path.join(root, "tmp"));
    await fs.writeFile(path.join(root, "tmp", "scratch.md"), "synthetic");
    await fs.writeFile(path.join(root, "notes.md"), [
      "[rel](tmp/scratch.md)",
      `[url](${pathToFileURL(path.join(root, "tmp", "scratch.md")).href})`,
    ].join("\n"));
    const s = await scanLinks(root);
    const temps = s.findings.filter((x) => x.kind === "TEMP_REFERENCE");
    assert.equal(temps.length, 2, JSON.stringify(s.findings));
    assert.ok(temps.every((x) => x.temp));
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("a reference that leaves the root keeps its written temp flag and is EXCLUDED", async () => {
  const { base, root } = await tmpRoot();
  try {
    await fs.writeFile(path.join(root, "notes.md"), "[out](../../tmp/elsewhere.md)");
    const s = await scanLinks(root);
    assert.equal(s.findings.length, 1);
    assert.equal(s.findings[0]!.kind, "EXCLUDED");
    assert.equal(s.findings[0]!.temp, true);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("a dot-dot that resolves back inside the root is judged on where it lands", async () => {
  const { base, root } = await tmpRoot();
  try {
    await fs.mkdir(path.join(root, "tmp"));
    await fs.writeFile(path.join(root, "kept.md"), "synthetic");
    await fs.writeFile(path.join(root, "notes.md"), "[back](tmp/../kept.md)");
    const s = await scanLinks(root);
    assert.deepEqual(s.findings, [], JSON.stringify(s.findings));
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
