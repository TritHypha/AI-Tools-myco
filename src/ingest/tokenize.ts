// tokenize.ts — turn a file's text into normalized term counts.
//
// This is the ONLY place content becomes terms during indexing. It is kept
// tiny and dependency-free: split on Unicode word runs, fold case, count. The
// same WORD_CHAR class is reused by the query matcher so "what counts as a
// word" is defined exactly once (see util/normalize.ts).

import type { TermCounts } from "../graph/model.ts";
import { MAX_INDEX_TERM_LENGTH } from "../graph/index-contract.ts";
import { foldCase, wordScanner } from "../util/normalize.ts";
import { classifySecretTerm } from "./secret-guard.ts";

export interface TokenizeReport {
  omittedOverlongTerms: number;
  /**
   * Secret-looking terms WITHHELD from the term graph (MYCO-HARD-1). Optional so
   * older callers keep compiling; when present, withholding is on. Counts only,
   * never the token itself.
   */
  withheldSecretTerms?: number;
  knownPrefix?: number;
  highEntropy?: number;
}

// Count every word-term in `text`. Case-folded so the index is case-insensitive
// by construction; the original text is re-read at query time when we need to
// show a line or honor a case-sensitive search, so nothing is lost here.
export function countTerms(text: string, report?: TokenizeReport): TermCounts {
  const counts: TermCounts = new Map();
  const re = wordScanner();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const term = foldCase(m[0]);
    if (term.length > MAX_INDEX_TERM_LENGTH) {
      if (report) report.omittedOverlongTerms += 1;
      continue;
    }
    if (report && report.withheldSecretTerms !== undefined) {
      const reason = classifySecretTerm(term);
      if (reason !== null) {
        report.withheldSecretTerms += 1;
        if (reason === "KNOWN_PREFIX") report.knownPrefix = (report.knownPrefix ?? 0) + 1;
        else report.highEntropy = (report.highEntropy ?? 0) + 1;
        continue; // never stored; the file is flagged for direct verification instead
      }
    }
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}
