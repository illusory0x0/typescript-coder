---
id: 68
title: "Protect the judge with a golden corpus and parse/print round-trip nets"
status: in-progress
priority: medium
milestone: null
parent: null
deps: []
labels: [benchmark]
created: 2026-10-19
---

## Context

Every USD claim in the ledger rests on the judge (tsc + tests + byte-equality
through the syntax gate), and the benchmark's own fixture parsers are
load-bearing (`benchmark/check.ts` validates the three frontends). A judge bug
moves every number silently. mri-project pins scorer verdicts with a
table-driven golden corpus and treats round-trip tests as ~0-dollar safety nets
(`mri-project/docs/spec/editor.md` "Testing Decisions";
`docs/spec/harness.md` "Trust").

Source survey: `/home/illu/repo/mri` absorption study (2026-10-19), insight 4.

## Goal

A table-driven golden corpus pins judge verdicts, and parse/print round-trip
tests pin the fixture frontends, protecting every benchmark number at zero API
cost.

## Acceptance criteria

- [ ] A golden table of (candidate source, expected typecheck / tests /
      byte-equality verdict) rows exists as a table-driven test; a judge change
      that flips a verdict fails the table.
- [ ] Parse/print round-trip tests for the three fixture frontends: canonical
      printed output re-parses to an equal AST (table-driven over the fixtures
      plus edge cases).
- [ ] Zero API calls; gates green.

## Verification

`bun test` (new tables included); `bun benchmark/check.ts`.

## Notes

- Source: mri-project `docs/spec/editor.md` §Testing Decisions;
  `docs/spec/harness.md` §Trust / §Testing Decisions.
- Related: the "Testing doctrine" section landing in `docs/spec.md` (this
  issue implements its first two nets).
- Priority defaulted to medium; no milestone.
