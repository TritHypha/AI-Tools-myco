// Independent link evidence. This module never reads or writes the search graph.
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { terminalData } from './util/terminal.ts';

export const LINK_SCHEMA = 'myco.links.v1';
export const DEFAULT_LIMITS = {
  intervalMs: 60000, debounceMs: 200, maxQueue: 256, maxDirs: 2048,
  maxEntries: 100000, maxFiles: 10000, maxFileBytes: 1048576,
  maxTotalBytes: 67108864, maxReferences: 100000, maxFindings: 5000,
  scanBudgetMs: 30000,
};
export type Limits = typeof DEFAULT_LIMITS;
export type Finding = { source: string; line: number; target: string;
  kind: 'BROKEN' | 'TEMP_REFERENCE' | 'UNAVAILABLE' | 'EXCLUDED' | 'UNPARSEABLE'; temp: boolean };
export type Scan = { startedAt: string; completedAt: string; findings: Finding[];
  issues: string[]; files: number; references: number; directories: string[] };
const excluded = new Set(['.git', 'node_modules', '.myco', 'dist', 'build']);
const extensions = new Set(['.md', '.markdown', '.txt']);
const errorCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? 'IO_ERROR';

// Deliberately a bounded local-path grammar, not a complete Markdown renderer.
export function destinations(line: string): { targets: string[]; malformed: boolean } {
  if (line.length > 16384) return { targets: [], malformed: true };
  const targets = new Set<string>();
  const ranges: [number, number][] = [];
  let malformed = false;
  const add = (raw: string) => {
    raw = raw.trim();
    const angle = /^<([^<>]+)>\s*(?:["'][^"']*["'])?$/.exec(raw);
    const bare = /^(\S+?)(?:\s+["'][^"']*["'])?$/.exec(raw);
    const value = angle?.[1] ?? bare?.[1];
    if (!value || value.length > 4096) malformed = true;
    else targets.add(value.replace(/\\([() ])/g, '$1'));
  };
  for (const m of line.matchAll(/\]\(/g)) {
    const start = m.index! + 2;
    let end = start, depth = 1, angle = false;
    for (; end < line.length; end++) {
      const c = line[end];
      if (c === '\\' && /[()]/.test(line[end + 1] ?? '')) { end++; continue; }
      if (c === '<') angle = true;
      if (c === '>') angle = false;
      if (!angle && c === '(') depth++;
      if (!angle && c === ')' && --depth === 0) break;
    }
    if (depth) malformed = true;
    else { add(line.slice(start, end)); ranges.push([m.index!, end + 1]); }
  }
  const definition = /^\s{0,3}\[[^\]]+\]:\s*(.*)$/.exec(line);
  if (definition) { add(definition[1]!); ranges.push([0, line.length]); }
  // Quoted absolute Windows paths can include spaces. Also inspect prose/code,
  // because a Temp dependency in a runbook is relevant even outside a link.
  const quoted = /[`"<]((?:[A-Za-z]:[\\/]|file:\/\/\/)[^`"<>\r\n]+)[`">]/g;
  for (const m of line.matchAll(quoted)) {
    if (!ranges.some(([a, b]) => m.index! >= a && m.index! < b)) {
      targets.add(m[1]!); ranges.push([m.index!, m.index! + m[0].length]);
    }
  }
  for (const m of line.matchAll(/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|file:\/\/\/)[^\s`"<>|)\]]+/g)) {
    if (!ranges.some(([a, b]) => m.index! >= a && m.index! < b)) targets.add(m[0]);
  }
  return { targets: [...targets], malformed };
}

export async function scanLinks(root: string, limits: Limits = DEFAULT_LIMITS): Promise<Scan> {
  root = path.resolve(root);
  const start = Date.now();
  const result: Scan = { startedAt: new Date(start).toISOString(), completedAt: '',
    findings: [], issues: [], files: 0, references: 0, directories: [] };
  const issue = (s: string) => { if (result.issues.length < 100 && !result.issues.includes(s)) result.issues.push(s); };
  let entries = 0, bytes = 0, halted = false;
  const budget = () => {
    if (Date.now() - start > limits.scanBudgetMs) { issue('SCAN_BUDGET'); halted = true; }
    return !halted;
  };
  const finding = (f: Finding) => {
    if (result.findings.length >= limits.maxFindings) { issue('FINDING_LIMIT'); halted = true; }
    else result.findings.push(f);
  };
  async function check(source: string, line: number, raw: string) {
    if (++result.references > limits.maxReferences) { issue('REFERENCE_LIMIT'); halted = true; return; }
    let target = raw;
    const temp = /(?:^|[\\/])(?:temp|tmp)(?:[\\/]|$)/i.test(raw);
    const report = (kind: Finding['kind']) => finding({ source, line, target: raw, kind, temp });
    if (raw.length > 4096 || raw.includes('\0')) { report('UNPARSEABLE'); return; }
    if (/^(?:https?:|mailto:|data:)/i.test(raw) || raw.startsWith('#')) return;
    try {
      if (/^file:/i.test(target)) target = fileURLToPath(target);
      else if (/^[A-Za-z]:[\\/]/.test(target)) {
        if (process.platform !== 'win32') { report('UNAVAILABLE'); return; }
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) { report('EXCLUDED'); return; }
      else target = decodeURIComponent(target.split(/[?#]/, 1)[0]!);
    } catch { report('UNPARSEABLE'); return; }
    if (/^(?:\\\\|\/\/)/.test(target)) { report('EXCLUDED'); return; }
    if (!target || /[\r\n\0]/.test(target)) { report('UNPARSEABLE'); return; }
    if (target.split(/[\\/]/).some(p => excluded.has(p))) { report('EXCLUDED'); return; }
    const resolved = path.resolve(path.dirname(path.join(root, source)), target);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      report('EXCLUDED');
      return;
    }
    let current = root;
    const parts = relative === '' ? [] : relative.split(path.sep);
    for (const part of parts.length ? parts : ['.']) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) { report('EXCLUDED'); return; }
      } catch (e) {
        report(['ENOENT', 'ENOTDIR'].includes(errorCode(e)) ? 'BROKEN' : 'UNAVAILABLE');
        return;
      }
    }
    if (temp) report('TEMP_REFERENCE');
  }
  async function visit(dir: string) {
    if (!budget()) return;
    if (result.directories.length >= limits.maxDirs) { issue('DIRECTORY_LIMIT'); halted = true; return; }
    result.directories.push(dir);
    try {
      // opendir bounds allocation even when a directory contains millions of entries.
      const stream = await fs.opendir(dir);
      for await (const ent of stream) {
        if (!budget()) break;
        if (++entries > limits.maxEntries) { issue('ENTRY_LIMIT'); halted = true; break; }
        if (excluded.has(ent.name)) continue;
        const full = path.join(dir, ent.name), rel = path.relative(root, full);
        if (ent.isSymbolicLink()) { issue(`SYMLINK_SOURCE:${rel}`); continue; }
        if (ent.isDirectory()) { await visit(full); continue; }
        if (!extensions.has(path.extname(ent.name).toLowerCase())) continue;
        if (!ent.isFile()) { issue(`NONREGULAR_SOURCE:${rel}`); continue; }
        if (++result.files > limits.maxFiles) { issue('FILE_LIMIT'); halted = true; break; }
        try {
          const handle = await fs.open(full, 'r');
          let content: string;
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.size > limits.maxFileBytes) { issue(`FILE_SIZE_OR_TYPE:${rel}`); continue; }
            // One bounded growth-probe byte, without allocating the per-file cap
            // for every tiny document. A short/changed read is never complete.
            const buffer = Buffer.alloc(Math.min(before.size, limits.maxFileBytes, Math.max(0, limits.maxTotalBytes - bytes)) + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            bytes += bytesRead;
            if (bytesRead > limits.maxFileBytes || bytes > limits.maxTotalBytes) { issue('BYTE_LIMIT'); halted = true; break; }
            content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
            const after = await handle.stat();
            const current = await fs.stat(full);
            if (before.mtimeMs !== after.mtimeMs || before.size !== bytesRead || before.size !== after.size || after.size !== current.size || after.ino !== current.ino || after.mtimeMs !== current.mtimeMs) issue(`SOURCE_CHANGED:${rel}`);
          } finally { await handle.close(); }
          const lines = content.split(/\r?\n/);
          const definitions = new Set(lines.flatMap(line => {
            const m = /^\s{0,3}\[([^\]]+)\]:/.exec(line);
            return m ? [m[1]!.trim().toLowerCase()] : [];
          }));
          for (let i = 0; i < lines.length && budget(); i++) {
            const parsed = destinations(lines[i]!);
            for (const ref of (lines[i]!.length <= 16384 ? lines[i]! : '').matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
              if (!definitions.has((ref[2] || ref[1])!.trim().toLowerCase())) parsed.malformed = true;
            }
            if (parsed.malformed) finding({ source: rel, line: i + 1, target: '', kind: 'UNPARSEABLE', temp: false });
            for (const target of parsed.targets) { if (!budget()) break; await check(rel, i + 1, target); }
          }
        } catch (e) { issue(`SOURCE_READ:${rel}:${errorCode(e)}`); }
      }
    } catch (e) { issue(`DIRECTORY_READ:${path.relative(root, dir)}:${errorCode(e)}`); }
  }
  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) issue('SYMLINK_ROOT');
    else await visit(root);
  } catch (e) { issue(`ROOT_UNAVAILABLE:${errorCode(e)}`); }
  budget();
  result.completedAt = new Date().toISOString();
  return result;
}

export type Snapshot = {
  schema: typeof LINK_SCHEMA; producer: 'myco'; session: string; sequence: number; root: string;
  publishedAt: string; startedAt: string; completedAt: string; running: boolean;
  status: 'CLEAN' | 'FINDINGS' | 'INCOMPLETE'; issues: string[]; findings: Finding[];
  files: number; references: number; limits: Limits;
  scope: { extensions: string[]; excludedDirectories: string[]; grammar: string };
};
export async function startLinkMonitor(rootInput: string, snapshotInput: string,
  overrides: Partial<Limits> = {}, notifications = true) {
  const root = path.resolve(rootInput), snapshotPath = path.resolve(snapshotInput);
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key as keyof Limits] * 10)
      throw new Error(`invalid limit ${key}`);
  }
  const rel = path.relative(root, snapshotPath);
  if (!rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) throw new Error('snapshot must be outside monitored root');
  const physicalRoot = await fs.realpath(root).catch(() => root);
  const physicalSnapshot = path.join(await fs.realpath(path.dirname(snapshotPath)), path.basename(snapshotPath));
  const physicalRel = path.relative(physicalRoot, physicalSnapshot);
  if (!physicalRel.startsWith(`..${path.sep}`) && !path.isAbsolute(physicalRel)) throw new Error('snapshot must be physically outside monitored root');
  // An exclusive lease prevents two foreground writers from publishing the same file.
  // A crash leaves the lease for explicit operator removal after checking its PID.
  const lease = await fs.open(snapshotPath + '.lock', 'wx');
  try { await lease.writeFile(JSON.stringify({ pid: process.pid, root })); }
  catch (e) { await lease.close(); await fs.unlink(snapshotPath + '.lock'); throw e; }
  const session = randomUUID();
  let sequence = 0, generation = 0, stopped = false;
  let latest: Scan = { startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), findings: [], issues: ['STARTING'], files: 0, references: 0, directories: [] };
  const watchers = new Map<string, FSWatcher>(), queue = new Set<string>();
  let pendingIssues: string[] = [], timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const watchErrors = new Set<string>();
  let writes = Promise.resolve();
  const publish = (extra: string[] = [], running = true) => {
    const issues = [...new Set([...latest.issues, ...extra])];
    const incomplete = issues.length > 0 || latest.findings.some(f => ['UNAVAILABLE', 'EXCLUDED', 'UNPARSEABLE'].includes(f.kind));
    const snapshot: Snapshot = { schema: LINK_SCHEMA, producer: 'myco', session, sequence: ++sequence, root,
      publishedAt: new Date().toISOString(), startedAt: latest.startedAt, completedAt: latest.completedAt,
      running, status: incomplete ? 'INCOMPLETE' : latest.findings.length ? 'FINDINGS' : 'CLEAN',
      issues, findings: latest.findings, files: latest.files, references: latest.references, limits,
      scope: { extensions: [...extensions], excludedDirectories: [...excluded], grammar: 'local-paths-v1' } };
    writes = writes.then(async () => {
      const tmp = `${snapshotPath}.${session}.tmp`;
      try {
        let body = JSON.stringify(snapshot) + '\n';
        if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
          snapshot.status = 'INCOMPLETE'; snapshot.issues.push('SNAPSHOT_SIZE_LIMIT');
          snapshot.findings = []; body = JSON.stringify(snapshot) + '\n';
        }
        await fs.writeFile(tmp, body, { mode: 0o600 });
        // Windows readers/virus scanners can briefly hold the replacement target.
        // Retry only sharing-related errors; never unlink the last good snapshot.
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(tmp, snapshotPath); break; }
          catch (e) {
            if (attempt >= 49 || !['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(e))) throw e;
            await new Promise(r => setTimeout(r, 40));
          }
        }
      }
      finally { await fs.unlink(tmp).catch(() => {}); }
    });
    return writes;
  };
  const signal = (key: string, reason?: string) => {
    if (stopped) return;
    generation++;
    if (reason && pendingIssues.length < 100) pendingIssues.push(reason);
    if (!queue.has(key) && queue.size >= limits.maxQueue) { pendingIssues = ['EVENT_OVERFLOW']; queue.clear(); }
    queue.add(key);
    if (!timer) timer = setTimeout(() => { timer = undefined; void reconcile().catch(fail); }, limits.debounceMs);
  };
  let fatalError: unknown;
  function fail(e: unknown) { fatalError = e; void stop().catch(() => {}); }
  function reconcile(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    if (timer) { clearTimeout(timer); timer = undefined; }
    const version = generation;
    const cycleIssues = pendingIssues;
    queue.clear(); pendingIssues = [];
    let completed = false;
    inFlight = (async () => {
      await publish(['RECONCILING', ...cycleIssues]);
      latest = await scanLinks(root, limits);
      if (notifications && !stopped) {
        const dirs = new Set(latest.directories);
        for (const dir of watchErrors) if (!dirs.has(dir)) watchErrors.delete(dir);
        for (const [dir, w] of watchers) if (!dirs.has(dir)) { w.close(); watchers.delete(dir); watchErrors.delete(dir); }
        for (const dir of dirs) if (!watchers.has(dir)) {
          try {
            const w = watch(dir, (_event, filename) => signal(path.join(dir, String(filename ?? '*'))));
            w.on('error', () => { w.close(); watchers.delete(dir); watchErrors.add(dir); signal(dir, 'WATCH_ERROR'); });
            watchers.set(dir, w); watchErrors.delete(dir);
          } catch { watchErrors.add(dir); }
        }
      }
      await publish([...cycleIssues, ...(version !== generation ? ['EVENTS_DURING_SCAN'] : []), ...(watchErrors.size ? ['WATCH_UNAVAILABLE'] : [])]);
      completed = true;
    })().finally(() => {
      inFlight = undefined;
      // A debounce may already have fired and joined this promise. Retain the
      // generation debt independently of that timer, including publication I/O.
      if (completed && !stopped && version !== generation) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = undefined; void reconcile().catch(fail); }, 0);
      }
    });
    return inFlight;
  }
  const periodic = setInterval(() => { void reconcile().catch(fail); }, limits.intervalMs);
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true; clearInterval(periodic); if (timer) clearTimeout(timer);
    for (const w of watchers.values()) w.close(); watchers.clear();
    stopPromise = (async () => {
      try { await inFlight; await publish(['STOPPED'], false); }
      finally { for (const w of watchers.values()) w.close(); await lease.close(); await fs.unlink(snapshotPath + '.lock'); }
    })();
    return stopPromise;
  }
  try { await reconcile(); } catch (e) { await stop().catch(() => {}); throw e; }
  return { stop, reconcile, signal, get error() { return fatalError; } };
}

export async function linksCommand(argv: string[]): Promise<number> {
  const options: Record<string, { type: 'string' | 'boolean' }> = { snapshot: { type: 'string' }, help: { type: 'boolean' } };
  for (const key of Object.keys(DEFAULT_LIMITS)) options[key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())] = { type: 'string' };
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  if (values.help) {
    console.log('myco links watch <root> --snapshot <outside-root.json> [limits]\nForeground only; Ctrl+C stops. Markdown/text local paths only. Limits (positive integers):\n' +
      Object.entries(DEFAULT_LIMITS).map(([k, v]) => `  --${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())} ${v}`).join('\n'));
    return 0;
  }
  if (positionals.length !== 2 || positionals[0] !== 'watch' || typeof values.snapshot !== 'string') throw new Error('use links watch <root> --snapshot <outside-root.json> (or links --help)');
  const overrides: Partial<Limits> = {};
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value = values[key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())];
    if (value !== undefined) overrides[key] = Number(value);
  }
  let stopRequested = false;
  let monitor: Awaited<ReturnType<typeof startLinkMonitor>> | undefined;
  let finish: ((code?: number) => void) | undefined;
  const interrupt = () => { stopRequested = true; finish?.(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    monitor = await startLinkMonitor(positionals[1]!, values.snapshot, overrides);
    console.log(`Myco link monitor publishing to ${terminalData(path.resolve(values.snapshot))}; Ctrl+C to stop.`);
    return await new Promise<number>(resolve => {
      const poll = setInterval(() => { if (monitor!.error) { console.error(terminalData(String(monitor!.error))); finish!(2); } }, 200);
      finish = (code = 0) => {
        clearInterval(poll);
        void monitor!.stop().then(() => resolve(code), e => { console.error(terminalData(String(e))); resolve(2); });
      };
      if (stopRequested) finish();
    });
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
