# The feedback loop

Canonical ownership: this document owns the cross-mode loop lifecycle — AgentMode
routing, rounds and exchanges, the pinned-repair Edit → Verify flow, retry /
no-progress / termination policy, caps, records/result, and the `runLoop`
skeleton. [`plan-exec.md`](plan-exec.md) owns the Plan → Execute model,
Plan DSL and amend records, planning/review, scheduling, and plan-exec-specific
execution.
[`edit-protocol.md`](edit-protocol.md) owns the edit-action reply language,
resolution/cascade, application/gating, and repair feedback.
Vocabulary is canonical in [`README.md`](README.md).

`tc` is not an open-ended tool-calling agent. Its default `pinned-repair` run is
a fixed Edit → Verify loop: the model is asked to pick one declaration, then to
rewrite part of it, and the harness decides whether the result counts. The model
does not run arbitrary commands: under edit-dsl it can inspect with `read` and,
after pinning, request the configured `check`/`test` commands; the harness still
owns discovery, splicing, formatting, and verification.

Implementation: `runLoop` in `src/loop.ts` is a dispatcher. The default
`pinned-repair` mode routes to `runEditDslLoop`; `--mode plan-exec` lazily
routes to `runTaskLoop` in `src/task-loop.ts`. Each driver owns its run
lifecycle (budget, rounds, records) and shares the lower-level primitives (index
and context, selection resolution, gates). Edit-dsl prompt text lives in
`src/prompts/edit-dsl.ts`, task prompts in `src/prompts/task.ts`, and the
commit/gate pipeline in `src/commit.ts`.

## Loop modes

`AgentMode` is the loop shape:

- `pinned-repair` (default) is the single-target Edit → Verify loop described
  here.
- `plan-exec` is the Plan → Execute → Review loop; [`plan-exec.md`](plan-exec.md)
  owns its model, DSL, and scheduling.

`--mode` and its alias `--agent-mode` accept the two canonical modes. The
default mode is `pinned-repair` (`tc < issue.txt`); naming it explicitly is
`tc --mode pinned-repair < issue.txt`, and `tc --mode plan-exec < issue.txt`
(or its `--agent-mode` alias) selects the other mode. `edit` is the deprecated
alias for `pinned-repair`; historical benchmark and replay rows keep their old
`edit` strings and are read through this mapping. `both` is the benchmark's
multi-mode selector, not a single-run CLI mode:
`bun run benchmark/run.ts --agent-mode both` measures `pinned-repair` and
`plan-exec`, while `tc --mode both` is rejected with a clear benchmark-only
message because one CLI process runs one loop.

## Plan → execute → review mode

`--mode plan-exec` adds a second loop: a work-graph planner emits a task-level
DAG of WorkNodes in the flat Plan DSL, the executor carries out one node's work
at a time, and the planner reviews the applied result after its gate passes. The
plan is a living graph: ready nodes run in record order, a failed node blocks its
dependents, and the planner may repair or add pending/failed work between
execution rounds. There is no node delete: a failed node is amended in place or
superseded by later work, and a green last test completes the run.

[`plan-exec.md`](plan-exec.md) owns the Plan/WorkNode model, the Plan DSL and
amend records, planning and review, validation/apply, scheduling, execution context,
application and gates, progress termination, and plan-exec-specific limits.

Both modes share tolerant parser diagnostics (`src/dsl-diagnostics.ts`), the
commit/gate pipeline (`src/commit.ts`), and the result contract
(`src/result.ts`). Plan-exec additionally splits spend into `planning`, `review`,
and `execution` `LoopTokens` buckets; their sum is `LoopResult.tokens` and all
count toward the budget. Recovered parser warnings are on
`LoopResult.warnings`; [`plan-exec.md`](plan-exec.md) §9 owns those fields.

## Shape of a pinned-repair run

1. **Context.** The workspace's `.ts` files are discovered and parsed into a
   symbol index. The index is rendered as top-level
   `select <name> in <path> [resolve <space>]` lines (no signatures, no test
   files, capped). Test files, plus any file the issue names inline, are attached whole
   as read-only spec files. One system prompt and one user prompt (goal +
   index/context) open the run.
2. **Round.** A round is one selection/repair cycle and has **no fixed
   exchange budget**: selecting a target, writing an edit, and every retry after
   a rejection stay in the same round until an edit is applied or the run stops.
3. **Select/pick.** Under edit-dsl, the first reply is one `select … end` clause
   naming a symbol-index entry, or file commands that pin their target. A
   viewer pins the declaration and the harness sends a `# details` prompt with
   the declaration's source numbered by file-absolute lines; an editor clause
   applies its own replacement or rename. A missing path, missing symbol, or
   space miss pins mode `create` and asks for a create clause. Resolution is
   strict and there is no silent first-match. The first successful selection is
   pinned for the run; later exchanges must echo it (a verification-repair round
   may re-pin to a different declaration in the same file). The edit-action
   grammar and the viewer/editor split are owned by
   [`edit-protocol.md`](edit-protocol.md) §2 and §4.
