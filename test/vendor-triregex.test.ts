import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Guard: myco must be self-contained. A copy vendored into another project once lost
// src/vendor/triregex/ and failed opaquely. These tests keep the folder complete,
// un-drifted from VENDORED.md, shipped in the npm package, and not git-ignorable.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const script = path.join(root, "scripts", "check-vendor.mjs");

test("vendored TriRegex is complete and matches VENDORED.md sha256 manifest", () => {
  const r = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("check-vendor fails clearly when src/vendor/triregex/index.ts is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "myco-vendorcheck-"));
  try {
    const src = path.join(root, "src", "vendor", "triregex");
    const dst = path.join(tmp, "src", "vendor", "triregex");
    await fs.mkdir(dst, { recursive: true });
    for (const f of await fs.readdir(src)) if (f !== "index.ts") await fs.copyFile(path.join(src, f), path.join(dst, f));
    const r = spawnSync(process.execPath, [script, tmp], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing: src\/vendor\/triregex\/index\.ts/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("package.json ships src (with the vendored engine) and the guard", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("src"), "package.json files must include src");
  assert.ok(pkg.files.includes("scripts/check-vendor.mjs"));
  assert.match(pkg.scripts.prepublishOnly, /check-vendor/);
});

test(".gitignore re-includes src/vendor so a global 'vendor/' ignore cannot drop it", async () => {
  const gi = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(gi, /^!src\/vendor\/$/m);
  assert.match(gi, /^!src\/vendor\/triregex\/\*\*$/m);
});
