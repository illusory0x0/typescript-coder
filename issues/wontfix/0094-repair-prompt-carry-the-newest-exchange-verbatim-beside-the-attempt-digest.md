---
id: 94
title: "Repair prompt: carry the newest exchange verbatim beside the attempt digest"
status: wontfix
priority: low
milestone: null
parent: 91
deps: []
labels: [harness, agent-loop]
created: 2026-10-20
---

## Context

#64 absorption candidate 2. opencode2's compaction keeps the newest `keep`
tokens verbatim *beside* the summary and omits only the older part
(`packages/core/src/session/compaction.ts:704-744`,
`packages/core/src/session/runner/to-llm-message.ts:311-325`). tc's continuation
prompts carry only a one-line attempt digest, so the model re-derives the exact
last failure from a summary.

## Goal

Continuation/repair prompts render the **newest exchange's diagnostics verbatim**
(already capped by `DIAGNOSTICS_LIMIT = 4_000`) beside the attempt digest, so the
model sees the exact failure it is iterating on instead of only a cause count.

## Acceptance criteria

- [ ] The newest record's diagnostics tail is rendered beside the digest on
      continuation/repair prompts, within the existing cap.
- [ ] Unit tests cover the render (present/absent, capping).
- [ ] A live tc-side matrix shows non-regression (json 3/3, sexp 3/3,
      minilisp >=2/3; no worse tokens per success than the committed #75/#87
      state); rows in `benchmark/results/consumption.md`.
- [ ] Guards, caps, and the single-edit protocol unchanged.

## Verification

```
bun test
bunx tsc --noEmit
bun run benchmark/run.ts --all --side tc --reps 3 --json benchmark/results/<date>-tc-verbatim.json --replay-dir tmp/replays-<name>
bun benchmark/check.ts
```

Inspect a replay to confirm the newest diagnostics appear verbatim.

## Notes

- Parent: the #64 absorption umbrella.
- Related: #88 (show the model its own prior replies) was measured and reverted
  negative; this candidate is narrower — the newest diagnostics text, not the
  prior replies.
- Non-goals: widening the diagnostics cap; changing guards.
- Recon 2026-10-20: premise appears already satisfied. Continuation/repair prompts render the newest exchange's diagnostics verbatim in the `Diagnostics:` block, not merely a one-line digest: on a #52 continuation `diagnostics = combinedDiagnostics(iterationOpenedBy, lastDiagnostics)` (`src/loop.ts:4722`; helper at `:3776`), and `buildRetryPrompt`/`buildContinuationPrompt` inline it as a fenced block (`src/loop.ts:582` and `:606`). Confirmed in the live replay `tmp/replays-93/minilisp-tc-rep2.json` (call 5, the round-2 continuation): the full `stage: tsc` + `stage: matcher` text appears verbatim in the Diagnostics block, immediately followed by the bounded one-line digest (`Prior attempts (4): - #1 tsc: …`). So candidate 2's stated gap ("carries only a one-line attempt digest, so the model re-derives the exact last failure from a summary") no longer holds — the newest verbatim text is already present, and re-adding it beside the digest would duplicate it. Paused for a scope decision instead of implementing a duplicate (wontfix vs a narrowed digest change).
- Wontfix (2026-10-20, user decision): the newest exchange's diagnostics are already carried verbatim in the continuation/repair `Diagnostics:` block — `combinedDiagnostics` (`src/loop.ts:3776`, called at `:4722`) is rendered as a fenced block by `buildRetryPrompt`/`buildContinuationPrompt` (`src/loop.ts:582`/`:606`) and only then is the bounded one-line digest appended. So candidate 2's premise ("carries only a one-line attempt digest, so the model re-derives the exact last failure") does not hold, and implementing it literally would just duplicate that block. Verified structurally and on the live replay `tmp/replays-93/minilisp-tc-rep2.json` call 5 (the round-2 continuation shows the full `stage: tsc` + `stage: matcher` text, with `Prior attempts (4): - #1 tsc: …` appended after). No code change. The storm lever, if pursued, belongs to #65 / the digest's causal content (candidate 1), not to carrying the newest verbatim.
- Wontfix (2026-10-20): Already implemented: continuation/repair prompts carry the newest exchange's diagnostics verbatim in the Diagnostics: block (combinedDiagnostics @ src/loop.ts:3776/4722, rendered @ :582/:606); candidate 2's premise no longer holds, so it would only duplicate that block.