4. **Edit.** The pinned declaration is shown with 1-based line numbers, and the
   model replies with edit-dsl. [`edit-protocol.md`](edit-protocol.md) owns the
   clause grammar, locators, rename semantics, and atomic multi-clause replies.
5. **Gates.** Before anything touches the disk, the candidate must pass the
   guards and gates owned by [`edit-protocol.md`](edit-protocol.md) §6. A
   failure is reported back with a `stage:` tag and costs an exchange.
6. **Verify.** The harness runs the check command (default
   `bunx tsc --noEmit`) and the task's test command, no model call involved.
   Pass ends the run successfully. A failure does not roll back: the attempted
   state stays on disk, and the diagnostics open the next round.
7. **Confirm (edit-dsl).** After an edit-dsl edit verifies, the harness sends a
   `# modified text` prompt with the edited declaration.
   `Great! I resolve this problem!` (or any non-editor reply) confirms and ends;
   an editor clause with `replace` or `rename` and exchange room is applied and
   verified again. The confirmation turn is owned by
   [`edit-protocol.md`](edit-protocol.md) §6.

## Records and result

Each exchange and each verification is recorded as a row (`records`). A
`LoopRecord` carries `row`, `iteration`, `kind` (`exchange` or `verification`),
`exchange`, `outcome`, `locator`, `replacement`, `diagnostics`,
`diagnosticsHead`, `replacementChars`, `finishReason`, `payloads`, `toolCalls`,
`appliedLocators`, `selectors`, `stages`, and `matcherKinds`.

A `LoopResult` carries `ok`, `mode` (the selection mode, not `AgentMode`),
`locator`, `filePath`, `editedSource`, `records`, `diagnostics`, `explanation`,
`messages`, `skipped`, `terminationReason`, `tokens`, and `appliedTargets`.
Plan-exec adds `usage`, `turns`, optional `executionMessages`, `warnings`, and
`nodes`; [`plan-exec.md`](plan-exec.md) §9 owns those fields and the string-id
WorkNode result schema. `turns` is model-call telemetry; `steps`/`records` keep
their historical meaning.

The subagent result printed by `--format json` is
`typescript-coder-result@3`: format, status, verified, files, targets, records,
tokens, terminationReason, diagnostics, and (plan-exec only) nodes plus additive
`turns` telemetry. It keeps the single `tokens` object;
`LoopResult.usage`, `LoopResult.executionMessages`, and `LoopResult.warnings`
are not exposed there.

## Failure handling

Everything is expressed as a retry with better information, never as a silent
give-up:

- **Rejection retry** — the same round, with the failure class (`protocol`,
  `address`, `matcher`, `gate`, `format`, `no-op`, `duplicate`, …) turned into a
  correction sentence. The same class repeated escalates. Retries reuse the
  select-first `# Goal` + `# Symbol index` + `# details` shape. The correction
  text is owned by [`edit-protocol.md`](edit-protocol.md) §7. There is no fixed retry count: a
  distinct failure is retried until the USD cost budget or a no-progress stop.
- **Self-check turns** — after a target is pinned, a standalone `check end` or
  `test end` reply runs the task's configured check/test command and writes
  nothing. Self-checks are repeatable with no fixed count and are bounded by the
  token/no-progress policy.
- **Repeated no-progress fingerprint** — a failed reply repeated against the
  same source and diagnostics is no progress and ends the run with
  `edit-exhausted`; a cycle that keeps producing distinct replies is bounded by
  the USD cost budget instead. This replaces the old fixed exchange/round caps.
- **No-progress ask** — after 8 consecutive failed attempts (then every 4), the
  model is told the failing set has not converged and must either change the
  cause or reply `STOP`. From the second such ask (or when the failing set is
  already unchanged/cycling), the turn becomes decision-only: the model states a
  re-approach, which the next edit prompt requires it to follow. A selection
  cycle gets the same `STOP` offer on its own no-progress ask.
- **Termination (pinned-repair)** — the `$0.10` default USD cost budget, the repeated
  no-progress fingerprint, and a no-progress `STOP` end the run through the
  termination path: one summary prompt producing Accomplished / Failed and why /
  Remaining / Next step, plus a `TerminationReason` on the result. The
  termination matrix emits `cost-budget`, `edit-exhausted`,
  `delete-verification-failed`, `prev-broken`, `harness-fault`, `output-limit`,
  or (plan-exec) `task-exhausted`. The only remaining output-length guard is the
  three-consecutive-truncation strike (`MAX_CONSECUTIVE_LENGTH`); it is not an
  exchange/round cap. Plan-exec shares the same model; it has no fixed round,
  exchange, viewer, review, or output-limit cap and is bounded by the token
  budget and repeated/no-progress fingerprints
  ([`plan-exec.md`](plan-exec.md) §8).

