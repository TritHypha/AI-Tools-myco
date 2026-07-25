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
//
// NESTED ignore files are honoured: descending into a directory that carries its
// own .gitignore / .mycoignore loads those rules SCOPED to that subtree (a rule
// from `sub/.gitignore` only matches paths under `sub/`). Before this, only the
// root ignore file was read, so a subproject's own build-output ignore (e.g. a
// Rust `dss-host/.gitignore` with `/target`) was silently violated and its
// cargo `target/` tree — thousands of build artefacts — got indexed, bloating
// the index and the incremental refresh (the 28k-file timeout, owner 2026-07-25).

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
  base: string; // relDir of the ignore file that declared this rule ("" = root); scopes it to that subtree
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

function parseIgnore(text: string, base: string): Rule[] {
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
    // A leading `**/` means "at any depth" — strip it so the remainder matches by
    // basename (git's very common `**/build/`, `**/.fungi-cache/`, `**/node_modules/`
    // idiom). This is the one `**` form worth honouring; deeper mid-path `**` stays
    // unsupported (documented) — but silently missing `**/x` was indexing build caches
    // a correct .gitignore already excluded (owner 2026-07-25, the .fungi-cache case).
    if (body.startsWith("**/")) body = body.slice(3);
    if (body === "") continue;
    const basename = !body.includes("/");
    rules.push({ re: globToRegExp(body), dirOnly, negate, basename, base });
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

// Load the ignore rules declared IN a single directory (`.mycoignore` + `.gitignore`),
// scoped to that directory's subtree via `relDir`. `fileNames` is the dir's own file
// listing, so we only read an ignore file that is actually present (no failing reads
// per directory). Returns [] when the directory carries none.
async function loadDirRules(
  absDir: string,
  relDir: string,
  useGitignore: boolean,
  fileNames: Set<string>,
): Promise<Rule[]> {
  let text = "";
  if (fileNames.has(".mycoignore")) {
    text += await readIfPresent(path.join(absDir, ".mycoignore"));
  }
  if (useGitignore && fileNames.has(".gitignore")) {
    text += "\n" + (await readIfPresent(path.join(absDir, ".gitignore")));
  }
  return text.trim() === "" ? [] : parseIgnore(text, relDir);
}

// Returns true when `relPath` (a POSIX path, relative to the walk root) should be
// ignored. `isDir` lets directory-only rules apply, and lets a matched directory
// prune the descent. A rule from a nested ignore file (`r.base !== ""`) only applies
// within its own subtree, and is tested against the path RELATIVE to that base.
function isIgnored(rules: Rule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    let sub = relPath;
    if (r.base !== "") {
      if (relPath !== r.base && !relPath.startsWith(r.base + "/")) continue;
      sub = relPath.slice(r.base.length + 1);
    }
    const target = r.basename ? sub.slice(sub.lastIndexOf("/") + 1) : sub;
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
  const out: FileMeta[] = [];

  async function recur(
    absDir: string,
    relDir: string,
    inherited: Rule[],
  ): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than crash the whole index
    }
    // Stack this directory's own ignore file(s) onto the inherited (ancestor) rules,
    // scoped to this subtree — so a subproject's build-output ignore is honoured.
    const fileNames = new Set(
      entries.filter((e) => e.isFile()).map((e) => e.name),
    );
    const local = await loadDirRules(absDir, relDir, opts.useGitignore, fileNames);
    const rules = local.length === 0 ? inherited : inherited.concat(local);

    for (const ent of entries) {
      const rel = relDir === "" ? ent.name : `${relDir}/${ent.name}`;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (ALWAYS_SKIP.has(ent.name)) continue;
        if (isIgnored(rules, rel, true)) continue;
        await recur(path.join(absDir, ent.name), rel, rules);
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

  await recur(root, "", []);
  return out;
}
