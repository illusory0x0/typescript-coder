# benchmark

Token and USD benchmark comparing the typescript-coder loop (`tc`) with the
opencode CLI (`oc`) on identical fixture copies, prompts, and model.

Sides are abbreviated `tc` (typescript-coder) and `oc` (opencode) in flags, labels, and tables; historical artifacts keep their original labels, and replay bundles recorded before the rename carry `side: "ts"` but stay readable.

Each task has one frozen spec under `benchmark/specs/<task>.md`, loaded as `TASK_SPECS` in `run.ts` (the historical `TASK_ISSUES` export is an alias). The same spec text is used verbatim by both sides and rendered into every report's `Frozen task specs` section.

`results/consumption.md` is the canonical before/after efficiency view across the
series (USD per success; the dated reports keep the token columns). Every row
carries its edit protocol: edit-dsl is the measured protocol from the
2026-10-21 baseline onward; older rows keep their historical labels and are not
like-for-like comparable to an edit-dsl row.

## Usage

    bun run benchmark/run.ts --all --pilot
    bun run benchmark/run.ts --task json-parser --side tc --reps 5 --keep
    bun run benchmark/run.ts --all --side tc --agent-mode both --reps 5

Flags: `--task`, `--all` (default), `--reps <n>` (default 5; measured runs require at least 5), `--concurrency
<n>` (default 4, max parallel runs), `--pilot` (1 rep per task and side, writes
`benchmark/results/pilot-<date>.json`), `--side tc` (the only allowed value; oc
is frozen), `--model`
(default `deepseek-flash`), `--keep`, `--json <path>`, `--replay-dir
<path>` (tc side only: write one replay bundle per run to `<path>/<task>-tc-
rep<n>.json`; off by default), `--token-budget <n>` (tc side only: abort a run
once accumulated **cache-excluded** loop tokens exceed n; the final termination
summary call is not budgeted; default 120000, see "Run budget" below), `--effort <none|low|high|max>` (tc side only: force this reasoning_effort
on every Edit-loop call, overriding the default described below),
`--agent-mode pinned-repair|plan-exec|both` (the tc loop; `pinned-repair` is the
default, `both` measures the pinned-repair and plan-exec loops in one
report, and `edit` remains the deprecated input alias), `--help`.
Non-pilot results default to `benchmark/results/<date>.json`.

The tc side runs every Edit-loop call at `reasoning_effort: none` by default
(the 2026-10-18 effort sweep showed reasoning only added cost on these tasks);
`--effort` overrides it with one value.

## Frozen baselines

The oc side is the frozen reference point. It was re-frozen on 2026-10-25
against `benchmark/specs/` (4 tasks × 3 reps):

- `benchmark/results/oc-baseline.json` — `--side oc`, `deepseek/deepseek-flash`.

It is a reference point, not a development loop: the benchmark **rejects**
`--side oc` outright under normal operation, so a change can never move the
baseline. A baseline update requires explicit human approval and a deliberate,
temporary bypass of the guard; restore the guard after the approved matrix. tc
reports run `--side tc` with the edit-dsl protocol.

The oc baseline measures the ambient OpenCode configuration, including its
registered skills; keep `.opencode/skills` and other OpenCode-level inputs
stable across oc re-freezes. The 2026-10-25 freeze had 25 registered skills.

A report whose `taskIssue` or `fixture` hash does not match the baseline's
withholds the comparison instead of comparing different inputs. Re-freeze the
baseline with approval when the spec or fixture inputs change.

A tc-only report loads `oc-baseline.json` and renders a
`## Savings vs oc baseline` section: per task and overall, with a
`Savings (oc/tc)` factor column. A factor is the baseline's mean cache-excluded
total divided by the tc mean, so `2.5x` means tc used 2.5 times fewer tokens.
Tasks missing from the baseline are skipped. The same sentence is printed after
a run. The baseline file carries its own `model`, `reps`, and `date`. When the
baseline is absent, no comparison section is rendered; when its spec hash is
stale, the report renders `## Baseline comparison unavailable` instead.

Each run also writes a sibling Markdown report next to the `--json` target
(`.json` replaced by `.md`): aggregates per task and side plus token/cost
accounting and anomaly notes.

