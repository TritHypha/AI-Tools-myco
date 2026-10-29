import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { destinations, scanLinks, startLinkMonitor, DEFAULT_LIMITS } from '../src/links.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  const base = await fs.mkdtemp(path.join(here, '.links-'));
  const root = path.join(base, 'docs'); await fs.mkdir(root);
  return { base, root, snapshot: path.join(base, 'snapshot.json') };
}
async function until(snapshot: string, predicate: (s: any) => boolean, timeout = 5000): Promise<any> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const s = JSON.parse(await fs.readFile(snapshot, 'utf8')); if (predicate(s)) return s; } catch {}
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail(`snapshot did not reach expected state: ${await fs.readFile(snapshot, 'utf8').catch(() => 'absent')}`);
}

test('bounded grammar preserves spaces, nested parentheses, Windows Temp and rejects malformed targets', () => {
  assert.deepEqual(destinations('[x](<folder with spaces/a.md>)').targets, ['folder with spaces/a.md']);
  assert.deepEqual(destinations('[x](foo(bar).md)').targets, ['foo(bar).md']);
  assert.equal(destinations('[x](unclosed').malformed, true);
  assert.equal(destinations('a'.repeat(16385)).malformed, true);
  assert.deepEqual(destinations('`C:\\Users\\fixture\\AppData\\Local\\Temp\\some file.txt`').targets,
    ['C:\\Users\\fixture\\AppData\\Local\\Temp\\some file.txt']);
});

test('actual monitor observes add, repair, delete, rename, new directories and shutdown', async () => {
  const f = await fixture(); let m: Awaited<ReturnType<typeof startLinkMonitor>> | undefined;
  try {
    m = await startLinkMonitor(f.root, f.snapshot, { intervalMs: 200, debounceMs: 20 });
    await until(f.snapshot, s => s.status === 'CLEAN');
    await fs.writeFile(path.join(f.root, 'notes.md'), '[evidence](receipt.txt)');
    await until(f.snapshot, s => s.status === 'FINDINGS' && s.findings.some((x: any) => x.kind === 'BROKEN'));
    await fs.writeFile(path.join(f.root, 'receipt.txt'), 'controlled fixture');
    await until(f.snapshot, s => s.status === 'CLEAN');
    await fs.rename(path.join(f.root, 'receipt.txt'), path.join(f.root, 'renamed.txt'));
    await until(f.snapshot, s => s.status === 'FINDINGS');
    await fs.writeFile(path.join(f.root, 'notes.md'), '[evidence](renamed.txt)');
    await until(f.snapshot, s => s.status === 'CLEAN');
    await fs.unlink(path.join(f.root, 'renamed.txt'));
    await until(f.snapshot, s => s.status === 'FINDINGS');
    await fs.unlink(path.join(f.root, 'notes.md'));
    await until(f.snapshot, s => s.status === 'CLEAN');
    await fs.mkdir(path.join(f.root, 'new'));
    await fs.writeFile(path.join(f.root, 'new', 'notes.md'), '[x](gone.txt)');
    await until(f.snapshot, s => s.status === 'FINDINGS' && s.findings[0].source.includes('new'));
    await m.stop();
    await until(f.snapshot, s => s.status === 'INCOMPLETE' && !s.running && s.issues.includes('STOPPED'));
    assert.equal(await fs.stat(f.snapshot + '.lock').catch(() => null), null);
  } finally { await m?.stop(); await fs.rm(f.base, { recursive: true, force: true }); }
});

