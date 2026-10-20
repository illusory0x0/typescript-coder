# Design overview — typescript-coder

Audience: humans and agents who need the shape of the system before changing
it. This is orientation, not contract: normative behavior lives in
[`spec.md`](./spec.md), the model-facing edit syntax in
[`edit-protocol.md`](./edit-protocol.md), loop vocabulary in
[`glossary.md`](./glossary.md), review priorities in
[`review-guide.md`](./review-guide.md), and the measurement method plus the
honest weak spots in [`../benchmark/README.md`](../benchmark/README.md). Measured
numbers live in
[`../benchmark/results/consumption.md`](../benchmark/results/consumption.md).

## 1. What it is

`typescript-coder` (benchmark label `tc`) is two things at once.

- **A coding harness.** It reads an issue from stdin, inspects a TypeScript
  workspace with a hand-written frontend plus a symbol index, edits through a
  strict structured protocol, verifies with `tsc --noEmit` and `bun test`, and
  — when a run ends through the termination matrix — writes exactly one
  four-section summary (accomplished / failed and why / remaining / next
  step).
- **An experiment platform.** It is measured against the `opencode` CLI
  (label `oc`) on three frozen fixtures — `json-parser`, `sexp-parser`,
  `minilisp` — with frozen task text and the same model on both sides, and one
  headline metric: **USD per success**, kept in the consumption ledger.

The model drives the loop; the harness owns addressing, splicing, the gates,
verification, and recording.

## 2. Design principles

These are the load-bearing choices; most smaller decisions follow from them.

1. **Structured edits, never unified diffs.** The model does not emit diff
   text. It picks a **target** — mode (`modify`/`create`/`delete`) plus an
   **address** (`path × symbol × kind`) — and returns **one flat JSON edit
   payload** (`{"path","symbol","kind","matcher"?,"range"?,"replacement"}`).
   Address
   drift and patch-format failures disappear, diagnostics can name the exact
   field that failed, and retries stay cheap.