Each run gets a fresh workspace under `tmp/benchmark/<stamp>/` (fixture copy plus
its own git repo, so the agent cannot reach this repository's
`benchmark/references/`). The judge is `bun test` + `tsc --noEmit` + byte
equality of the fixture's `src/*.test.ts` and `tsconfig.json`. On failure the
loop keeps the attempted state in the workspace (no rollback), so a failing
run's judged workspace holds the last attempted content rather than the pristine
fixture. The task × side × rep matrix is scheduled in **cache-stable prompt
groups** (side, loop mode, protocol); one group runs at a time, with up to
`--concurrency` workers (default 4) claiming jobs within it. This keeps workers
from alternating between pinned-repair and plan-exec prompts while jobs of the
same mode share a warm prefix. Each run keeps its own workspace, git repo,
session, and logs; `report.runs` stays in matrix order even though runs finish
in arbitrary order. `report.concurrency` records the effective bound,
`min(requested, largest group)`. The protocol matrix still exists for historical
reports, but the only selectable edit protocol is now `edit-dsl`: `json` is
frozen and `oc` is frozen. The live variant dimension is the tc loop mode
(`--agent-mode pinned-repair|plan-exec`); each tc run records `protocol`
and `agentMode` (null for `oc`) and aggregates/report tables keep variants in
separate rows. Legacy `edit` values are read through the alias.

## Fixtures and the held-out task

Four frozen fixtures live under `benchmark/fixtures/`: `json-parser`,
`sexp-parser`, `minilisp`, and the **held-out** task `csv-parser`. Each fixture
is frozen by #61's discipline: its model-facing issue text is fixed in
`TASK_SPECS` (`benchmark/run.ts`, from `benchmark/specs/<task>.md`) and only same-text runs are compared.

A fifth, larger fixture, `mini-spreadsheet`, was added after the 2026-10-25
freeze. It is an in-memory spreadsheet formula engine with a ~2,000-line
implementation target and lives under `benchmark/fixtures/mini-spreadsheet/`
with its reference at `benchmark/references/workbook.ts`. It is not part of the
frozen baseline matrix: the baseline spec hash deliberately covers only the
four tasks above, so `mini-spreadsheet` has no baseline rows and is available
for targeted tc runs without invalidating existing comparisons.

**`csv-parser` is held out (#67):** it is never the target of prompt or loop
iteration. Prompt/loop changes must not be tuned against it, and a held-out
result is never a change-set's evidence of _prompt fit_ — it gates only
"generalizes beyond the tuned fixtures" claims. Every series matrix includes it
(`--all`), so its result is recorded in every row's `Notes` (the per-task
columns stay the three tuned fixtures and `Overall` now spans all four tasks),
but the rule above governs how a change-set may cite it.
`benchmark/results/consumption.md` records the rule; the held-out result is
reported in each row's `Notes` and never as a tuned column.

## Metrics per record

- `tokens.input` / `tokens.output`: prompt / completion tokens.
- `tokens.cacheRead` / `tokens.cacheWrite`: cache hits and writes
  (`cache.read/write` for opencode, `prompt_tokens_details.cached_tokens` for
  the gateway); null when not reported.
- `tokens.reasoning`: reasoning tokens when reported (a subset of output on the
  OpenAI side, a separate counter on the oc side).
- `tokens.total`: reported total when available, otherwise the sum of reported
  input + output + reasoning; cache counters are not added in.
