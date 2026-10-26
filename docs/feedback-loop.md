# The feedback loop

Canonical ownership: this document owns the cross-mode loop lifecycle — AgentMode
routing, rounds and exchanges, the pinned-repair Edit → Verify flow, retry /
no-progress / termination policy, caps, records/result, and the `runLoop`
skeleton. [`plan-exec.md`](plan-exec.md) owns the Plan → Execute → Review model,
Plan/patch DSL, planning/review, scheduling, and plan-exec-specific execution.
[`edit-protocol.md`](edit-protocol.md) owns the edit-action reply language, both
wire formats, resolution/cascade, application/gating, and repair feedback.
Vocabulary is canonical in [`README.md`](README.md).

`tc` is not an open-ended tool-calling agent. Its default `pinned-repair` run is
a fixed Edit → Verify loop: the model is asked to pick one declaration, then to
rewrite part of it, and the harness decides whether the result counts. The model
never chooses files to read or commands to run; it answers structured prompts
and the harness owns discovery, splicing, formatting, and verification.

Implementation: `runLoop` in `src/loop.ts` is a dispatcher. The default
`pinned-repair` mode routes to `runEditDslLoop` (explicit targets and
`--protocol-format=json` route to `runJsonLoop`); `--mode plan-exec` lazily
routes to `runTaskLoop` in `src/task-loop.ts`. The drivers are independent: each
owns its run driver (budget, rounds, records) and shares only the lower-level
primitives (index and context, selection resolution, gates). Protocol prompt
text lives in `src/prompts/{json,edit-dsl,task}.ts` and the commit/gate pipeline
in `src/commit.ts`.

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
dependents, and the planner may repair, add, or remove pending/failed work between
execution rounds.

[`plan-exec.md`](plan-exec.md) owns the Plan/WorkNode model, the Plan and patch
DSLs, planning and review, validation/merge, scheduling, execution context,
application and gates, progress termination, and plan-exec-specific limits.

Both modes share tolerant parser diagnostics (`src/dsl-diagnostics.ts`), the
commit/gate pipeline (`src/commit.ts`), and the result contract
(`src/result.ts`). Plan-exec additionally splits spend into `planning`, `review`,
and `execution` `LoopTokens` buckets; their sum is `LoopResult.tokens` and all
count toward the budget. Recovered parser warnings are on
`LoopResult.warnings`; [`plan-exec.md`](plan-exec.md) §10 owns those fields.

## Shape of a pinned-repair run

1. **Context.** The workspace's `.ts` files are discovered and parsed into a
   symbol index. Under the default edit-dsl format the index is rendered as
   top-level `select <name> in <path> [resolve <space>]` lines (no signatures,
   no test files, capped); explicit `--protocol-format=json` keeps the YAML
   context (path → name/kind/signature, with a cap and a `truncated: true`
   flag). Test files, plus any file the issue names inline, are attached whole
   as read-only spec files. One system prompt and one user prompt (goal +
   index/context) open the run.
2. **Round.** A round has a budget of **3 exchanges** shared by selecting a
   target, writing an edit, and any retries after a rejection.
3. **Select/pick.** Under edit-dsl, the first reply is one `select … end` clause
   naming a symbol-index entry, or file commands that pin their target. A
   viewer pins the declaration and the harness sends a `# details` prompt with
   the declaration's source numbered by file-absolute lines; an editor clause
   applies its own replacement or rename. A missing path, missing symbol, or
   space miss pins mode `create` and asks for a create clause. Under the JSON
   payload format, the model instead replies with a JSON address
   `{mode, path, symbol, kind}` (`modify` | `create` | `delete`); resolution is
   strict and there is no silent first-match. The first successful selection is
   pinned for the run; later exchanges must echo it (a verification-repair round
   may re-pin to a different declaration in the same file). The edit-action
   grammar and the viewer/editor split are owned by
   [`edit-protocol.md`](edit-protocol.md) §2 and §4.
