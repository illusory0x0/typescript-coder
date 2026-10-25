# The agent loop

`tc` is not an open-ended tool-calling agent. Its default `pinned-repair` run is
a fixed Edit → Verify loop: the model is asked to pick one declaration, then to
rewrite part of it, and the harness decides whether the result counts. The model
never chooses files to read or commands to run; it answers structured prompts
and the harness owns discovery, splicing, formatting, and verification.

Implementation: `runLoop` in `src/loop.ts` is a dispatcher. The default
`pinned-repair` mode routes to `runEditDslLoop` (explicit targets and
`--protocol-format=json` route to `runJsonLoop`); `--mode plan-exec`
lazily routes to `runTaskLoop` in `src/task-loop.ts`. `edit` is the deprecated
alias for pinned-repair. The drivers are independent: each owns its run driver
(budget, rounds, records) and shares only the lower-level
primitives (index and context, selection resolution, gates). Protocol prompt
text lives in `src/prompts/{json,edit-dsl,task}.ts` and the commit/gate pipeline
in `src/commit.ts`.

## Plan → execute → review mode

`--mode plan-exec` adds a second loop ([`spec.md`](spec.md)): a planner
emits one current Stage/Task in the flat Plan DSL (`src/plan-dsl.ts`), the
executor carries out one Task's edits, and the planner reviews the applied
result before the Task settles.

- **Plan.** The Plan root carries a string `id` and `goal`; every
  Plan/Stage/Task/Edit id is a globally unique `NN-slug` string (`"01-main"`,
  `"03-task-reader"`). The initial reply contains one current Stage and one
  current Task. Later planning turns emit one `patch` with at most one new
  Task; a new Stage includes its first Task. Plan shape is guidance, not a
  fixed count: a cohesive change can be one Stage, Task, and edit. An edit
  targets one declaration, or uses `write <path>` to replace a whole file.
  `finish` marks the last `test` Task as `finalTaskId`.
- **Execute.** A Stage groups a coherent phase; a Task is the verification
  boundary and runs its `tsc` or `test` gate after all of its edits settle.
  An edit either targets one declaration or writes a whole file with
  `write <path>`; a repeated address mismatch escalates to a repair patch.
  Work-in-progress may end in a `tsc` Task; only the `finish` Task must test.
- **Review.** After the gate, the Task enters `review` and one compact review
  turn receives the gate result and a concise diff of the applied edits. It
  replies `approve` or one patch that may repair only the current Task; the
  patched Task re-executes and is not reviewed a second time.
- **Diagnostics.** Both DSLs share tolerant parsing and
  `src/dsl-diagnostics.ts`: unambiguous missing `end`/fence/bare-id forms recover
  with warnings, while a malformed destructive reply is rejected whole.
- **Accounting.** `LoopResult.usage` splits spend into `planning`, `review`, and
  `execution` `LoopTokens` buckets; their sum is `LoopResult.tokens` and all
  count toward the budget. Recovered parser warnings are on
  `LoopResult.warnings`.

The `pinned-repair` mode is unchanged. The `--format json` result is
`typescript-coder-result@2`, with string node ids on `tasks`.

## Shape of a pinned-repair run

1. **Context.** The workspace's `.ts` files are discovered and parsed into a
   symbol index. Under the default edit-dsl protocol the index is rendered as
   top-level `select <name> in <path> [resolve <space>]` lines (no signatures,
   no test files, capped); explicit `--protocol-format=json` keeps the YAML context
   (path → name/kind/signature, with a cap and a `truncated: true` flag). Test
   files, plus any file the issue names inline, are attached whole as read-only
   spec files. One system prompt and one user prompt (goal + index/context) open
   the run.
2. **Round.** A round has a budget of **3 exchanges** shared by selecting a
   target, writing an edit, and any retries after a rejection.
