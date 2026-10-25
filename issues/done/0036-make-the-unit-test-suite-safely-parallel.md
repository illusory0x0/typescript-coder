---
id: 36
title: "Make the unit test suite safely parallel"
status: done
priority: medium
milestone: null
parent: null
deps: []
labels: [agent-loop]
created: 2026-10-25
---

## Context

The unit suite currently runs through `just test` as a plain `bun test`; it has no
`--parallel`, `--isolate`, or `test.concurrent` usage. The last full run was
1320 tests in about 319 seconds. Bun supports file-level parallelism with
`bun test --parallel=<n>` (worker processes, implies `--isolate`) and
within-file concurrency with `--concurrent`.

A direct switch is unsafe. `src/loop.test.ts` mutates
`process.env.TC_DIAG_DECL_NAMING`; `src/cli.test.ts` runs a nested
`Bun.spawnSync(["bun", "test"])` self-host suite; many tests spawn `tsc` or
test subprocesses; and `src/loop.test.ts` is a large single file that
file-level parallelism cannot split.

## Goal

Add a safe, bounded parallel test path, keep the serial `just test` as the
deterministic default until the parallel path is proven, and document which
tests need isolation before within-file concurrency is considered.

## Acceptance criteria

- [ ] Audit test files for process-global state: `process.env`, cwd changes,
      module singletons, fixed ports/paths, shared temp names, and subprocess
      recursion. Record unsafe cases near their tests.
- [ ] Add an opt-in `just test-parallel` recipe using bounded
      `bun test --parallel=<n>` (not `--concurrent` initially), with a default
      chosen from CPU count and a way to lower it for small machines.
- [ ] Keep `just test` serial and deterministic until the parallel path passes
      repeated full-suite runs.
- [ ] Make the `cli.test.ts` nested self-host run safe under a parallel worker:
      no recursive full-suite fan-out, and the existing `.nested-smoke` guard
      remains effective.
- [ ] Ensure env-mutating tests restore state in `finally`/`afterEach`, and
      confirm the serial default remains correct.
- [ ] Run the full suite at least 3 times through `test-parallel` with no
      failures; compare wall time and report CPU/memory behavior.
- [ ] Consider `test.concurrent` only for audited pure test groups; if unsafe,
      leave it out of scope and document why.
- [ ] `just typecheck && just test` passes; the parallel path is documented in
      the test/contributor docs.
- [ ] No benchmark or live model run is required.

## Verification

- `just typecheck && just test`
- `just test-parallel` three times on the same machine; all runs pass.
- `time bun test --parallel=2` and `time bun test --parallel=4` (or the chosen
  bounded values) to record the speed/CPU tradeoff.
- Confirm `src/cli.test.ts` does not recursively launch another full parallel
  suite in a worker.

## Notes

- This is an independent root issue, not a child of #26; it does not block the
  plan-exec-review V2 redesign.
- Do not change `just test` to parallel by default in the first pass.
- No benchmark or live model run; this is developer test infrastructure.
- Priority is `medium` and milestone is `null` (tracker default).
- Resolved: audited process-global test state (env flags restored in finally/afterEach; fixed judge-golden and unique replay workspaces; cli self-host nested spawn). Added opt-in just test-parallel [n] using bun test --parallel (file-level, no --concurrent), default min(nproc,4), arg/TC_TEST_JOBS lower override, positive-integer validation; just test stays serial. cli self-host now runs only copied src/index.test.ts, so no recursive full-suite fan-out; .nested-smoke guard remains. Audit notes added near unsafe tests and AGENTS Testing/parallel safety section. Verification: just typecheck; serial just test 1430 pass 0 fail (212.28s, 386MB maxrss); parallel default 4 1430 pass (116.71s, 334.83 user, 56.03 sys, 289MB); parallel 2 1430 pass (116.32s, 328.80 user, 55.02 sys, 327MB); subagent ran four parallel suites 1430 pass each; just accept 8 passed. No test.concurrent.