- `tokens.billable`: the cache-excluded, like-for-like view (#89). `in` =
  cache-miss input, `out` = output (reasoning included), and `total = in + out`;
  cache-hit input is excluded. `total` sums every provider call — for tc that
  includes the final termination summary the loop makes after a budget or
  exhaustion stop. `loop` (#47) is the scalar version of the same
  cache-excluded total over tc loop calls only and is the `--token-budget`
  basis; it is null on the oc side. Raw buckets go through `normalizeBuckets`
  in `src/benchmark-pricing.ts`; the loop split is `cacheExcludedTokens` in
  `src/loop.ts`.
- `usageSource`: `chat-completions` (tc) or `session-export` / `stats-project`
  (oc); `rawUsage` keeps the verbatim payload and null fields mean the
  side did not report them.
- `steps`: tc = number of recorded loop rows (`records`, exchanges +
  verifications); oc = assistant messages in the session export (null when
  unavailable).
- `agentMode` (tc side): `"pinned-repair"` or `"plan-exec"`; null for the
  oc side. Legacy rows may carry `"edit"`, read through the alias as
  `pinned-repair`.
- `records` (tc side): per-record summaries with `row`, `iteration`, `kind`
  (`exchange` or `verification`), `exchange` (1-based index inside the Run
  iteration; informational only, because pinned-repair has no fixed exchange
  budget; null for verification rows), `outcome`
  (exchanges: `selected`, `applied`, `stopped`, `protocol`, `address`,
  `matcher`, `no-op`, `duplicate`, `gate`, `format`, `truncated`, `prev-broken`; verifications: `ok`, `tsc`, `tests`, `gate`, `format`,
  `prev-broken`), the typed rejection `cause` (#56; null on success and
  verification rows), a bounded `diagnosticsHead` (≤200 chars, whitespace
  collapsed), `replacementChars`, and the provider `finishReason`; null for the
  oc side.
- `loopDiagnostics` (tc side): the loop's final run-level diagnostic (a
  termination-matrix reason plus staged diagnostics, or a provider error that
  ended the run before any record), null when none.
- `terminationReason` (tc side): `"token-budget"`, `"edit-exhausted"`,
  `"task-exhausted"`,
  `"delete-verification-failed"`, `"prev-broken"`, or `"harness-fault"` when the
  run ended through the termination matrix; null on success, on provider errors,
  and for the oc side.
- `failureArtifact`: a tc run that ends through the termination matrix also
  writes `failures/<ISO-stamp>-<reason>.md` under the repository root (reason,
  pinned target, staged diagnostics, LLM summary); the side log records its
  relative path. Success and provider errors write nothing. Before a matrix
  executes its first run, any artifacts left in `failures/` by the previous
  round are rotated into `tmp/failures-archive/<ISO-stamp>/`; CLI single runs
  never rotate.
- Replay bundles (`--replay-dir`): versioned JSON (`format` =
  `typescript-coder-replay@1`) with the task issue, fixture path, the recorded
  edit protocol (`protocolFormat`: `"edit-dsl"`; old/unknown values are
  rejected), the loop mode (`agentMode`: `"pinned-repair"` or `"plan-exec"`; absent
  reads as `"pinned-repair"`, and legacy `"edit"` values read through the
  alias), and the ordered
  chat calls (request messages, response content, finishReason, usage);
  consumed offline by the replay runner.
- `durationMs`: model work only (the judge runs afterwards and is not counted).
- `startedAt` / `finishedAt`: ISO wall clock of that same model work; the window
  that prices the run.
- `cost`: USD for the run's buckets at the official DeepSeek V4.1-Flash
  peak/off-peak rates for its window (see "Pricing (USD)" below); null when the
  side reported no usage.
- `rateClass`: `peak`, `off-peak`, or `mixed` for a run whose window crossed a
  rate boundary (its cost is the elapsed-time share blend).
- `ok`: judge verdict, forced to false when `terminationReason` is non-null
  (terminated runs count as run failures in aggregates); `sideOk` is the side's
  own result.

## Pricing (USD)

Runs are priced with the official DeepSeek V4.1-Flash prices (fetched 2026-10-19
from <https://api-docs.deepseek.com/quick_start/pricing>; USD per 1M tokens):
cache-hit input $0.006 peak / $0.003 off-peak; cache-miss input $0.30 / $0.15;
output $1.20 / $0.60 (`src/benchmark-pricing.ts` carries the rate table).

Peak hours are Monday-Friday 01:00-04:00 and 06:00-10:00 UTC, excluding Chinese
public holidays (`CN_2026_PUBLIC_HOLIDAYS` next to the rates); every other hour
is off-peak. That list is **2026-only and fixed**: for a date in another year it
matches nothing, so a holiday weekday in a later year prices as peak until the
list (or the year logic) is updated. A run whose window crosses a boundary
splits its cost by elapsed-time share — a documented uniform-spend
approximation.

These figures are a **calculator estimate, not provider billing**: the runs are
served through a relay endpoint that does not bill on DeepSeek's peak/off-peak
schedule. Run timing is therefore not a constraint — a run may happen at any
hour, and `rateClass` just records which window the calculator used.

Bucket normalization: tc `input` includes cache hits (miss = input - cacheRead);
oc `input` excludes them (miss = input, hit = cacheRead); output is priced
together with reasoning; `cacheWrite` is priced at the cache-miss rate (no
current data reports it). The `opencode session export` payload's own `cost`
stays in `rawUsage` and matches the computed value to within 1e-9 relative on the
recorded baselines.

Before a measured run, the benchmark warms only the cache-stable system prompts
(the edit system prompt, or the planning and execution system prompts for
plan-exec); task-specific user prompts are not warmed. Warm-up usage is recorded
under `warmups` and excluded from every measured table. Reports also print a
per-variant cache-hit ratio (`cacheRead / raw prompt tokens`) and emit a
`Cache warning` when any task or the overall ratios span 20 or more percentage
points, so a cold-cache run is not mistaken for a prompt regression.

The report's token totals are **cache-excluded and like-for-like** (#89):
`total = cache-miss input + output` (reasoning counted as output), normalized
for both sides through the same `normalizeBuckets` rule above; cache-hit input
is excluded. `tokens.billable.total` includes every provider call (for tc, the
final termination summary too), while `tokens.billable.loop` covers tc loop
calls only and is the `--token-budget` basis (#47). Each report states the token
multiplier between the sides, overall and per task. USD remains computed and
recorded — in the result JSON and `consumption.md` — for decisions, but is
marked decision-only and is not the headline comparison metric. Historical
result files and ledger rows predate this change and are **not rewritten**; the
new accounting applies to new runs.

## Edit protocol (tc side)

The only model reply protocol is **edit-dsl**. A selection is one
`select … end` clause naming a declaration with `(path, symbol, kind)`; the
address must resolve exactly once, and a miss or ambiguity is a staged
`address` failure listing candidates, never a silent first-match pick. An edit
is one or more clauses with an optional `match` snippet or `/regex/`, an
optional `pick` range, and a `replace with` fence; a bare viewer locates without
writing. Resolved clauses apply atomically across the reply, and a candidate
that adds a duplicate top-level function/class/type name is rejected as
`duplicate`. Then `oxfmt` formats and tsc/tests verify. `create` adds one named
declaration or member; an absent-symbol `select … replace` creates implicitly,
and an empty body deletes. After a target is pinned, standalone `check end` and
`test end` turns run the configured commands without writing. The full grammar
and resolution rules are owned by `docs/edit-protocol.md`.

## Run budget (tc side)

The tc loop nests Run and Edit (#43): each Run iteration repeats Edit →
Verification. There is no fixed exchange or iteration cap: target picking and
content revision keep retrying while distinct attempts make progress, and soft
failures (protocol, address, matcher, range-invalid, no-op, duplicate, gate,
format, truncated) re-ask with staged diagnostics. Each soft
failure is classified into a typed cause (#56) and the retry prompt's lead
sentence is that cause's concrete correction; consecutive same-cause rejections
accumulate in a run-scope streak (reset by an applied edit) that escalates from
the second one (for matcher causes: omit `matcher` and return the complete
declaration). A `format` rejection whose formatter message carries the
duplicate-modifier signature is a harness fault and exits immediately (see the
termination list). A repeated reply/source/diagnostics fingerprint is no
progress and ends the run; the no-progress ask fires at 8 consecutive failed
attempts (then every 4) and offers `STOP`. Verification runs once per iteration:
a pass ends the run, a failure starts the next iteration (the token budget is a
separate bound). A failed create whose kept file parses continues as a `modify`
repair round; an absent or unparseable kept file is removed and the create
re-runs.

A run that cannot produce a valid edit and stops making progress ends as
`edit-exhausted`, a deletion that fails verification ends as
`delete-verification-failed`, a target that stops parsing ends as
`prev-broken`, and a duplicate-modifier format rejection ends as
`harness-fault`. Each ends with exactly one LLM summary call (not an Edit
exchange) and is recorded in `terminationReason` + `loopDiagnostics`, with a
`failures/` artifact written by the benchmark runner.

`--token-budget <n>` (default 120,000) aborts a tc-side run as soon as
accumulated **cache-excluded** loop tokens strictly exceed `<n>` (exactly at the
budget keeps running). The budget uses the same cache-excluded bucket formula as
the report (cache-miss input + output + reasoning), but sums loop calls only:
compare a stopped run against `billable.loop`, not `billable.total`. The final
termination summary call is not budgeted, and the core CLI's `--token-budget`
remains a hard raw provider-token safety cap (provider total, or
prompt+completion when total is absent). The in-flight response is neither
applied nor verified, the only remaining provider call is the summary, and the
record carries `ok: false`, `terminationReason: "token-budget"`, and the reason
in `loopDiagnostics`; the judge still runs and its fields are recorded as-is.
Budget aborts are run failures, not infrastructure errors: provider failures
keep their own error path and `infraErrors` is untouched. The oc side is
unaffected.

## Replay runner

    bun run benchmark/replay.ts <bundle.json> [--keep]

Replays a recorded bundle (`--replay-dir`, above) through the current loop in a
fresh copy of the bundle's fixture under `tmp/replay/<stamp>/`, with no network
calls. Each bundle replays under the loop mode it was recorded with (`agentMode`) using
edit-dsl. Only edit-dsl bundles are accepted: an old JSON, `compact`, missing, or
unknown `protocolFormat` is rejected. The summary reports the
calls consumed against the recorded count, per-record outcomes and diagnostics,
prompt mismatches against the recorded requests, the termination reason when the
run stopped through the matrix, and where the loop stopped; exit codes: 0 = loop
ok, 1 = loop failed, 2 = usage or IO error. `--keep` leaves the workspace for
inspection (removed otherwise).

Limitation: the recorded responses were produced for the prompts current at
recording time, so the runner validates mechanics (parsing, matching, state
flow) — not model behavior under new prompts.

Token conventions differ between the sides; the report compares them like for
like by normalizing both to a cache-excluded total (cache-miss input + output)
through the shared bucket normalization. USD costs normalize both through the
same rate table and are decision-only.

## What we know, and what we don't

The measured metric set supports three readings:

- **USD per success** per task and overall, from the ledger
  (`results/consumption.md`; denominator rule below).
- **Success counts** (`ok/runs` in each ledger row and report).
- **Token readings**: the dated reports keep the cache-excluded token columns
  (`in`, `out`, `total = in + out`) and a token-multiplier summary; the result
  JSONs keep every per-run raw bucket plus the normalized `tokens.billable`
  triple and its `loop` subtotal (the budget basis). USD stays recorded for
  decisions but is not the headline comparison metric.

Weak spots a reader should not assume away:

- **n = 5 reps per task** (`--reps` default 5; every ledger row) — samples, not
  a distribution; no spread or significance testing.
- **One model** (`deepseek-v4.1-flash`) at the uniform `none` effort policy
  since v2 (the 2026-10-18 effort sweep).
- **Three tuned fixtures** (`json-parser`, `sexp-parser`, `minilisp`) plus the
  held-out `csv-parser`, all with frozen `TASK_SPECS` from `benchmark/specs/`;
  the held-out task gates only generalization claims (#67).
- **A coarse judge**: `tsc --noEmit` + `bun test` + byte-equality of the
  fixture's `src/*.test.ts` and `tsconfig.json`, on the final workspace only;
  any implementation the frozen tests accept passes.
- **Prompt text tuned once against these fixtures** (the #55 pass and revert);
  the regression was caught by a human reading tokens, not by a check.

Tracked residuals from the latest rows (#71 c/d, `2026-10-19-tc-storm71-c/-d`):
sample d is clean — json $0.00190 (3/3), sexp $0.00070 (3/3), minilisp $0.00999
(3/3; 31,330 tokens per success), overall $0.00420 (9/9), under the oc pressure
baseline ($0.00444), with all three storms resolved (23,186 / 27,279 / 43,524)
and the first raw reading under the canonical 13,716 (#49's raw clause, now
closed). Sample c ($0.01122 8/9) carries the one remaining storm shape: a
125,052-token run that ignored its three asks and burned to the bare token
budget — the tracked #65 residual (#60/#71 closed with their mechanisms
verified; c's other storms resolved at 36,219 and 92,208). json/sexp sit far
below their oc targets in both samples; minilisp per success stays above its
target; #66–#69 cover benchmark mechanics.

## Evidence and provenance

A ledger row is comparable only against rows measured on the same fixture text,
model-facing prompt text (`src/loop.ts`), loop config (budgets/caps/effort), and
pricing table; a change to any of those invalidates earlier rows unless they are
re-measured. The #55 regression was caught by hand — #66 tracks making this
mechanical: content hashes of the measured inputs on each result record, plus a
zero-API check that re-derives every `consumption.md` row from its cited source
JSON and flags stale rows.

What `costPerSuccess` counts (computed in `aggregateRuns`, `run.ts`):

- A **run** is one task × side × rep execution, kept in `report.runs` whatever
  its outcome; aggregates use the final records, so reruns never leak in.
- A **success** (`ok`) is a judge pass — tsc, tests, and the fixture's
  `src/*.test.ts` + `tsconfig.json` byte-identical — with no termination-matrix
  ending (tc side); a terminated run is a failure even if the state it left
  judges green.
- **costPerSuccess = summed USD of selected runs that carry a cost (failed runs
  included) ÷ the number of successes**; null when there are none. Tokens per
  success divide the usage-run sums (non-null `tokens.total`) by the same
  success count.
- **Excluded**: runs with no usage add nothing to the token sums and no cost to
  the numerator (their successes still count); provider errors keep their own
  path; `harness-fault` is an ordinary failed run; `infraErrors` are listed and
  force a non-zero exit. Historical rows are converted at off-peak rates; new
  rows price by the run's window and its rate class.

The **durable set** under `results/`: a result file (`<name>.json` plus its
`.md` report) is durable once a `consumption.md` row or an issue cites it as
evidence — keep it (it is that row's source of truth, and belongs in version
control); unreferenced one-off artifacts (superseded variants, one-off smokes,
ad-hoc sweeps) may be pruned. Replay bundles live under `tmp/` and are
prunable by construction. This declaration is the durable set that #66's
ledger check stands on.

### Input provenance hashes (#66)

Every result JSON carries a top-level `provenance` block:

    "provenance": {
      "inputs": { "model": …, "taskIssue": …, "fixture": …, "systemPrompt": …,
                  "loopConfig": …, "pricing": … },
      "inputHash": …,
      "computedAt": "2026-10-19T…"
    }

`src/provenance.ts` computes the sha256 hex digests (`computeInputHashes`,
written by `benchmark/run.ts` via `currentInputHashes` so the record pins the
same tree the runs read). Text pieces are newline-normalized to `\n`; object
pieces go through a stable, recursively key-sorted JSON encoding, so insertion
order never changes a hash. A report keeps the scalar `provenance` block above
with `protocolFormat: "edit-dsl"`; historical scalar reports and legacy
protocol labels stay readable for ledger checks. A multi-mode report
(`--agent-mode pinned-repair,plan-exec`) instead carries
`agentModes: [...]` and a `provenanceByAgentMode` map; the plan-exec block
hashes the planning+execution prompts and the `planExec: "work-dag"` loop
protocol marker, while the pinned-repair block keeps the historical edit-loop
hash. The ledger has no mode column yet, so a multi-mode row is not selected by
`check` until that column lands.

| Digest         | What it covers                                                                                                                                                                                                                                          | Computation point                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `model`        | the gateway model id                                                                                                                                                                                                                                    | `report.model`                                                                        |
| `taskIssue`    | the task spec text of every task in the report, keyed by task                                                                                                                                                                                           | `TASK_SPECS` (`benchmark/specs/<task>.md`)                                            |
| `fixture`      | the on-disk content of `benchmark/fixtures/<task>/`, keyed by task and relative path                                                                                                                                                                    | current tree                                                                          |
| `systemPrompt` | the model-facing system + protocol text (plan-exec hashes planning+execution prompts)                                                                                                                                                                   | `buildSystemPrompt` / task prompts (`src/prompts/edit-dsl.ts`, `src/prompts/task.ts`) |
| `loopConfig`   | token budget, the no-progress ask cadence, `effort`, `reps`, `multiPayload`, and pinned-repair's `scheduling: "token-budget+no-progress"` (no fixed exchange/round caps); plan-exec adds `planExec: "work-dag"` and keeps its historical literal fields | loop constants + run flags                                                            |
| `pricing`      | the peak/off-peak rate table plus `PRICING_FETCHED_ON`                                                                                                                                                                                                  | `src/benchmark-pricing.ts`                                                            |

`inputHash` is sha256 over the stable JSON of that digest object. A change to
the fixture text, the prompt, the loop config, or the pricing table changes the
digests, so earlier rows are explicitly invalidated (the #55 prompt regression
would have been caught mechanically).

`bun benchmark/check.ts` adds a zero-API ledger pass: for each `## Rows` entry
of `results/consumption.md` it re-derives the per-task and overall
`costPerSuccess` and the `ok/runs` counts from the cited source JSON (rounding
to five decimals) and **fails**, naming the row, on any mismatch or a missing
cited file. A row with a `Protocol` column re-derives only that tc variant's
runs from a multi-variant report and uses the matching `provenanceByProtocol`
block; a legacy table without the column keeps the old pooled behavior and
scalar `provenance`. It then compares each source's recorded provenance against a
fresh `currentInputHashes` from the tree and prints a `stale:` line for rows
whose hashes differ or that carry no `provenance` (historical rows predating
#66) — stale is a warning, not a failure. `--ledger <path>` points the pass at
another copy (used to prove a corrupted row fails). Cross-side baselines live in
a separate table and are not row-checked (they are means/minima across files,
not single-JSON rows).
