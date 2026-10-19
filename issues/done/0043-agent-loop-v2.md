---
id: 43
title: "Agent loop v2: Run/Edit/Verification with shared ≤3 and summary-first termination"
status: done
priority: high
milestone: null
parent: 28
deps: [42]
labels: [harness]
created: 2026-10-18
---

## Context

The v2 loop redesign (settled 2026-10-18; terms in `docs/glossary.md`)
restructures `runLoop` (`src/loop.ts`) into three terms: **Run** (top-level
agent loop), **Edit** (micro agent loop, ≤3 model exchanges shared by target
picking and content revision) and **Verification** (tsc + test). This replaces
the selection/retry budget maze: selection retries and correction pools merge
into Edit's single ≤3; #36's progress-signature extension is abolished
(signature observation only); attempts are unbounded, capped solely by the
token budget. It absorbs #41's create→repair transition.

## Goal

Every model exchange is accounted to one Edit budget; every failure path ends
honestly (an LLM-written summary first, then terminate); only the token budget
caps how many rounds a run gets.

## Acceptance criteria

- [ ] Edit micro loop: at most 3 model exchanges per Run iteration, shared by
      target picking and content revision (no separate selection budget). A
      soft failure (protocol / address / matcher / gate / format) consumes one
      exchange and re-asks with its diagnostics (#42); a valid edit exits the
      loop.
- [ ] Pinning: `{mode, path, symbol, kind}` is fixed for the run at the first
      successful pick; later exchanges revise content only; an echo mismatch
      is a soft failure.
- [ ] Verification: tsc + test once per iteration; a failure starts the next
      iteration (unbounded). #36's extension/signature gating is removed —
      the signature stays as an observation.
- [ ] Termination matrix, each with an LLM-written summary as the final
      action (the summary call is a termination step, not an Edit exchange):
      token budget (120k) exceeded → abort with exactly one over-budget
      summary call; Edit exhausted (3 exchanges, no valid edit) → terminate
      the run; `delete` verification failure → terminate the run; broken
      `prev` → terminate the run. Success ends the run; provider/infra errors
      keep their own path.
- [ ] Mode orchestration: `create` → guard (#42) → content round; a failed
      create whose kept file parses becomes `modify` repair against the kept
      file (#41: current-file prompt + failure diagnostics; an unparseable
      kept file is removed and create re-runs); `modify` → matcher/replacement
      rounds; `delete` → selected then executed with no edit exchange; partial
      delete = `modify` with an empty replacement.
- [ ] Failure summaries land under `failures/` in this repo as artifacts; the
      outer layer (CLI / benchmark runner) commits them — the harness itself
      never runs git.
- [ ] Records reflect the v2 shape: exchange and verification rows plus
      termination reasons (`token-budget`, `edit-exhausted`,
      `delete-verification-failed`, `prev-broken`); `MAX_TOTAL_ATTEMPTS`,
      `DEFAULT_RETRY_EXTENSIONS` and `MAX_EDITS_PER_ATTEMPT` are removed with
      their machinery.
- [ ] Prompts and `spec.md` §6 are updated; unit tests for every termination
      path and the shared-≤3 accounting with a mock provider; offline replay
      evidence (#40); gates green.

## Verification

```
bun test
bunx tsc --noEmit
bun run accept
bun benchmark/replay.ts <bundle-with-a-termination-path>
```

## Notes

- Depends on #42 (wire format, soft-failure classes, guard/repair hooks).
- Revises done work: #36 (extensions gone), #30 (keep-progress now flows
  through repair), #33 (one matcher per exchange, serial rounds).
- Record changes ripple into `benchmark/run.ts` summaries and
  `benchmark/README.md` — keep them consistent.
- Non-goals: multi-file orchestration, parallel edits, the final benchmark
  measurement (see #44).