## Algorithm core (skeleton)

The essential control flow, stripped of prompt rendering and reporting:

```ts
async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const files = discoverSourceFiles(options.cwd);
  const context = buildContextYaml(files);
  let messages = [systemPrompt(options), userPrompt(options.issue, context)];
  let pinned: Selection | null = null; // first successful pick
  let diagnostics: string | null = null; // failure that opens the next attempt
  let stalledAttempts = 0; // drives the no-progress ask cadence only
  const failedFingerprints = new Set<string>();

  for (let round = 1; ; round += 1) {
    let verificationFailed = false;

    // No fixed exchange cap: this loop leaves on an applied edit (then
    // verification), success, or a termination path.
    for (let exchange = 1; ; exchange += 1) {
      // 1. Ask. The prompt depends on whether a target is pinned and on what
      //    failed last; the reply is parsed strictly, or rejected as protocol.
      messages = buildPrompt(pinned, diagnostics);
      const reply = await options.provider.chat(messages, undefined, { effort: "none" });

      if (overBudget()) {
        return terminate("cost-budget", budgetDiagnostics());
      }
      if (offersStop(pinned) && reply === "STOP") {
        return terminate("edit-exhausted", diagnostics);
      }

      // 2. Select, if nothing is pinned yet. The reply language is owned by
      //    edit-protocol.md: parse a select clause or file commands.
      if (pinned === null) {
        const selection = resolveSelection(reply, options.cwd); // strict AND
        if (!selection.ok) {
          diagnostics = selection.diagnostic;
          stalledAttempts += 1;
          if (repeatedFingerprint(reply, diagnostics, failedFingerprints)) {
            return terminate("edit-exhausted", noProgressDiagnostics());
          }
          continue;
        }
        pinned = selection.selection;
        continue;
      }

      // 3. Edit (or a standalone self-check, which is not an edit).
      const selfCheck = parseSelfCheck(reply);
      if (selfCheck !== null) {
        diagnostics = runSelfCheck(selfCheck, options);
        continue;
      }
      const payload = parseEdit(reply); // edit-dsl statements
      if (!payload.ok) {
        diagnostics = payload.diagnostic;
        stalledAttempts += 1;
        if (repeatedFingerprint(reply, diagnostics, failedFingerprints)) {
          return terminate("edit-exhausted", noProgressDiagnostics());
        }
        continue;
      }

      // 4. Gates: resolve, splice, parse, format. Nothing written until all pass.
      const resolution = applyEdit(pinned, payload.edit, readDisk(pinned.path));
      if (!resolution.ok) {
        diagnostics = resolution.diagnostic;
        stalledAttempts += 1;
        if (repeatedFingerprint(reply, diagnostics, failedFingerprints)) {
          return terminate("edit-exhausted", noProgressDiagnostics());
        }
        continue;
      }
      writeFile(pinned.path, resolution.source);

      // 5. Verify. No rollback: the attempted state stays on disk.
      const check = await checkTool(options.cwd, options.checkCommand);
      const test = await runVerificationTests(options.cwd, options);
      if (check.ok && test.ok) {
        return success(resolution.source);
      }
      diagnostics = formatDiagnostics(check, test);
      stalledAttempts += 1;
      verificationFailed = true;
      break; // open the next round with these diagnostics
    }

    // 6. Continue. A failed verification opens the next round; the no-progress
    //    ask (and a decision-only turn past the first ask) is a cadence, not a
    //    round cap.
    if (verificationFailed) {
      continue;
    }
  }
}
```

### What the skeleton leaves out

These are real branches in the two drivers; the core above is still correct
without them, which is why they sit outside it:

- **The no-progress ask cadence** — `stalledAttempts` also counts rejected
  exchanges and failed verifications, and the first ask fires at 8, then every
  4; a decision-only turn never advances the counter. The ask is passable, so a
  recovering cycle can continue.
- **Create → repair** — a failed `create` whose file parses becomes a `modify`
  round against the kept file; an unparseable or absent one is removed and the
  create is retried.
- **Termination reasons other than budget** — three consecutive truncated
  completions (the `MAX_CONSECUTIVE_LENGTH` output-length guard, not a round or
  exchange cap), a broken previous source, a repeated no-progress fingerprint,
  and a harness-side formatter fault each take their own exit.
- **Prompt variants** — lean issue messages on `tsc` repair rounds, repair-context
  shrinking, a bounded prior-attempts digest, and a failure-history note only
  feed the no-progress asks.

Provider failures are retried in `src/openai.ts`, not here; context overflow and
payload-too-large are translated into diagnostics so one bad call does not
discard the run.
