// walk.ts — enumerate candidate files under a root.
//
// The walk is metadata-only: it returns (path, mtime, size) and never reads
// content. The indexer decides what to actually read, so an incremental
// re-index can skip unchanged files entirely.
//
// Ignore handling is a *practical subset* of .gitignore, chosen to be
// predictable rather than bug-for-bug compatible (see DESIGN.md):
//   - a pattern with no "/"     -> basename glob, matched at any depth
//   - a pattern containing "/"  -> path prefix, anchored at the root
//   - a trailing "/"            -> directory-only
//   - a leading "!"             -> negate (un-ignore); last match wins
//   - "*" and "?" are globs; "**" and other advanced forms are NOT supported.

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface FileMeta {
  relPath: string; // POSIX, relative to root
  absPath: string;
  mtimeMs: number;
  size: number;
}

export interface WalkOptions {
  maxFileSize: number; // bytes; larger files are skipped
  useGitignore: boolean;
}

interface Rule {
  re: RegExp;
  dirOnly: boolean;
  negate: boolean;
  basename: boolean; // no-slash rule -> test the basename, else the full path
}

// Directories we never descend into, regardless of ignore files.
const ALWAYS_SKIP = new Set([".git", ".myco"]);

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function parseIgnore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    let body = line;
    const negate = body.startsWith("!");
    if (negate) body = body.slice(1);
    const dirOnly = body.endsWith("/");
    if (dirOnly) body = body.slice(0, -1);
    if (body.startsWith("/")) body = body.slice(1);
    if (body === "") continue;
    const basename = !body.includes("/");
    rules.push({ re: globToRegExp(body), dirOnly, negate, basename });
  }
  return rules;
}

async function readIfPresent(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function loadRules(root: string, useGitignore: boolean): Promise<Rule[]> {
  let text = await readIfPresent(path.join(root, ".mycoignore"));
  if (useGitignore) {
    text += "\n" + (await readIfPresent(path.join(root, ".gitignore")));
  }
  return parseIgnore(text);
}

// Returns true when `relPath` (a POSIX path) should be ignored. `isDir` lets
// directory-only rules apply, and lets a matched directory prune the descent.
function isIgnored(rules: Rule[], relPath: string, isDir: boolean): boolean {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const target = r.basename ? base : relPath;
    if (r.re.test(target)) ignored = !r.negate;
  }
  return ignored;
}

// Walk `root` breadth-unspecified, yielding every file that survives the ignore
// rules and the size cap. Symlinks are not followed (avoids cycles and escapes).
export async function walk(
  root: string,
  opts: WalkOptions,
  skippedLarge?: string[], // out: paths skipped for exceeding maxFileSize — reported, never silent
): Promise<FileMeta[]> {
  const rules = await loadRules(root, opts.useGitignore);
  const out: FileMeta[] = [];

  async function recur(absDir: string, relDir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than crash the whole index
    }
    for (const ent of entries) {
      const rel = relDir === "" ? ent.name : `${relDir}/${ent.name}`;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ALWAYS_SKIP.has(ent.name)) continue;
        if (isIgnored(rules, rel, true)) continue;
        await recur(path.join(absDir, ent.name), rel);
      } else if (ent.isFile()) {
        if (isIgnored(rules, rel, false)) continue;
        let st: import("node:fs").Stats;
        try {
          st = await fs.stat(path.join(absDir, ent.name));
        } catch {
          continue;
        }
        if (st.size > opts.maxFileSize) {
          skippedLarge?.push(rel); // a bounded coverage cap must be visible, not silent
          continue;
        }
        out.push({
          relPath: rel,
          absPath: path.join(absDir, ent.name),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    }
  }

  await recur(root, "");
  return out;
}