test('lost notifications reconcile from contents, overflow is explicitly published, restart is fresh', async () => {
  const f = await fixture(); let m: Awaited<ReturnType<typeof startLinkMonitor>> | undefined;
  try {
    // Notifications deliberately disabled: direct proof of the fallback path.
    m = await startLinkMonitor(f.root, f.snapshot, { intervalMs: 300, debounceMs: 200, maxQueue: 2 }, false);
    const first = await until(f.snapshot, s => s.status === 'CLEAN');
    await fs.writeFile(path.join(f.root, 'notes.md'), '[x](absent.txt)');
    await until(f.snapshot, s => s.status === 'FINDINGS');
    m.signal('a'); m.signal('b'); m.signal('c');
    // Overflow invalidates this entire reconciliation. The next successful
    // cycle may recover, so inspect the actual publication before that cycle.
    const oldScan = m.reconcile();
    await until(f.snapshot, s => s.status === 'INCOMPLETE' && s.issues.includes('EVENT_OVERFLOW'));
    await oldScan;
    await m.stop();
    m = await startLinkMonitor(f.root, f.snapshot, { intervalMs: 100 }, false);
    await until(f.snapshot, s => s.status === 'FINDINGS' && s.session !== first.session);
  } finally { await m?.stop(); await fs.rm(f.base, { recursive: true, force: true }); }
});

test('unavailable roots, parser errors, exclusions and budgets never become CLEAN', async () => {
  const f = await fixture(); let m: Awaited<ReturnType<typeof startLinkMonitor>> | undefined;
  try {
    await fs.writeFile(path.join(f.root, 'notes.md'), '[bad](%zz)\n[excluded](node_modules/a.txt)\n[bad](unterminated');
    m = await startLinkMonitor(f.root, f.snapshot, { intervalMs: 100 }, false);
    const s = await until(f.snapshot, s => s.status === 'INCOMPLETE');
    assert(s.findings.some((x: any) => x.kind === 'UNPARSEABLE'));
    assert(s.findings.some((x: any) => x.kind === 'EXCLUDED'));
    await fs.rm(f.root, { recursive: true });
    await until(f.snapshot, s => s.status === 'INCOMPLETE' && s.issues.some((x: string) => x.startsWith('ROOT_UNAVAILABLE')));
    await fs.mkdir(f.root);
    await fs.writeFile(path.join(f.root, 'large.md'), 'abcdefgh');
    const capped = await scanLinks(f.root, { ...DEFAULT_LIMITS, maxFileBytes: 2 });
    assert(capped.issues.some(x => x.startsWith('FILE_SIZE')));
    await fs.writeFile(path.join(f.root, 'bad.md'), Buffer.from([0xff, 0xfe]));
    assert((await scanLinks(f.root)).issues.some(x => x.startsWith('SOURCE_READ')));
  } finally { await m?.stop(); await fs.rm(f.base, { recursive: true, force: true }); }
});

test('Windows Temp path is identified; missing target is broken only on a compatible host', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'notes.md'), '`C:\\Users\\myco-controlled-fixture\\AppData\\Local\\Temp\\absent.txt`');
    const s = await scanLinks(f.root);
    assert(s.findings.some(x => x.temp && x.kind === (process.platform === 'win32' ? 'EXCLUDED' : 'UNAVAILABLE')));
    await fs.mkdir(path.join(f.root, 'Temp'));
    await fs.writeFile(path.join(f.root, 'Temp', 'exists.txt'), 'synthetic');
    await fs.writeFile(path.join(f.root, 'notes.md'), '[fragile](Temp/exists.txt)');
    assert((await scanLinks(f.root)).findings.some(x => x.kind === 'TEMP_REFERENCE'));
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('snapshot cannot overwrite a monitored document or be shared by concurrent writers', async () => {
  const f = await fixture(); let m: Awaited<ReturnType<typeof startLinkMonitor>> | undefined;
  try {
    await assert.rejects(startLinkMonitor(f.root, path.join(f.root, 'notes.md')), /outside/);
    m = await startLinkMonitor(f.root, f.snapshot);
    await assert.rejects(startLinkMonitor(f.root, f.snapshot), /EEXIST/);
    await assert.rejects(startLinkMonitor(f.root, f.snapshot, { maxQueue: 0 }), /invalid/);
  } finally { await m?.stop(); await fs.rm(f.base, { recursive: true, force: true }); }
});

