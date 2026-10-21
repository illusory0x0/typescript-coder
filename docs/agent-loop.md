# The agent loop

`tc` is not an open-ended tool-calling agent. A run is a fixed Edit → Verify loop:
the model is asked to pick one declaration, then to rewrite part of it, and the
harness decides whether the result counts. The model never chooses files to
read or commands to run; it answers structured prompts and the harness owns
discovery, splicing, formatting, and verification. Implementation:
`runLoop` in `src/loop.ts`.

## Shape of a run

1. **Context.** The workspace's `.ts` files are discovered, parsed into a symbol
   index, and rendered as a compact YAML context (path → name/kind/signature, with
   a cap and a `truncated: true` flag). Test files, plus any file the issue names
   inline, are attached whole as read-only spec files. One system prompt and one
   user prompt (issue + context) open the run.
2. **Round.** A round has a budget of **3 exchanges** shared by picking a
   target, writing an edit, and any retries after a rejection.
3. **Pick.** The model replies with a JSON address `{mode, path, symbol, kind}`
   (`modify` | `create` | `delete`). Resolution is strict: the composite address
   must match exactly one indexed declaration. There is no silent first-match.
   The first successful pick is pinned for the run; later exchanges must echo
   it (a verification-repair round may re-pin to a different declaration in the
   same file).
4. **Edit.** The pinned declaration is shown with 1-based line numbers, and the
   model replies with one edit payload: an address, an optional `matcher`
   (snippet or 1-based `range`, the latter winning), and a `replacement`. The
   compact protocol (`--protocol-format=compact`) substitutes `select … end`
   clauses; the optional multi-payload protocol lets one reply batch
   non-overlapping regions and/or multiple files, applied atomically.
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

Each exchange and each verification is recorded as a row (`records`), which is
what the result contract (`src/result.ts`) and the benchmark harnesses consume.

## Failure handling

Everything is expressed as a retry with better information, never as a silent
give-up:

- **Rejection retry** — the same round, with the failure class (`protocol`,
  `address`, `matcher`, `gate`, `format`, `no-op`, `repeat`, …) turned into a
  correction sentence. The same class repeated escalates.
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

      // 2. Pick, if nothing is pinned yet.
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
      const payload = parseEdit(reply); // one payload, a batch, or compact clauses
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

These are real branches in `runLoop`; the core above is still correct without
them, which is why they sit outside it:

- **Verification failures also advance `stalledRounds`** — the counter spans
  both rejection cycles and failed verifications, and is never reset (a pass
  ends the run).
- **Create → repair** — a failed `create` whose file parses becomes a `modify`
  round against the kept file; an unparseable or absent one is removed and the
  create is retried.
- **Termination reasons other than budget** — token budget, three consecutive
  truncated completions, a broken previous source, and a harness-side
  formatter fault each take their own exit.
- **Explicit-targets mode** — when the caller supplies addresses, picking is
  skipped, the target queue drives rounds, and same-file targets are sequenced
  across exchanges.
- **Prompt variants** — lean issue messages on `tsc` repair rounds, repair-context
  shrinking, a bounded prior-attempts digest, and a failure-history note only
  feed the continuation and no-progress prompts.

Provider failures are retried in `src/openai.ts`, not here; context overflow and
payload-too-large are translated into diagnostics so one bad call does not
discard the run.
