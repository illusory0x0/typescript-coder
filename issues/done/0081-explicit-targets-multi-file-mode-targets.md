---
id: 81
title: "Explicit-targets multi-file mode (--targets)"
status: done
priority: medium
milestone: null
parent: 79
deps: [80]
labels: [harness, agent-loop, integration]
created: 2026-10-20
---

## Context

#69 added an opt-in path-independent `{"payloads":[…]}` batch, but it is
default-off and the model never emitted a batch live; #78 (filed) covers
same-file multi-region edits. For a sub-agent, `opencode` should pass exactly
which declarations `tc` must edit instead of having `tc` discover them.

## Goal

A modify call accepts an explicit list of `{path,symbol,kind}` targets and
applies edits across those files via the #69 path-independent shape, sequencing
same-file targets across exchanges and reporting any target it could not apply.

## Acceptance criteria

- [ ] `--targets <file.json>` (or a documented equivalent) seeds the run with
      the given addresses, and the edit exchange emits a `{"payloads":[…]}` batch
      covering them.
- [ ] at most one target per file per exchange; multiple targets in one file are
      sequenced across exchanges within the same call.
- [ ] each target resolves strictly (#48): a miss or ambiguity is a staged
      diagnostic, never a silent pick; unapplied targets are reported.
- [ ] a target-naming retry lead is added to close the #69 compliance gap (the
      model must emit the batch).
- [ ] the default behavior (no `--targets`) is the unchanged single payload.
- [ ] unit tests cover: two-file batch success; same-file sequencing; a missed
      target reported; resolution failure rejected.

## Verification

```
bunx tsc --noEmit
bun test
# a scripted multi-file call showing the batch applied end to end
```

## Notes

- Depends on C1. Builds on #69; same-file multi-declaration is #78 (non-goal).
- Fallback for correctness: sequence one declaration per exchange.
- Implemented. LoopOptions.targets seeds targets mode: the model pick is skipped, seedNextTarget resolves each pending target strictly (#48) and pins it (a miss/ambiguity is an address record, never a silent pick), and every content prompt (retries included) uses buildTargetsEditPrompt naming the pending addresses and demanding one flat payload per file in a {"payloads"} batch — closing the #69 compliance gap. validateTargetsReply requires the first payload to echo the pin, every payload to name a pending target, and at most one payload per file; same-file targets are sequenced across exchanges (re-pin + continue) so a round's edits land before its single verification; a passing round with targets still pending opens a fresh round, and unapplied targets are reported via withTargetsReport (run not ok). Targets mode forces the batch shape on; with no targets the default path is byte-identical. LoopResult.appliedTargets / LoopRecord.appliedLocators feed result.files. CLI --targets <file> reads an array or {"targets":[...]} of {path,symbol,kind} triples (validated, both flag forms); main.ts threads targets and echoes them in the JSON result. Tests: cross-file batch success (asserts the prompt names both addresses and payloads), same-file sequencing (one passing verification, two applied rows), missed target reported, non-unique target staged-rejected, parseArgs shapes/throws, and a result files-expansion test. Verification: bunx tsc --noEmit clean; bun test 851 pass; bun run accept 5/5.
