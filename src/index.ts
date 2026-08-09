// index.ts — the myco library surface.
//
// Everything a programmatic consumer needs to build an index and query it,
// without touching the CLI. The CLI (cli.ts) is a thin layer over exactly this.

export { SearchGraph, nameTermsOf } from "./graph/model.ts";
export type { FileId, FileRecord, TermCounts, ContentSkip } from "./graph/model.ts";

export { loadGraph, saveGraph, INDEX_DIR, INDEX_FILE } from "./graph/store.ts";
export type { IndexMeta } from "./graph/store.ts";

export {
  buildIndex,
  DEFAULT_INDEX_OPTIONS,
} from "./ingest/indexer.ts";
export type { IndexOptions, IndexStats } from "./ingest/indexer.ts";

export { countTerms } from "./ingest/tokenize.ts";
export { walk } from "./ingest/walk.ts";
export type { FileMeta, WalkOptions } from "./ingest/walk.ts";

export { search, searchFile, isError, detectRegexIntent } from "./query/search.ts";
export type {
  MatchMode,
  Match,
  SearchOptions,
  SearchResult,
  SearchError,
  SearchOutcome,
} from "./query/search.ts";

// Scoping (`--in`). Exported because the CLI is meant to be a thin layer over this
// surface — a flag that exists only in cli.ts would make that claim false, and a
// programmatic consumer would have to re-implement the glob rules to match.
export { buildPathFilter, applyPathFilter } from "./query/path-filter.ts";
export type { PathFilter } from "./query/path-filter.ts";

export const VERSION = "0.2.2";