test('existing encoded/space/parenthesis paths and reference definitions do not become false broken links', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'some file(1).txt'), 'synthetic');
    await fs.writeFile(path.join(f.root, 'notes.md'), [
      '[one](some%20file%281%29.txt#heading)',
      '[two](<some file(1).txt> "title")',
      `[three](${pathToFileURL(path.join(f.root, 'some file(1).txt')).href})`,
      '[four][known]', '[known]: <some file(1).txt>',
      '[outside](https://example.invalid/not-checked)',
    ].join('\n'));
    let s = await scanLinks(f.root);
    assert.deepEqual(s.findings, []); assert.deepEqual(s.issues, []);
    await fs.appendFile(path.join(f.root, 'notes.md'), '\n[five][undefined]');
    s = await scanLinks(f.root);
    assert(s.findings.some(x => x.kind === 'UNPARSEABLE'));
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('events during a blocked scan cause exactly one prompt follow-up without periodic reconciliation', async t => {
  const f = await fixture(); let m: Awaited<ReturnType<typeof startLinkMonitor>> | undefined;
  let release = deferred();
  try {
    const target = path.join(f.root, 'receipt.bin');
    await fs.writeFile(target, 'synthetic');
    await fs.writeFile(path.join(f.root, 'notes.md'), '[x](receipt.bin)');
    m = await startLinkMonitor(f.root, f.snapshot, { intervalMs: 600000, debounceMs: 10 }, false);
    const lstat = fs.lstat.bind(fs);
    const timeout = setTimeout;
    let entered = deferred(), debounceFired = deferred(), blockNext = false, targetChecks = 0;
    t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) !== target) return lstat(...args);
      targetChecks++;
      // Capture the real pre-mutation result, then hold this specific I/O step.
      const outcome = await lstat(...args).then(value => ({ value }), error => ({ error }));
      if (blockNext) { blockNext = false; entered.resolve(); await release.promise; }
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    });
    t.mock.method(globalThis, 'setTimeout', (callback: (...args: any[]) => void, delay?: number, ...args: any[]) =>
      timeout(() => { callback(...args); if (delay === 10) debounceFired.resolve(); }, delay));
    for (const expected of ['FINDINGS', 'CLEAN']) {
      entered = deferred(); release = deferred(); debounceFired = deferred(); blockNext = true;
      const previous = JSON.parse(await fs.readFile(f.snapshot, 'utf8'));
      const checksBefore = targetChecks;
      const scan = m.reconcile();
      await entered.promise;
      if (expected === 'FINDINGS') await fs.unlink(target); else await fs.writeFile(target, 'restored');
      for (let i = 0; i < 20; i++) m.signal(target);
      // Prove the debounce ran while reconcile was still in flight.
      await debounceFired.promise;
      release.resolve(); await scan;
      await until(f.snapshot, s => s.sequence > previous.sequence && s.status === expected, 2000);
      assert.equal(targetChecks, checksBefore + 2, 'one stale scan plus exactly one coalesced follow-up');
    }
    // A pending follow-up must not restart a stopped monitor.
    entered = deferred(); release = deferred(); debounceFired = deferred(); blockNext = true;
    const checksBefore = targetChecks;
    const scan = m.reconcile(); await entered.promise;
    m.signal(target); await debounceFired.promise;
    const stopping = m.stop(); release.resolve(); await scan; await stopping;
    assert.equal(targetChecks, checksBefore + 1);
    assert.equal(JSON.parse(await fs.readFile(f.snapshot, 'utf8')).running, false);
  } finally {
    release.resolve(); t.mock.restoreAll();
    try { await m?.stop(); } finally { await fs.rm(f.base, { recursive: true, force: true }); }
  }
});