3. **Select/pick.** Under edit-dsl, the first reply is one `select … end` clause
   naming a symbol-index entry, or file commands (`create`/`delete`/`read`/
   `write`) that pin their target. A viewer (no `replace`) pins the declaration
   and the harness sends a `# details` prompt with the declaration's source
   numbered by file-absolute lines; an editor clause applies its own replacement
   or rename. A missing path, missing symbol, or space miss pins mode `create`
   and asks for a create clause. Under explicit JSON, the model instead replies
   with a JSON address `{mode, path, symbol, kind}` (`modify` | `create` |
   `delete`); resolution is strict and there is no silent first-match. The first
   successful selection is pinned for the run; later exchanges must echo it (a
   verification-repair round may re-pin to a different declaration in the same
   file).
4. **Edit.** The pinned declaration is shown with 1-based line numbers, and the
   model replies with one edit payload. Under edit-dsl that is one or more
   `select … end` clauses with `<<<TC_EDIT_BEGIN>>>` / `<<<TC_EDIT_END>>>`
   replacement fences or a semantic `rename <old> to <new>`, optionally mixed
   with raw file commands;
   under JSON it is an address, an optional `matcher` (snippet or 1-based
   `range`, the latter winning), and a `replacement`. A rename updates the
   declaration and every same-file reference that resolves to it, including
   dotted namespace/member targets; shadowed bindings and collisions are
   rejected at the address stage. The optional multi-payload protocol lets one
   JSON reply batch non-overlapping regions and/or multiple files, applied
   atomically.
5. **Gates.** Before anything touches the disk, the candidate must pass, in
   order: address/splice guards (matcher must resolve uniquely, range must be
   inside the declaration, no-op and byte-identical resubmission are rejected),
   a parse gate (a file that parsed must still parse), a duplicate-declaration
   guard, the formatter, and a post-format no-op check. A failure is reported
   back with a `stage:` tag and costs an exchange.
6. **Verify.** The harness runs the check command (default `bunx tsc --noEmit`)
   and the task's test command, no model call involved. Pass ends the run
   successfully. A failure does not roll back: the attempted state stays on
   disk, and the diagnostics open the next round.
7. **Confirm (edit-dsl).** After an edit-dsl edit verifies, the harness sends a
   `# modified text` prompt with the edited declaration. `Great! I resolve this
   problem!` (or any non-editor reply) confirms and ends; an editor clause with
   `replace` or `rename` and exchange room is applied and verified again. JSON
   has no confirmation turn.

Each exchange and each verification is recorded as a row (`records`), which is
what the result contract (`src/result.ts`) and the benchmark harnesses consume.

## Failure handling

Everything is expressed as a retry with better information, never as a silent
give-up:

- **Rejection retry** — the same round, with the failure class (`protocol`,
  `address`, `matcher`, `gate`, `format`, `no-op`, `repeat`, …) turned into a
  correction sentence. The same class repeated escalates. Edit-dsl retries and
  continuations reuse the select-first `# Goal` + `# Symbol index` + `# details`
  shape; JSON keeps its pinned-selection block.
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
- **Hard caps** — 32 rounds, 3 consecutive output-length truncations, and a
  120k default token budget. Any of them ends the run through the termination
  path: one summary prompt producing Accomplished / Failed and why / Remaining /
  Next step, plus a `TerminationReason` on the result.

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

      // 2. Select, if nothing is pinned yet. Edit-dsl parses one `select … end`
      //    clause or file commands (a viewer yields `# details`, an editor
      //    prefetches its edit); JSON resolves the strict address.
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
      const payload = parseEdit(reply); // one payload, a batch, or edit-dsl clauses
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
- **Explicit-targets mode** — when the caller supplies addresses the JSON
  driver skips picking, the target queue drives rounds, and same-file targets
  are sequenced across exchanges; the edit-dsl driver never sees targets.
- **Prompt variants** — lean issue messages on `tsc` repair rounds, repair-context
  shrinking, a bounded prior-attempts digest, and a failure-history note only
  feed the continuation and no-progress prompts.

Provider failures are retried in `src/openai.ts`, not here; context overflow and
payload-too-large are translated into diagnostics so one bad call does not
discard the run.
