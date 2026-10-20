---
id: 113
title: "Fix edit-protocol.md's stale cascade line and selector synonym"
status: review
priority: medium
milestone: null
parent: null
deps: []
labels: [docs]
created: 2026-10-20
---

## Context

`docs/edit-protocol.md` is the authoritative grammar, but it contradicts itself
and carries vocabulary the tracker was already cleaned of:

- §3 (line 88) says "The cascade is `path → symbol → matcher → selector`",
  while §1 and §2 spell it `select → match → pick → replace`.
- The synonym **selector** survives beside the settled **matcher** (with
  **viewer** / **editor**): §3, §9 and the child list (line 10, "#109 regex
  selector").

The code-level `anchor` rename (`src/anchor.ts`, `findAnchor`,
`parseAnchorFragment`) is `#112`; this issue is the prose vocabulary only.

## Goal

`docs/edit-protocol.md` names one cascade and one term throughout: `select →
match → pick → replace`, with **matcher** / **viewer** / **editor**.

## Acceptance criteria

- [ ] §3's cascade line reads `select → match → pick → replace`; no
      `path → symbol` remains in the file.
- [ ] the new-protocol concept is called **matcher** throughout; no "selector"
      synonym for it remains (§9 may keep the shipped JSON payload's own field
      names).
- [ ] wording only — no grammar or semantics change.
- [ ] `dm xref` stays at the 21-reference
      baseline.

## Verification

```
grep -n "path → symbol\|selector" docs/edit-protocol.md
dm xref
```

## Notes

- **matcher** replaced "anchor" per `#106`; "selector" was the older 4th-stage
  word now covered by `pick`.
- Pairs with the tracker-vocabulary cleanup.
