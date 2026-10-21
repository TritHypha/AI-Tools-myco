import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";

import { validateStoredIndex } from "../src/graph/index-contract.ts";
import { SearchGraph } from "../src/graph/model.ts";
import { loadGraph, saveGraph } from "../src/graph/store.ts";
import { buildIndex } from "../src/ingest/indexer.ts";
import { search, isError } from "../src/query/search.ts";
import { render } from "../src/output.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const CLI = path.join(repoRoot, "src", "cli.ts");
const MIB = 1024 * 1024;
const CLI_TIMEOUT_MS = 30_000;

const oversizeMarker = {
  type: "UNKNOWN" as const,
  state: "INDEXED_UNKNOWN" as const,
  reason: "OVERSIZE" as const,
};

async function scratch(): Promise<string> {
  return fs.mkdtemp(path.join(repoRoot, ".tmp-oversize-"));
}

async function writeIndex(root: string, value: unknown): Promise<void> {
  await fs.mkdir(path.join(root, ".myco"), { recursive: true });
  await fs.writeFile(path.join(root, ".myco", "index.json"), JSON.stringify(value), "utf8");
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function runCli(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLI_TIMEOUT_MS,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
    child.on("exit", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function parseJsonPayload(out: string): unknown {
  const start = out.indexOf("{");
  assert.ok(start >= 0, `JSON object missing in CLI stdout: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start));
}

test("(a) just-over cap becomes INDEXED_UNKNOWN; exact cap stays content; u round-trips", async () => {
  const root = await scratch();
  try {
    const over = Buffer.alloc(MIB + 1, 0x61);
    const exact = Buffer.from("exactcapneedle " + "x".repeat(64));
    await fs.writeFile(path.join(root, "huge.bin"), over);
    await fs.writeFile(path.join(root, "exact.txt"), exact);
    const built = await buildIndex(root, { maxFileSize: MIB, useGitignore: false });
    const huge = built.graph.fileByPath("huge.bin");
    const exactRec = built.graph.fileByPath("exact.txt");
    assert.equal(huge?.contentSkip, "large");
    assert.equal(huge?.unknown?.type, "UNKNOWN");
    assert.equal(huge?.unknown?.state, "INDEXED_UNKNOWN");
    assert.equal(huge?.unknown?.reason, "OVERSIZE");
    assert.equal(huge?.unknown?.thresholdBytes, MIB);
    assert.equal(huge?.unknown?.sha256, undefined);
    assert.equal(exactRec?.contentSkip, undefined);
    assert.equal(exactRec?.unknown, undefined);
    assert.ok(built.graph.hasContent(exactRec!.id));
    assert.equal(built.graph.hasContent(huge!.id), false);

    const saved = JSON.parse(await fs.readFile(path.join(root, ".myco", "index.json"), "utf8"));
    const hugeStored = saved.files.find((f: { p: string }) => f.p === "huge.bin");
    assert.equal(hugeStored.k, "l");
    assert.deepEqual(hugeStored.u, { st: "INDEXED_UNKNOWN", r: "OVERSIZE", th: MIB });
    assert.equal(hugeStored.t.length, 0);

    const reloaded = await loadGraph(root);
    assert.ok(reloaded);
    const again = reloaded.graph.fileByPath("huge.bin");
    assert.equal(again?.unknown?.state, "INDEXED_UNKNOWN");
    assert.equal(again?.unknown?.thresholdBytes, MIB);
    assert.equal(reloaded.graph.unknownFiles().length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("(b) legacy k:l without u loads as UNKNOWN NOT_RECORDED", async () => {
  const root = await scratch();
  try {
    await writeIndex(root, {
      format: 1,
      createdAt: 1,
      files: [{ p: "legacy.bin", m: 1, s: MIB + 5, t: [], k: "l" }],
    });
    const loaded = await loadGraph(root);
    assert.ok(loaded);
    const rec = loaded.graph.fileByPath("legacy.bin");
    assert.equal(rec?.contentSkip, "large");
    assert.equal(rec?.unknown?.type, "UNKNOWN");
    assert.equal(rec?.unknown?.state, "INDEXED_UNKNOWN");
    assert.equal(rec?.unknown?.reason, "OVERSIZE");
    assert.equal(rec?.unknown?.thresholdBytes, "NOT_RECORDED");
    assert.equal(rec?.unknown?.sha256, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("(c) validator rejects each malformed u case", () => {
  const baseFile = { p: "huge.bin", m: 1, s: MIB + 1, t: [], k: "l" as const };
  const goodU = { st: "INDEXED_UNKNOWN", r: "OVERSIZE", th: MIB };
  const wrap = (files: unknown[]) => ({ format: 1, createdAt: 1, files });

  assert.ok(validateStoredIndex(wrap([{ ...baseFile, u: goodU }])));

  assert.equal(validateStoredIndex(wrap([{ ...baseFile, u: { ...goodU, st: "INDEXED" } }])), null, "st other than INDEXED_UNKNOWN");
  assert.equal(validateStoredIndex(wrap([{ ...baseFile, u: { ...goodU, r: "SKIPPED" } }])), null, "r other than OVERSIZE");
  assert.equal(validateStoredIndex(wrap([{ ...baseFile, u: { ...goodU, th: 0 } }])), null, "th <= 0");
  assert.equal(validateStoredIndex(wrap([{ ...baseFile, u: { ...goodU, th: 1.5 } }])), null, "th not integer");
  assert.equal(validateStoredIndex(wrap([{ ...baseFile, s: MIB, u: goodU }])), null, "s <= th");
  assert.equal(validateStoredIndex(wrap([{ ...baseFile, u: { ...goodU, h: "zz" } }])), null, "malformed h");
  assert.equal(validateStoredIndex(wrap([{ ...baseFile, u: { ...goodU, extra: 1 } }])), null, "extra u key");
  assert.equal(
    validateStoredIndex(wrap([{ p: "a.bin", m: 1, s: 99, t: [], k: "b", u: goodU }])),
    null,
    "u on non-l node",
  );
  assert.equal(
    validateStoredIndex(wrap([{ p: "a.txt", m: 1, s: MIB + 1, t: [["x", 1]], u: goodU }])),
    null,
    "u without k",
  );
});

test("(d) JSON search with a marker reports complete:false and unknown[], including zero hits", async () => {
  const root = await scratch();
  try {
    await fs.writeFile(path.join(root, "huge.bin"), Buffer.alloc(MIB + 1, 0x61));
    await fs.writeFile(path.join(root, "hit.txt"), "findme needle\n");
    const built = await buildIndex(root, { maxFileSize: MIB, useGitignore: false });
    const hit = await search(root, built.graph, "findme", {
      mode: "word",
      caseSensitive: "smart",
      files: false,
      limit: 200,
      context: 0,
    });
    assert.ok(!isError(hit));
    if (isError(hit)) throw new Error("unreachable");
    assert.equal(hit.complete, false);
    assert.equal(hit.unknown.length, 1);
    assert.equal(hit.unknown[0]?.path, "huge.bin");
    assert.equal(hit.unknown[0]?.state, "INDEXED_UNKNOWN");
    assert.ok(hit.matches.length > 0);

    const miss = await search(root, built.graph, "nosuchtermxyz", {
      mode: "word",
      caseSensitive: "smart",
      files: false,
      limit: 200,
      context: 0,
    });
    assert.ok(!isError(miss));
    if (isError(miss)) throw new Error("unreachable");
    assert.equal(miss.matches.length, 0);
    assert.equal(miss.complete, false);
    assert.equal(miss.unknown.length, 1);

    const json = render(miss, false, { color: false, json: true });
    const parsed = JSON.parse(json) as { complete: boolean; unknown: unknown[] };
    assert.equal(parsed.complete, false);
    assert.equal(parsed.unknown.length, 1);

    const cli = await runCli(
      ["--json", "--no-gitignore", "--max-size", "1", "nosuchtermxyz", root],
      repoRoot,
    );
    const cliJson = parseJsonPayload(cli.out) as { complete: boolean; unknown: Array<{ path: string }> };
    assert.equal(cliJson.complete, false);
    assert.equal(cliJson.unknown[0]?.path, "huge.bin");
    assert.equal(cli.code, 2, "incomplete coverage fails closed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("(e) --hash-oversize off omits h; on writes the streamed sha256", async () => {
  const root = await scratch();
  try {
    const over = Buffer.alloc(MIB + 1, 0x63);
    await fs.writeFile(path.join(root, "huge.bin"), over);
    const off = await buildIndex(root, { maxFileSize: MIB, useGitignore: false, hashOversize: false });
    assert.equal(off.graph.fileByPath("huge.bin")?.unknown?.sha256, undefined);
    const storedOff = JSON.parse(await fs.readFile(path.join(root, ".myco", "index.json"), "utf8"));
    assert.equal(storedOff.files[0].u.h, undefined);

    const on = await buildIndex(root, { maxFileSize: MIB, useGitignore: false, hashOversize: true });
    const hashed = on.graph.fileByPath("huge.bin")?.unknown?.sha256;
    assert.equal(hashed, sha256Hex(over));
    const storedOn = JSON.parse(await fs.readFile(path.join(root, ".myco", "index.json"), "utf8"));
    assert.equal(storedOn.files[0].u.h, sha256Hex(over));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("(f) cap change re-classifies; fast path does not reuse a different threshold", async () => {
  const root = await scratch();
  try {
    const body = Buffer.concat([Buffer.from("reclassneedle "), Buffer.alloc(MIB + 1, 0x64)]);
    await fs.writeFile(path.join(root, "mid.bin"), body);
    const small = await buildIndex(root, { maxFileSize: MIB, useGitignore: false });
    assert.equal(small.graph.fileByPath("mid.bin")?.contentSkip, "large");
    assert.equal(small.graph.fileByPath("mid.bin")?.unknown?.thresholdBytes, MIB);

    const raised = await buildIndex(root, { maxFileSize: 8 * MIB, useGitignore: false });
    const rec = raised.graph.fileByPath("mid.bin");
    assert.equal(rec?.contentSkip, undefined, "raising the cap must content-index the file");
    assert.equal(rec?.unknown, undefined);
    assert.ok(raised.graph.hasContent(rec!.id));
    const outcome = await search(root, raised.graph, "reclassneedle", {
      mode: "word",
      caseSensitive: "smart",
      files: false,
      limit: 200,
      context: 0,
    });
    assert.ok(!isError(outcome));
    if (isError(outcome)) throw new Error("unreachable");
    assert.ok(outcome.matches.length > 0);
    assert.equal(outcome.unknown.length, 0);
    assert.equal(outcome.complete, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MU1 drop the marker: setFile large without unknown throws; tracked sha256 restored", async () => {
  const modelPath = path.join(repoRoot, "src", "graph", "model.ts");
  const before = sha256Hex(await fs.readFile(modelPath));
  try {
    const g = new SearchGraph();
    assert.throws(
      () => g.setFile("big.dat", 2, 1_000_000, new Map(), "large"),
      /MYCO-INDEX-UNKNOWN/,
    );
    assert.throws(
      () => g.setFile("ok.txt", 1, 1, new Map(), undefined, 0, { ...oversizeMarker, thresholdBytes: 1 }),
      /MYCO-INDEX-UNKNOWN/,
    );
  } finally {
    assert.equal(sha256Hex(await fs.readFile(modelPath)), before);
  }
});

test("MU2 complete:true despite unknowns is refused by the search result", async () => {
  const root = await scratch();
  try {
    await fs.writeFile(path.join(root, "huge.bin"), Buffer.alloc(MIB + 1, 0x61));
    const built = await buildIndex(root, { maxFileSize: MIB, useGitignore: false });
    const outcome = await search(root, built.graph, "zzz", {
      mode: "word",
      caseSensitive: "smart",
      files: false,
      limit: 200,
      context: 0,
    });
    assert.ok(!isError(outcome));
    if (isError(outcome)) throw new Error("unreachable");
    assert.ok(outcome.unknown.length > 0);
    assert.equal(outcome.complete, false);
    assert.notEqual(outcome.complete, true, "MU2: complete must not stay true with unknown[]");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MU3 validator accepts st other than INDEXED_UNKNOWN — RED on production", () => {
  const payload = {
    format: 1,
    createdAt: 1,
    files: [{
      p: "huge.bin",
      m: 1,
      s: MIB + 1,
      t: [],
      k: "l",
      u: { st: "SOMETHING_ELSE", r: "OVERSIZE", th: MIB },
    }],
  };
  assert.equal(validateStoredIndex(payload), null);
});

test("MU4 validator accepts u on a non-large node — RED on production", () => {
  const payload = {
    format: 1,
    createdAt: 1,
    files: [{
      p: "pic.bin",
      m: 1,
      s: 99,
      t: [],
      k: "b",
      u: { st: "INDEXED_UNKNOWN", r: "OVERSIZE", th: 1 },
    }],
  };
  assert.equal(validateStoredIndex(payload), null);
});

test("MU3/MU4 in-memory source mutants go RED; tracked sha256 unchanged", async () => {
  const contractPath = path.join(repoRoot, "src", "graph", "index-contract.ts");
  const before = sha256Hex(await fs.readFile(contractPath));
  const mutantDir = await scratch();
  try {
    const src = await fs.readFile(contractPath, "utf8");
    const mu3 = src.replace(
      'raw.st !== "INDEXED_UNKNOWN"',
      'false /* MU3 accept other st */',
    );
    assert.notEqual(mu3, src, "MU3 replacement must hit");
    const mu3File = path.join(mutantDir, "index-contract-mu3.ts");
    const mu3Runner = path.join(mutantDir, "run-mu3.ts");
    await fs.writeFile(mu3File, mu3);
    await fs.writeFile(mu3Runner, `import { validateStoredIndex } from ${JSON.stringify(pathToFileURL(mu3File).href)};
const MIB = 1024*1024;
const got = validateStoredIndex({
  format: 1, createdAt: 1,
  files: [{ p: "huge.bin", m: 1, s: MIB+1, t: [], k: "l",
    u: { st: "SOMETHING_ELSE", r: "OVERSIZE", th: MIB } }]
});
if (got === null) { console.error("MU3 still refused"); process.exit(2); }
process.exit(0);
`);
    const mu3run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", mu3Runner],
      { encoding: "utf8" },
    );
    assert.equal(mu3run.status, 0, `MU3 mutant must ACCEPT bad st so the kill test is live: ${mu3run.stderr}`);

    const mu4 = src.replace(
      'candidate.k !== "l"',
      'false /* MU4 accept u on non-l */',
    );
    assert.notEqual(mu4, src, "MU4 replacement must hit");
    const mu4File = path.join(mutantDir, "index-contract-mu4.ts");
    const mu4Runner = path.join(mutantDir, "run-mu4.ts");
    await fs.writeFile(mu4File, mu4);
    await fs.writeFile(mu4Runner, `import { validateStoredIndex } from ${JSON.stringify(pathToFileURL(mu4File).href)};
const got = validateStoredIndex({
  format: 1, createdAt: 1,
  files: [{ p: "pic.bin", m: 1, s: 99, t: [], k: "b",
    u: { st: "INDEXED_UNKNOWN", r: "OVERSIZE", th: 1 } }]
});
if (got === null) { console.error("MU4 still refused"); process.exit(2); }
process.exit(0);
`);
    const mu4run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", mu4Runner],
      { encoding: "utf8" },
    );
    assert.equal(mu4run.status, 0, `MU4 mutant must ACCEPT u on k:b so the kill test is live: ${mu4run.stderr}`);

    // Production still refuses (the GREEN of the kill tests above).
    assert.equal(validateStoredIndex({
      format: 1, createdAt: 1,
      files: [{ p: "huge.bin", m: 1, s: MIB + 1, t: [], k: "l",
        u: { st: "SOMETHING_ELSE", r: "OVERSIZE", th: MIB } }],
    }), null);
    assert.equal(validateStoredIndex({
      format: 1, createdAt: 1,
      files: [{ p: "pic.bin", m: 1, s: 99, t: [], k: "b",
        u: { st: "INDEXED_UNKNOWN", r: "OVERSIZE", th: 1 } }],
    }), null);
  } finally {
    assert.equal(sha256Hex(await fs.readFile(contractPath)), before);
    await fs.rm(mutantDir, { recursive: true, force: true });
  }
});
