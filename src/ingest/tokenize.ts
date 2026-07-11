// tokenize.ts — turn a file's text into normalized term counts.
//
// This is the ONLY place content becomes terms during indexing. It is kept
// tiny and dependency-free: split on Unicode word runs, fold case, count. The
// same WORD_CHAR class is reused by the query matcher so "what counts as a
// word" is defined exactly once (see util/normalize.ts).

import type { TermCounts } from "../graph/model.ts";
import { foldCase, wordScanner } from "../util/normalize.ts";

// Count every word-term in `text`. Case-folded so the index is case-insensitive
// by construction; the original text is re-read at query time when we need to
// show a line or honor a case-sensitive search, so nothing is lost here.
export function countTerms(text: string): TermCounts {
  const counts: TermCounts = new Map();
  const re = wordScanner();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const term = foldCase(m[0]);
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}
