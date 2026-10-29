// secret-guard.test.ts - MYCO-HARD-1 item 2 (2026-10-28): secret-looking terms are
// WITHHELD from the stored index (.myco), reported by path, and still findable by
// search (the file is re-read directly). Synthetic tokens only, built at run time
// from a seeded generator so no credential-shaped literal sits in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifySecretTerm,
  knownSecretShape,
  shannonBitsPerChar,
  SECRET_MIN_ENTROPY_BITS,
  SECRET_MIN_LENGTH,
} from "../src/ingest/secret-guard.ts";
import { countTerms } from "../src/ingest/tokenize.ts";
import { buildIndex, DEFAULT_INDEX_OPTIONS } from "../src/ingest/indexer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const B36 = "abcdefghijklmnopqrstuvwxyz0123456789";

// Seeded LCG: deterministic "random-looking" synthetic strings, no real secrets.
function synth(seed: number, len: number, alphabet = B36): string {
  // mulberry32: small, deterministic, well mixed.
  let a = seed >>> 0;
  let out = "";
  for (let i = 0; i < len; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out += alphabet[Math.floor(r * alphabet.length)];
  }
  return out;
}
// Ensure at least a few digits so the high-entropy rule's digit floor is exercised honestly.
function synthSecret(seed: number, len = 40): string {
  const s = synth(seed, len);
  return s.slice(0, len - 4) + "7391";
}
const ghLike = (seed: number): string => ["gh", "p_"].join("") + synth(seed, 36);
const awsLike = (seed: number): string => ["ak", "ia"].join("") + synth(seed, 16, "abcdefghijklmnopqrstuvwxyz234567");
const stripeLike = (seed: number): string => ["sk", "_live_"].join("") + synth(seed, 24);

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "myco-hard1-secret-"));
}

async function mycoBytes(root: string): Promise<string> {
  const dir = path.join(root, ".myco");
  const parts: string[] = [];
  async function rec(d: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile()) parts.push(await fs.readFile(p, "utf8"));
    }
  }
  await rec(dir);
  return parts.join("\n");
}

test("SG-01 known credential shapes are KNOWN_PREFIX", () => {
  for (let seed = 1; seed <= 5; seed++) {
    assert.equal(classifySecretTerm(ghLike(seed)), "KNOWN_PREFIX");
    assert.equal(classifySecretTerm(awsLike(seed)), "KNOWN_PREFIX");
    assert.equal(classifySecretTerm(stripeLike(seed)), "KNOWN_PREFIX");
  }
  assert.equal(knownSecretShape(ghLike(9)), "github-token");
  assert.equal(knownSecretShape(awsLike(9)), "aws-access-key-id");
  assert.equal(knownSecretShape("ghp_short"), undefined);
});

test("SG-02 long mixed high-entropy terms are HIGH_ENTROPY", () => {
  let hits = 0;
  for (let seed = 100; seed < 150; seed++) {
    const t = synthSecret(seed);
    assert.ok(shannonBitsPerChar(t) >= SECRET_MIN_ENTROPY_BITS, `entropy floor for seed ${seed}`);
    if (classifySecretTerm(t) === "HIGH_ENTROPY") hits++;
  }
  assert.equal(hits, 50);
});

test("SG-03 hashes, identifiers and short words stay storable", () => {
  const keep = [
    synth(7, 40, "0123456789abcdef"), // commit SHA shape
    synth(8, 64, "0123456789abcdef"), // sha256 shape
    "0123456789abcdef".repeat(3), // perfectly uniform hex: 4.0 bits/char, kept only by the hex exemption
    "verify_governance_algebra_k3_strong_kleene_pin_test",
    "packages_ts_galerina_tower_citizen_tests_k3",
    "test_k3_frame_epoch_unix_seconds_2026102815",
    "decodek3packageframe",
    "k3_frame_epoch_2026_10_28_15_45_00_wire_version_4",
    "abcdefghijklmnopqrstuvwxyzabcdefgh", // long, no digits
    synth(5, SECRET_MIN_LENGTH - 1), // just under the length floor
    "hello",
    "",
  ];
  for (const t of keep) assert.equal(classifySecretTerm(t), null, `should keep ${JSON.stringify(t)}`);
  // ...but a base64url-style random token containing "_" is NOT exempt.
  assert.equal(classifySecretTerm(synth(3, 20) + "_" + synth(4, 19) + "42"), "HIGH_ENTROPY");
});

