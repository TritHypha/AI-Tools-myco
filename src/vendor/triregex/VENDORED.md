# Vendored: TriRegex 0.5.0

- Source: D:\subprojects\TriRegex (github.com/TritHypha/AI-Tools-TriRegex), commit e93569f
- Files: `src/*.ts` copied verbatim (line endings normalised only). Zero runtime deps.
- Licence: Apache-2.0 (see LICENSE in this folder).
- Why vendored: myco runs TypeScript directly via Node strip-types and must not
  need a network install. TriRegex is used for streaming, non-backtracking
  matching of lines longer than MAX_REGEX_LINE_LEN; a TriRegex refusal is
  reported as a value (never treated as "no hit").
- To update: copy `src/*.ts` from a new TriRegex commit and update this file.

## Integrity manifest (checked by `scripts/check-vendor.mjs` and `test/vendor-triregex.test.ts`)

sha256 of each file's content with line endings normalised to LF, TriRegex commit
e93569f861c7cfa6f133ab9ac30e8ee537d5894a:
- sha256 87177c6179a3a5e6df5496d6a35c68c831918e33b8f76bf77c6d4782b18452a0 compile.ts
- sha256 2cc7b282b4261ef835f27ad6ef4213faa71f34b21a7deeaef02167b676531056 engine.ts
- sha256 d40674caf5a0dff30ba33fb69ed2838298bc9f423f69ff869dbc04087c2a5c43 find-all.ts
- sha256 019f13b541168091a91e59f8f53a63c4e40c0268094e00fd4e66a4a13a6ef834 index.ts
- sha256 70751c7f6ffb37c6ba889d26de23bb2d8acdee182a640dea1d8dfb956d8cfb25 parser.ts
- sha256 375ec5ba7ee0c6c2748825815bd312292ece457da4676b3af149415b9f760b00 types.ts

## Vendoring myco into another project

This folder is part of myco's source; myco does not run without it. When copying
myco into another project (e.g. `vendor/myco/`):

1. Copy the whole tracked tree from the main repo, e.g.
   `git -C <main myco> archive --format=tar --prefix=myco/ HEAD | tar -x -C <project>/vendor`
   (or `npm pack` -- the package now ships `src/` too). Do not hand-pick folders.
2. Make sure the receiving project has no ignore/exclude rule that matches
   `vendor/` inside the copy (add `!vendor/myco/**` to its `.gitignore` if it
   ignores `vendor/`), and that the copy step does not skip `vendor` dirs.
3. Run `node vendor/myco/scripts/check-vendor.mjs` -- it must print
   `vendored TriRegex OK`. Then refresh the project-local index.
