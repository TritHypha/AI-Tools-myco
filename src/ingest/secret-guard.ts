// secret-guard.ts - keep secret-looking tokens out of the stored index (MYCO-HARD-1 item 2).
//
// The on-disk index (.myco/index*.json) is a plain copy of every word in every file.
// If a working tree holds a credential (an API key pasted into a test, a token in a
// config file), a naive index makes a SECOND, long-lived copy of it in .myco, which is
// easy to back up, sync or attach by mistake. This module decides which terms are
// "secret-looking" so the indexer can WITHHOLD them from the term graph.
//
// Withholding never hides content from search: a file that had any term withheld is
// flagged the same way as a file with overlong terms (its record carries a non-zero
// omitted-term count), and search re-reads such files directly. So a search for the
// token still finds it in the file; it just never sits in the index. Every withhold is
// REPORTED (count + path, never the token itself) so the coverage stays visible.
//
// Rules are deliberately conservative so ordinary code identifiers and hashes stay
// searchable through the index:
//   1. KNOWN_PREFIX: well-known credential shapes (GitHub, AWS, Stripe, Slack-style
//      underscore forms, PEM private-key markers are handled by the caller's text).
//   2. HIGH_ENTROPY: long (>= SECRET_MIN_LENGTH), mixes letters and digits, is NOT
//      pure hex (commit SHAs and sha256 digests are public identifiers people search
//      for), and its per-character Shannon entropy is >= SECRET_MIN_ENTROPY_BITS.
// Terms arrive already case-folded by the tokenizer, so every rule is lower-case.
//
// Synthetic data only in tests; this module never logs or returns a token's value.

export type SecretReason = "KNOWN_PREFIX" | "HIGH_ENTROPY";

/** Shortest term the entropy rule looks at. */
export const SECRET_MIN_LENGTH = 32;
/** Bits of Shannon entropy per character at or above which a long term is withheld. */
export const SECRET_MIN_ENTROPY_BITS = 4.0;
/** Minimum digits a high-entropy candidate must carry (identifiers rarely have many). */
export const SECRET_MIN_DIGITS = 4;

// Credential shapes after case folding. Each is anchored to the whole term.
const KNOWN_PREFIXES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "github-token", re: /^gh[pousr]_[0-9a-z]{30,}$/ },
  { name: "github-fine-grained", re: /^github_pat_[0-9a-z_]{40,}$/ },
  { name: "aws-access-key-id", re: /^(akia|asia|aroa|aida)[0-9a-z]{16}$/ },
  { name: "stripe-key", re: /^(sk|rk|pk)_(live|test)_[0-9a-z]{16,}$/ },
  { name: "slack-token-body", re: /^xox[abposr]_[0-9a-z_]{20,}$/ },
  { name: "google-api-key", re: /^aiza[0-9a-z_]{35}$/ },
  { name: "npm-token", re: /^npm_[0-9a-z]{36}$/ },
  { name: "openai-style-key", re: /^sk_[0-9a-z_]{32,}$/ },
];

const PURE_HEX = /^[0-9a-f]+$/;
const HAS_LETTER = /\p{L}/u;
const DIGITS = /\p{N}/gu;

/** Shannon entropy of `s` in bits per character (0 for the empty string). */
export function shannonBitsPerChar(s: string): number {
  const chars = [...s];
  if (chars.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of chars) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / chars.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Name of the known credential shape `term` matches, or undefined. */
export function knownSecretShape(term: string): string | undefined {
  for (const k of KNOWN_PREFIXES) if (k.re.test(term)) return k.name;
  return undefined;
}

/**
 * Classify one case-folded term. Returns the reason it must be withheld from the
 * stored index, or null when it is safe to store.
 */
/**
 * True for snake_case-style names whose every `_` segment is all letters or all
 * digits or at most 6 chars (e.g. a test id ending in a date, or `k3`, `sha256`). Random tokens that happen to contain
 * `_` (base64url) mix letters and digits inside segments, so they are not exempt.
 * Known `prefix_` credential shapes are caught earlier by knownSecretShape.
 */
export function isSegmentedIdentifier(term: string): boolean {
  if (!term.includes("_")) return false;
  const segs = term.split("_").filter((x) => x !== "");
  if (segs.length < 2) return false;
  // Short mixed segments (k3, v4, sha256, utf8) are normal in names; long mixed
  // segments are what random tokens look like.
  return segs.every((x) => /^\p{L}+$/u.test(x) || /^\p{N}+$/u.test(x) || x.length <= 6);
}

export function classifySecretTerm(term: string): SecretReason | null {
  if (knownSecretShape(term) !== undefined) return "KNOWN_PREFIX";
  if (term.length < SECRET_MIN_LENGTH) return null;
  if (PURE_HEX.test(term)) return null; // hashes and SHAs stay searchable via the index
  if (!HAS_LETTER.test(term)) return null;
  if (isSegmentedIdentifier(term)) return null; // snake_case names, test ids, dated slugs
  const digits = term.match(DIGITS)?.length ?? 0;
  if (digits < SECRET_MIN_DIGITS) return null;
  return shannonBitsPerChar(term) >= SECRET_MIN_ENTROPY_BITS ? "HIGH_ENTROPY" : null;
}

/** Report filled in by the tokenizer: counts only, never token values. */
export interface SecretReport {
  withheldSecretTerms: number;
  knownPrefix: number;
  highEntropy: number;
}

export function emptySecretReport(): SecretReport {
  return { withheldSecretTerms: 0, knownPrefix: 0, highEntropy: 0 };
}