test("SG-04 shannonBitsPerChar basics", () => {
  assert.equal(shannonBitsPerChar(""), 0);
  assert.equal(shannonBitsPerChar("aaaa"), 0);
  assert.equal(shannonBitsPerChar("abab"), 1);
  assert.equal(shannonBitsPerChar("abcd"), 2);
});

test("SG-05 countTerms withholds only when the report asks for it", () => {
  const secret = synthSecret(42);
  const text = `const token = "${secret}"; const name = "plain";`;
  const report = { omittedOverlongTerms: 0, withheldSecretTerms: 0 };
  const on = countTerms(text, report);
  assert.equal(on.has(secret), false);
  assert.equal(on.get("plain"), 1);
  assert.equal(report.withheldSecretTerms, 1);
  // Back-compat: no report (or a report without the field) stores every term.
  assert.equal(countTerms(text).has(secret), true);
  assert.equal(countTerms(text, { omittedOverlongTerms: 0 }).has(secret), true);
});

test("SG-06 buildIndex keeps secrets out of .myco and reports the paths", async (t) => {
  const root = await scratch();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = synthSecret(77);
  const gh = ghLike(78);
  await fs.writeFile(path.join(root, "config.txt"), `api_key = ${secret}\nother = ${gh}\nmarker zebrafish\n`);
  await fs.writeFile(path.join(root, "clean.txt"), "nothing secret here quokka\n");
  const r = await buildIndex(root, DEFAULT_INDEX_OPTIONS);
  assert.equal(r.stats.withheldSecretTerms, 2);
  assert.equal(r.stats.filesWithWithheldSecrets, 1);
  assert.deepEqual(r.withheldSecretPaths, ["config.txt"]);
  const stored = await mycoBytes(root);
  assert.equal(stored.includes(secret), false, "secret must not be in .myco");
  assert.equal(stored.includes(gh), false, "gh-like token must not be in .myco");
  assert.ok(stored.includes("zebrafish"), "ordinary terms still stored");
  const rec = r.graph.fileByPath("config.txt");
  assert.ok((rec?.omittedOverlongTerms ?? 0) >= 2, "file flagged for direct verification");
  assert.equal(r.graph.fileByPath("clean.txt")?.omittedOverlongTerms ?? 0, 0);
});

test("SG-07 withholdSecrets:false stores the term (guard is the only thing withholding)", async (t) => {
  const root = await scratch();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = synthSecret(91);
  await fs.writeFile(path.join(root, "a.txt"), `k ${secret}\n`);
  const r = await buildIndex(root, { ...DEFAULT_INDEX_OPTIONS, withholdSecrets: false });
  assert.equal(r.stats.withheldSecretTerms, 0);
  assert.equal((await mycoBytes(root)).includes(secret), true);
});

test("SG-08 CLI index reports the path, never the value; search still finds it", async (t) => {
  const root = await scratch();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = synthSecret(55);
  await fs.writeFile(path.join(root, "leak.txt"), `x = ${secret}\n`);
  const idx = spawnSync(process.execPath, ["--experimental-strip-types", cli, "index", root], { encoding: "utf8" });
  assert.equal(idx.status, 0, idx.stderr);
  assert.match(idx.stdout, /secret-looking term\(s\) in 1 file\(s\) read this run were WITHHELD/);
  assert.match(idx.stdout, /leak\.txt/);
  assert.equal(idx.stdout.includes(secret), false, "value never printed");
  assert.equal((await mycoBytes(root)).includes(secret), false);
  const s = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cli, secret, root, "--no-refresh", "--no-branches"],
    { encoding: "utf8" },
  );
  assert.equal(s.status, 0, `search must still find the file: ${s.stdout}${s.stderr}`);
  assert.match(s.stdout, /leak\.txt/);
});

test("SG-09 help names --no-secret-guard", () => {
  const h = spawnSync(process.execPath, ["--experimental-strip-types", cli, "--help"], { encoding: "utf8" });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--no-secret-guard/);
  assert.match(h.stdout, /--at REV/);
});