4. **Edit.** The pinned declaration is shown with 1-based line numbers, and the
   model replies with one edit-action in the format selected by
   `--protocol-format`. [`edit-protocol.md`](edit-protocol.md) owns the wire
   formats, locators, rename semantics, and the optional atomic multi-payload
   batch.
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
   verified again. JSON has no confirmation turn. The confirmation turn is owned
   by [`edit-protocol.md`](edit-protocol.md) §6.

## Records and result

Each exchange and each verification is recorded as a row (`records`). A
`LoopRecord` carries `row`, `iteration`, `kind` (`exchange` or `verification`),
`exchange`, `outcome`, `locator`, `replacement`, `diagnostics`,
`diagnosticsHead`, `replacementChars`, `finishReason`, `payloads`, `toolCalls`,
`appliedLocators`, `selectors`, `stages`, and `matcherKinds`.

A `LoopResult` carries `ok`, `mode` (the selection mode, not `AgentMode`),
`locator`, `filePath`, `editedSource`, `records`, `diagnostics`, `explanation`,
`messages`, `skipped`, `terminationReason`, `tokens`, and `appliedTargets`.
Plan-exec adds `usage`, `warnings`, and `nodes`; [`plan-exec.md`](plan-exec.md)
§10 owns those fields and the string-id WorkNode result schema.

The subagent result printed by `--format json` is
`typescript-coder-result@3`: format, status, verified, files, targets, records,
tokens, terminationReason, diagnostics, and (plan-exec only) nodes. It keeps the
single `tokens` object; `LoopResult.usage` and `LoopResult.warnings` are not
exposed there.

## Failure handling

Everything is expressed as a retry with better information, never as a silent
give-up:

- **Rejection retry** — the same round, with the failure class (`protocol`,
  `address`, `matcher`, `gate`, `format`, `no-op`, `repeat`, …) turned into a
  correction sentence. The same class repeated escalates. Edit-dsl retries and
  continuations reuse the select-first `# Goal` + `# Symbol index` + `# details`
  shape; JSON keeps its pinned-selection block. The format-specific correction
  text is owned by [`edit-protocol.md`](edit-protocol.md) §7.
- **Before editing, a repair exchange may ask one bounded self-check** —
  `{"request":"read" | "check" | "test"}` — to see the current source or run
  the task's commands itself. It does not write anything.
- **Round continuation** — a round that spends its 3 exchanges without a valid
  edit does not end the run. A continuation prompt carries the checkpoint
  (prior attempts, failure history) and offers `STOP`, or a corrected reply that
  opens a fresh round with a new budget.
- **No-progress ask** — after 8 consecutive failed rounds (then every 4), the
  model is told the failing set has not converged and must either change the
  cause or reply `STOP`. From the second such ask (or when the failing set is
  already unchanged/cycling), the turn becomes decision-only: the model states a
  re-approach, which the next edit prompt requires it to follow.
- **Hard caps (pinned-repair)** — 32 rounds, 3 consecutive output-length
  truncations, and a 120k default token budget. Any of them ends the run through
  the termination path: one summary prompt producing Accomplished / Failed and
  why / Remaining / Next step, plus a `TerminationReason` on the result. The
  termination matrix emits `token-budget`, `edit-exhausted`,
  `delete-verification-failed`, `prev-broken`, `harness-fault`, `output-limit`,
  or (plan-exec) `task-exhausted`. Plan-exec shares only the token budget; it has
  no fixed round, exchange, viewer, review, or output-limit cap and is bounded by
  the token budget and repeated/no-progress fingerprints
  ([`plan-exec.md`](plan-exec.md) §9).

## Algorithm core (skeleton)

The essential control flow, stripped of prompt rendering and reporting:

