---
id: 7
title: "Record the edit protocol in replay bundles"
status: done
priority: medium
milestone: null
parent: 6
deps: []
labels: [agent-loop, benchmark]
created: 2026-10-22
---

## Context

Compact is now the default edit protocol, but the replay bundle format (`src/replay-format.ts`, `typescript-coder-replay@1`) carries no protocol field, and `runReplay` forces `protocolFormat: "json"` (`src/replay-runner.ts:209-212`). A replay bundle recorded from a default compact run therefore contains compact prompts/replies while replay asks for JSON, so the recorded calls mismatch or fail as protocol rejections.

Old bundles are JSON and must keep replaying.

## Goal

Record the edit protocol in replay bundles and replay each bundle with the protocol it was recorded under, defaulting old bundles to JSON.

## Acceptance criteria

- [ ] `ReplayBundle` carries the edit protocol used for the recorded run (for example `protocolFormat: "json" | "compact"`).
- [ ] `ReplayRecorder` records the protocol from the benchmark/run context; `benchmark/run.ts --replay-dir` writes it.
- [ ] `runReplay` uses the bundle's protocol and defaults to `json` when the field is absent or unknown.
- [ ] A compact replay bundle round-trips through the replay runner and consumes every recorded call with no prompt mismatch.
- [ ] Existing JSON replay bundles and tests still replay byte-identically.
- [ ] The bundle format version/backward-compatibility rule is documented in `benchmark/README.md`.

## Verification

```
bun test src/replay-format.test.ts src/replay-runner.test.ts
bunx tsc --noEmit
```

Add a unit test that records a compact call and replays it; run the existing JSON replay tests unchanged.

## Notes

- The recorder is constructed in `benchmark/run.ts`; the protocol already exists on `CliArgs`/`RunContext`.
- The replay runner is offline; no live model call.
- A bundle-format version bump is acceptable if old bundles remain readable; state the choice in Notes.
