// normalize.ts — text normalization shared by the indexer and the query engine.
//
// Everything that goes into the graph as a "term" is normalized the same way so
// that a search for `Cafe` finds `café`, `CAFE`, and `Café`. We deliberately do
// case folding (the owner's "ignore capitals") but NOT accent stripping — an
// accent changes the word, a capital does not.

// Fold a string to its case-insensitive comparison form.
// NFC first (so composed and decomposed accents compare equal), then lower-case.
export function foldCase(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

// The character class that makes up a "word" everywhere in myco: Unicode
// letters, Unicode digits, and underscore. Kept in one place so the tokenizer
// and the word-boundary matcher can never drift apart.
export const WORD_CHAR = "[\\p{L}\\p{N}_]";

// A global, Unicode-aware matcher for runs of word characters.
export function wordScanner(): RegExp {
  return new RegExp(`${WORD_CHAR}+`, "gu");
}

// True when the query contains at least one upper-case letter — the signal used
// by smart-case to decide whether a search should be case-sensitive.
export function hasUpper(s: string): boolean {
  return s !== s.toLowerCase();
}