```ts
async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const files = discoverSourceFiles(options.cwd);
  const context = buildContextYaml(files);
  let messages = [systemPrompt(options), userPrompt(options.issue, context)];
  let pinned: Selection | null = null; // first successful pick
  let diagnostics: string | null = null; // failure that opens the next round
  let stalledRounds = 0;
  let continuation: { pick: boolean; diagnostics: string } | null = null;

  for (let round = 1; round <= MAX_RUN_ITERATIONS; round += 1) {
    let applied = false;
    let verificationFailed = false;

    for (let exchange = 1; exchange <= MAX_EDIT_EXCHANGES; exchange += 1) {
      // 1. Ask. The prompt depends on whether a target is pinned and on what
      //    failed last; the reply is parsed strictly, or rejected as protocol.
      messages = buildPrompt(pinned, diagnostics, continuation);
      const reply = await options.provider.chat(messages, undefined, { effort: "none" });

      if (reply === "STOP" && offersStop(pinned, continuation)) {
        return terminate("edit-exhausted", diagnostics);
      }

      // 2. Select, if nothing is pinned yet. The reply language is owned by
      //    edit-protocol.md: edit-dsl parses a select clause or file commands;
      //    JSON resolves the strict address.
      if (pinned === null) {
        const selection = resolveSelection(reply, options.cwd); // strict AND
        if (!selection.ok) {
          diagnostics = selection.diagnostic;
          continue; // same round, next exchange
        }
        pinned = selection.selection;
        continue;
      }

      // 3. Edit (or one bounded self-check request, which is not an edit).
      const request = parseSelfCheck(reply);
      if (request !== null) {
        diagnostics = runSelfCheck(request, options);
        continue;
      }
      const payload = parseEdit(reply); // one JSON payload, a batch, or edit-dsl statements
      if (!payload.ok) {
        diagnostics = payload.diagnostic;
        continue;
      }

      // 4. Gates: resolve, splice, parse, format. Nothing written until all pass.
      const resolution = applyEdit(pinned, payload.edit, readDisk(pinned.path));
      if (!resolution.ok) {
        diagnostics = resolution.diagnostic;
        continue;
      }
      writeFile(pinned.path, resolution.source);
      applied = true;

      // 5. Verify. No rollback: the attempted state stays on disk.
      const check = await checkTool(options.cwd, options.checkCommand);
      const test = await runVerificationTests(options.cwd, options);
      if (check.ok && test.ok) {
        return success(resolution.source);
      }
      diagnostics = formatDiagnostics(check, test);
      verificationFailed = true;
      break; // open the next round with these diagnostics
    }

    // 6. Round bookkeeping (#60): a round that wrote no edit counts exactly like
    //    a failed verification. Only a pass (which ends the run) resets it.
    if (verificationFailed || !applied) {
      stalledRounds += 1;
    }

    // 7. Continue or stop. A stalled streak opens the next round with the
    //    no-progress ask (or, past the first ask, a decision-only turn).
    if (isStalledAskMilestone(stalledRounds)) {
      diagnostics = stalledAskDiagnostics(stalledRounds);
    }
    if (round === MAX_RUN_ITERATIONS) {
      return terminate("edit-exhausted", diagnostics);
    }
    continuation = { pick: pinned === null, diagnostics };
  }
}
```

### What the skeleton leaves out

These are real branches in the two drivers; the core above is still correct
without them, which is why they sit outside it:

- **Verification failures also advance `stalledRounds`** — the counter spans
  both rejection cycles and failed verifications, and is never reset (a pass
  ends the run).
- **Create → repair** — a failed `create` whose file parses becomes a `modify`
  round against the kept file; an unparseable or absent one is removed and the
  create is retried.
- **Termination reasons other than budget** — token budget, three consecutive
  truncated completions, a broken previous source, and a harness-side
  formatter fault each take their own exit.
- **Explicit-targets mode** — when the caller supplies `LoopOptions.targets`,
  one locator per desired declaration, the JSON driver skips picking, the
  target queue drives rounds, and same-file targets are sequenced across
  exchanges; the edit-dsl driver never sees targets.
- **Prompt variants** — lean issue messages on `tsc` repair rounds, repair-context
  shrinking, a bounded prior-attempts digest, and a failure-history note only
  feed the continuation and no-progress prompts.

Provider failures are retried in `src/openai.ts`, not here; context overflow and
payload-too-large are translated into diagnostics so one bad call does not
discard the run.