test('source reads allocate stat size plus one; growth, shrinkage and byte caps stay incomplete', async t => {
  const f = await fixture();
  try {
    const source = path.join(f.root, 'notes.md');
    const open = fs.open.bind(fs), stat = fs.stat.bind(fs);
    const allocations: number[] = [];
    let mutation: 'none' | 'grow-before' | 'grow-after' | 'shrink' = 'none';
    let pinnedMtime = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) !== source) return handle;
      const read = handle.read.bind(handle), handleStat = handle.stat.bind(handle);
      pinnedMtime = (await handleStat()).mtimeMs;
      t.mock.method(handle, 'stat', async () => {
        const s = await handleStat(); s.mtimeMs = pinnedMtime; return s;
      });
      t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
        allocations.push(buffer.length);
        if (mutation === 'grow-before') await fs.appendFile(source, 'x'.repeat(100));
        if (mutation === 'shrink') await fs.truncate(source, 1);
        const result = await read(buffer, offset, length, position);
        if (mutation === 'grow-after') await fs.appendFile(source, 'x'.repeat(100));
        return result;
      });
      return handle;
    });
    t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
      const s = await stat(...args);
      if (String(args[0]) === source) s.mtimeMs = pinnedMtime;
      return s;
    });
    for (const size of [0, 3, 8]) {
      await fs.writeFile(source, 'a'.repeat(size));
      const s = await scanLinks(f.root, { ...DEFAULT_LIMITS, maxFileBytes: 8 });
      assert.deepEqual(s.issues, []);
      assert.equal(allocations.at(-1), size + 1);
    }
    for (const change of ['grow-before', 'grow-after', 'shrink'] as const) {
      mutation = change; await fs.writeFile(source, 'abc');
      const s = await scanLinks(f.root, { ...DEFAULT_LIMITS, maxFileBytes: 8 });
      assert.equal(allocations.at(-1), 4);
      assert(s.issues.some(x => x.startsWith('SOURCE_CHANGED')), change);
    }
    mutation = 'none'; await fs.writeFile(source, 'abcdefgh');
    const capped = await scanLinks(f.root, { ...DEFAULT_LIMITS, maxTotalBytes: 2 });
    assert.equal(allocations.at(-1), 3, 'remaining total-byte budget plus probe');
    assert(capped.issues.includes('BYTE_LIMIT'));
    const before = allocations.length;
    assert((await scanLinks(f.root, { ...DEFAULT_LIMITS, maxFileBytes: 2 })).issues.some(x => x.startsWith('FILE_SIZE_OR_TYPE')));
    assert.equal(allocations.length, before, 'oversized source is rejected before allocating its read buffer');
  } finally { t.mock.restoreAll(); await fs.rm(f.base, { recursive: true, force: true }); }
});

test('outside-root references are excluded without probing target existence', async t => {
  const f = await fixture();
  try {
    const target = path.join(f.base, 'external.bin');
    await fs.writeFile(path.join(f.root, 'notes.md'), '[external](../external.bin)');
    let outsideStatCalls = 0;
    const stat = fs.stat.bind(fs);
    t.mock.method(fs, 'stat', async (...args: Parameters<typeof fs.stat>) => {
      if (path.resolve(String(args[0])) === target) outsideStatCalls++;
      return stat(...args);
    });
    const absent = await scanLinks(f.root);
    await fs.writeFile(target, 'synthetic');
    const present = await scanLinks(f.root);

    assert.deepEqual(absent.findings.map(x => x.kind), ['EXCLUDED']);
    assert.deepEqual(present.findings.map(x => x.kind), ['EXCLUDED']);
    assert.deepEqual(absent.issues, []);
    assert.deepEqual(present.issues, []);
    assert(!present.directories.includes(f.base), 'outside parents are never traversed');
    assert.equal(outsideStatCalls, 0, 'outside target metadata is never queried');
  } finally { t.mock.restoreAll(); await fs.rm(f.base, { recursive: true, force: true }); }
});
