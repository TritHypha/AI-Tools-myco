# Vendored: TriRegex 0.5.0

- Source: D:\subprojects\TriRegex (github.com/TritHypha/AI-Tools-TriRegex), commit e93569f
- Files: `src/*.ts` copied verbatim (line endings normalised only). Zero runtime deps.
- Licence: Apache-2.0 (see LICENSE in this folder).
- Why vendored: myco runs TypeScript directly via Node strip-types and must not
  need a network install. TriRegex is used for streaming, non-backtracking
  matching of lines longer than MAX_REGEX_LINE_LEN; a TriRegex refusal is
  reported as a value (never treated as "no hit").
- To update: copy `src/*.ts` from a new TriRegex commit and update this file.
