// model.ts — the search graph.
//
// myco models a tree of files as a bipartite graph:
//
//     (file) --contains[count]--> (content-term)
//     (file) --named-by-------->  (name-term)
//
// A search is a *traversal* of that graph — look up the term node, walk its
// edges to the file nodes — instead of a linear scan of every byte on disk.
// That is the whole idea: grep re-reads the world on every query; myco reads a
// prebuilt graph and only ever touches the handful of files an edge points at.
//
// Implementation note: the "nodes" and "edges" are backed by plain Maps for
// O(1) lookup. The graph is the *model*; the Maps are the *representation*. The
// forward index (file -> term counts) is the persisted source of truth; the
// inverted index (term -> files) and the name index are derived from it in
// memory, which is what makes incremental re-indexing cheap.

export type FileId = number;

// A file node.
export interface FileRecord {
  id: FileId;
  path: string; // POSIX-relative to the index root, e.g. "src/cli.ts"
  mtimeMs: number; // change-detection inputs for incremental indexing
  size: number;
}

// term -> occurrence count within a single file (the forward edge weight).
export type TermCounts = Map<string, number>;

export class SearchGraph {
  // file node id -> record
  private readonly filesById = new Map<FileId, FileRecord>();
  // path -> file node id (so re-indexing can find an existing node)
  private readonly idByPath = new Map<string, FileId>();

  // FORWARD index (persisted): file -> its content-term counts.
  private readonly forward = new Map<FileId, TermCounts>();

  // INVERTED index (derived): content-term -> (file -> count). The edges.
  private readonly inverted = new Map<string, Map<FileId, number>>();

  // NAME index (derived): a term appearing in a file's path -> file ids.
  private readonly names = new Map<string, Set<FileId>>();

  private nextId: FileId = 0;

  // ---- construction -------------------------------------------------------

  // Insert or replace a file and its content-term counts, keeping every derived
  // index in sync. Returns the (possibly reused) node id.
  setFile(
    path: string,
    mtimeMs: number,
    size: number,
    counts: TermCounts,
  ): FileId {
    const existing = this.idByPath.get(path);
    if (existing !== undefined) this.removeFile(path);

    const id = this.nextId++;
    const record: FileRecord = { id, path, mtimeMs, size };
    this.filesById.set(id, record);
    this.idByPath.set(path, id);
    this.forward.set(id, counts);

    for (const [term, count] of counts) {
      let bucket = this.inverted.get(term);
      if (bucket === undefined) {
        bucket = new Map();
        this.inverted.set(term, bucket);
      }
      bucket.set(id, count);
    }
    this.indexName(record);
    return id;
  }

  // Remove a file node and every edge that touched it.
  removeFile(path: string): void {
    const id = this.idByPath.get(path);
    if (id === undefined) return;

    const counts = this.forward.get(id);
    if (counts) {
      for (const term of counts.keys()) {
        const bucket = this.inverted.get(term);
        if (!bucket) continue;
        bucket.delete(id);
        if (bucket.size === 0) this.inverted.delete(term);
      }
    }
    for (const [term, ids] of this.names) {
      if (ids.delete(id) && ids.size === 0) this.names.delete(term);
    }
    this.forward.delete(id);
    this.filesById.delete(id);
    this.idByPath.delete(path);
  }

  // Tokenize a file's path into the name index so `-f` filename search is a
  // graph lookup too, not a scan.
  private indexName(record: FileRecord): void {
    for (const term of nameTermsOf(record.path)) {
      let ids = this.names.get(term);
      if (ids === undefined) {
        ids = new Set();
        this.names.set(term, ids);
      }
      ids.add(record.id);
    }
  }

  // ---- lookups ------------------------------------------------------------

  file(id: FileId): FileRecord | undefined {
    return this.filesById.get(id);
  }

  fileByPath(path: string): FileRecord | undefined {
    const id = this.idByPath.get(path);
    return id === undefined ? undefined : this.filesById.get(id);
  }

  files(): IterableIterator<FileRecord> {
    return this.filesById.values();
  }

  fileCount(): number {
    return this.filesById.size;
  }

  termCount(): number {
    return this.inverted.size;
  }

  // The forward edges of a file node (its term counts) — used to persist.
  forwardOf(id: FileId): TermCounts | undefined {
    return this.forward.get(id);
  }

  // Files that contain an exact content term (the core traversal).
  filesWithTerm(term: string): Map<FileId, number> | undefined {
    return this.inverted.get(term);
  }

  // Every indexed content term — the dictionary, walked for prefix/substring
  // queries where an exact key won't do.
  terms(): IterableIterator<string> {
    return this.inverted.keys();
  }

  // Files whose path contains a name term.
  filesWithNameTerm(term: string): Set<FileId> | undefined {
    return this.names.get(term);
  }
}

// Split a POSIX path into lower-cased word terms: "src/CLI.ts" -> src, cli, ts.
// Exported because both the graph and filename queries need identical splitting.
export function nameTermsOf(path: string): string[] {
  const out: string[] = [];
  const re = /[\p{L}\p{N}_]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) out.push(m[0].toLowerCase());
  return out;
}