2. **Strict addressing — reject, don't guess.** The address is resolved
   against the symbol index with a **strict AND** (every field must hold, and
   the resolution must be unique — never a silent first match). The optional
   `matcher` is matched structurally (`anchor.ts`), or the optional `range`
   `(line,column)` selector (#72) addresses the span directly against the
   numbered current-source block. On any mismatch the edit
   is rejected and fed back; it is not fuzzily patched in.
3. **A bounded, two-level loop.**

   ```
   Run (≤32 iterations)
   └─ Edit (≤3 model exchanges) → Verification (tsc + bun test, no exchange)
   ```

   Every ceiling has a defined exit: an exhausted edit budget opens a
   continuation prompt (the iteration cap ends the run), the token budget
   ends the run immediately, and a stall milestone opens the no-progress
   ask. Nothing loops silently.

4. **Reject without writing; keep progress.** The syntax gate must pass
   before a byte is written, so a rejected edit leaves the file untouched. A
   change that passes the gate but fails verification is **kept**
   (keep-progress), and the next iteration re-asks against the freshly rebuilt
   context.
5. **Failures are feedback, not dead ends.** Rejections are classified by
   cause (protocol, address, echo, matcher, range, no-op, repeat, duplicate, gate,
   format, truncated, …), corrections escalate when the same cause repeats, and the
   harness adds structure as a run stalls: a **continuation prompt** when a
   round burns its exchanges, a **no-progress ask** at the 8-streak
   no-progress milestone and every 4 further failed rounds (#65), and a bounded
   **attempt digest** of prior failed
   attempts; a non-converging repair chain additionally gets a **failure
   history** note naming the unchanged failing set or the two cycling states
   (#71). A **repair exchange** may also make one bounded self-verification
   request (#73): `{"request":"read"|"check"|"test"}`, executed once per round
   against the same commands Verification runs, with a bounded result returned
   in the next prompt. Standing rule (#65): fixes for rejection storms may
   sharpen wording, never add hard caps or auto-stops, and never weaken the
   matcher, echo, or gate guards — a recovering cycle must still be able to
   succeed.
6. **Everything is recorded and replayable.** Each exchange lands in the run
   records; provider calls can be recorded into a replay bundle
   (`typescript-coder-replay@1`) that the replay runner executes offline,
   record by record, with no network. Recorded replies cannot react to new
   wording, so replays prove presence, not effect — behavioral effects are
   measured live.
7. **USD first, and only like-for-like.** Costs come from the official rate
   card by the run's own peak/off-peak window — a calculator estimate, not
   provider billing (runs are served through a relay, so timing carries no
   scheduling constraint). Rows are comparable only when fixture text, prompt
   text, loop configuration, and pricing table match
   (`benchmark/README.md` §"Evidence and provenance"); #66 tightens this
   mechanically with content hashes.

## 3. Component map

### 3.1 Frontend — hand-written; resolution does not depend on `tsc`

- `src/lexer.ts` / `src/parser.ts` — tokenizer and recursive-descent parser
  for the app-TS subset, with spans (`LexError`, `ParseError`).
- `src/utility.ts` — the binder (lexical scopes, declaration spaces,
  `resolve`) and the symbol index: `SymbolIndex`, `buildIndex` /
  `buildIndexTolerant` (tolerant = keep going past unparseable files),
  `Locator` / `IndexEntry`, `findDefinition`.
- `src/scroll.ts` — signature views and locator expansion: the bounded source
  views the loop shows the model.
- `src/anchor.ts` — model-reply plumbing: `stripCodeFences`,
  `extractJsonObject`, `parseAnchorFragment` (the `matcher`),
  `structurallyEqual`, `findAnchor`, `applyAnchorSplice`.
- `src/editor.ts` — `oxfmt` formatting for the write path (`formatSource`,
  called after a gate-passing splice); the legacy batch `applyEdits` is kept
  for `renameTool` and tests.
- `src/tools.ts` — harness command helpers used by verification: bounded
  `checkTool` (`tsc`) and `testTool` (`bun test`) with located diagnostics
  (`parseDiagnostics`, `runCommand`). `findDefinitionTool` / `renameTool` and
  the exported `ToolDefinition` list are v1 leftovers with no production
  caller: the loop sends no provider tools, and a tool-call reply is read
  only as a selection.

### 3.2 Agent loop — `src/loop.ts`

- **Prompt builders** — all model-facing text lives here (a prompt-text change
  is an experimental intervention): `buildContextYaml`, `buildSystemPrompt`,
  `buildUserPrompt`, `buildEditPrompt`, `buildCreatePrompt`,
  `buildRetryPrompt`, `buildContinuationPrompt`, `buildSelectionRetryPrompt`,
  `buildSelectionContinuationPrompt`, `buildSummaryPrompt`.
- **Context** — `discoverSourceFiles(cwd)` and `buildContextYaml` render the
  bounded file/symbol view (≤500 symbols, ≤200-char signatures, ≤8000-char
  spec section; overflow marked `truncated`); `selectSpecFiles(issue, files)`
  adds the issue-relevant spec-file section.
- **Budgets** — `DEFAULT_TOKEN_BUDGET` 120k; `MAX_EDIT_EXCHANGES` 3;
  `MAX_RUN_ITERATIONS` 32; `MAX_STALLED_ROUNDS` 8.
- **Rejection machinery** — `parseSelectionResponse` / `parseEditResponse`,
  `classifyRejection`, `rejectionPolicy`, `rejectionLead`, and the digest
  state (`createAttemptDigestState`). `parseSelfCheckRequest` recognises the
  repair-only `{"request":…}` reply (#73); `executeSelfCheck` runs the one
  whitelisted kind and renders the bounded `Self-check result` block.
- **Termination matrix** — `TerminationReason` = `token-budget` |
  `edit-exhausted` | `delete-verification-failed` | `prev-broken` |
  `harness-fault` | `output-limit`; a run that verifies green carries no reason. `LoopResult`
  keeps records and diagnostics for the benchmark, the failure artifact, and
  the replay runner.
- **Provider boundary** — `ProviderLike` keeps the loop testable; the default
  provider is `src/openai.ts`.
- **Failure artifacts** — `src/failure-artifact.ts` renders and archives a
  run's postmortem (reason, context, target, record counts, diagnostics,
  summary) under `failures/`, so live failures can be analyzed offline.

### 3.3 CLI & provider

- `src/cli.ts` / `src/main.ts` — stdin issue reader, `--model`, `--help`;
  runs the loop and prints the summary. The repo itself is the self-host
  acceptance target.
- `src/openai.ts` — OpenAI-compatible chat client (tool calls, 120 s
  per-attempt timeout, `retries` for network/429/5xx and a separate
  `timeoutRetries` budget; #74).

### 3.4 Replay — `src/replay-format.ts`, `src/replay-runner.ts`

A bundle records metadata (task, rep, model, issue, fixture) and every
provider call (messages in; content/tool calls out; finish reason; usage).
The runner swaps in a `ReplayProvider` and executes the real `runLoop`
offline, comparing the run record by record. Bundles are tc-only and are the
regression net for protocol and guard changes.

### 3.5 Benchmark — `benchmark/run.ts`, `src/benchmark-pricing.ts`, `benchmark/check.ts`

- **Tasks** — one frozen issue text per fixture (`TASK_ISSUES`), fixtures
  under `benchmark/fixtures/`.
- **Sides** — `tc` runs the loop in-process (recording a replay bundle when a
  replay dir is set); `oc` runs the `opencode` CLI on the same fixture and
  issue text, then reads its session export.
- **Judge** — `judgeWorkspace` = `tsc --noEmit` + `bun test` +
  byte-equality of `fixtureTrackedFiles` (`tsconfig.json` and
  `src/*.test.ts`), so a pass cannot be faked by editing the tests.
- **Aggregation** — `ok` = run ended with no termination reason AND the judge
  passed; aggregates come from the final records (reruns never leak in);
  `costPerSuccess` divides the priced runs' summed USD (failures included) by
  the passing runs (`null` when none); `tokensPerSuccess` has the same shape.
- **Pricing** — a calculator estimate, not provider billing: official rates,
  peak vs off-peak with straddling runs blended by window share; both sides'
  token conventions normalized.
- **Outputs** — `benchmark/results/<name>.json` plus an `.md` report, and one
  consumption-ledger row per measured change set. A result file is **durable
  once a ledger row or an issue cites it** (cited = durable).
- **Fixture sanity** — `benchmark/check.ts` asserts each frozen fixture
  starts in its expected red state before scoring means anything.

### 3.6 Acceptance — `acceptance/scenarios.ts` + `acceptance/run.ts`

The scripted end-to-end contract, offline by default with a mock provider:
`fix-answer`, `keep-progress-retry`, `persistent-failure`,
`context-correctness`, `check-test-propagation`; `self-host` runs under
`--all` (slow), `live-fix-answer` under `--live` (real API).

### 3.7 Process surface

- `issues/` — YAML-front-matter issues (`status`, `priority`, `deps`,
  `parent`) and the umbrella/dependency graph, driven by
  `.opencode/scripts/issue-tracker.ts` (`check`, `list`, `set done`;
  closing moves a file to `issues/done/`).
- `.opencode/` — a local clone of the coding-skills bundle (untracked,
  ignored), workflow skills under `.opencode/skills/` (commit, diagnose,
  report, …); `AGENTS.md` — the agent entry point and doc map.

## 4. Flows

### 4.1 One run, end to end (the tc side)

1. **Setup.** The fixture is copied to a scratch workspace; the issue is the
   frozen task text; the provider is live (benchmark / live runs) or a
   recorded mock (acceptance / replay).
2. **Run iterations (≤32).** Each iteration is an **Edit** phase plus
   **Verification**:
   - Edit exchanges share one 3-exchange budget between picking the target
     and revising content: bounded context → model reply → parse
     (fences / JSON / matcher) → resolve the address (strict AND; classified
     rejection on failure) → payload → syntax gate → splice → `oxfmt`. A
     rejected exchange consumes budget and feeds the next correction,
     escalating when a cause repeats; a continuing round appends the bounded
     attempt digest.
   - A round that burns its exchanges below the cap gets a **continuation
     prompt**: reply `STOP`, or a corrected edit/selection opens a fresh
     round. A round opening on 8 consecutive no-progress rounds with a pinned
     target starts with the **no-progress ask** instead — same `STOP` option,
     plus the streak count, the blocking cause, and concrete alternatives.
   - **Verification** runs `tsc --noEmit` + `bun test` on the kept state.
     Pass → the run is done (no termination reason); fail → the next
     iteration, with the diagnostics re-entering the edit context.
3. **Ending.** Any ceiling reached ends the run with its recorded
   `TerminationReason`; the model then writes the single four-section
   summary.
4. **After.** `benchmark/run.ts` judges the final workspace, prices the run
   from its usage buckets, and writes the result row; failures may leave
   failure artifacts and replay bundles for offline analysis.

### 4.2 The no-progress decision point

Rounds that end without an applied edit advance a run-scope no-progress
streak (failed verifications count too). At the first 8-streak milestone on a
pinned target — and then every 4 further failed rounds (#65), so a fast-burning
storm still reaches it — the harness stops repeating the same correction and
asks the model to decide: `STOP`, or continue with a materially different
approach.
The ask carries the streak, the cause, and alternatives; the digest carries
the prior failures and a ruled-out line. From the second decision point on
(#65) the ask is sharpened: it names the unchanged/cycling failing set the
`Failure history` note carries and requires the reply to address it or `STOP`.
This is the designed escape from rejection storms — a decision point, not a
cap; the first ask keeps its original wording and the recovering cycle can
still continue.

### 4.3 How a number is born

A live matrix run (sides × tasks × reps) produces per-run records, usage
buckets, and judge verdicts → aggregation (`ok`, `costPerSuccess`) → a result
JSON plus report → one ledger row (`benchmark/results/consumption.md`) with
its source file cited → comparisons only against rows measured on the same
fixture text, prompt text, config, and pricing. The ledger's Method section
and the README's weak-spot list are part of the result, not footnotes.

## 5. Invariants

- **No diff-based editing path.** Edits are target (mode + address) plus one
  flat JSON payload, spliced by the harness.
- **No tolerant matching, silent first match, fuzzy echo acceptance, or gate
  bypass.** The guards (`anchor.ts` matching, echo detection, syntax gate)
  stay strict; changes to them are Tier-1 review
  (`review-guide.md`).
- **No new hard caps or auto-stops as storm fixes.** An unproductive
  correction is dealt with by escalating and asking — the decision point must
  stay passable so a recovering cycle can still succeed.
- **Reject without writing.** A rejected edit is never partially applied.
- **No number without provenance.** Compare only same-text runs; every row
  cites its source; cited = durable; #66 pins the measured inputs.
- **The judge cannot be satisfied without the frozen tests.** Byte-equality
  of fixture-owned files is checked in `judgeWorkspace`.

## 6. Pointers

- Behavior contract: `docs/spec.md` (§1 for the run design, §6 for the loop).
- Terms: `docs/glossary.md`.
- Review: `docs/review-guide.md` (Tier 1 = loop prompts, edit protocol and
  gate, judge, pricing/aggregation, replay format).
- Numbers: `benchmark/results/consumption.md`; method and weak spots:
  `benchmark/README.md`.
- Open work: `issues/` via `issue-tracker.ts list`.
