---
id: 64
title: "Study opencode2 context management (e.g. compaction) for absorption candidates"
status: done
priority: low
milestone: null
parent: null
deps: []
labels: [harness]
created: 2026-10-19
---

## Context

User directive (2026-10-19, low priority): study opencode2's context
relationships/management — e.g. its Compaction pipeline — and distill concrete
absorption candidates for the tc harness.

#57 already absorbed one compaction-derived idea (a bounded attempt digest /
updated checkpoint for continued repair rounds). The wider context pipeline has
not been surveyed: context assembly order, compaction trigger conditions and
thresholds, checkpoint generation and update-in-place semantics, the shrink
ladder on repeated provider overflow, and the discard rules for older messages.

## Goal

A written study of opencode2's context management (with file/line citations)
and a ranked shortlist of absorption candidates, each scoped to a concrete
follow-up (an existing issue ref or a new issue to be filed).

## Acceptance criteria

- [ ] Study notes in this issue's Notes cover at least: context assembly order
      (system / pinned / verbatim tail), compaction trigger conditions and
      thresholds, checkpoint generation and update-in-place semantics, the
      shrink ladder on repeated provider overflow, and the discard rules for
      older messages — each claim carrying an opencode2 file/line citation.
- [ ] A ranked absorption shortlist: every candidate names its expected effect
      (context size / storm mitigation / failure-mode coverage), its cost, and
      its target (an existing issue ref or a new issue to file).
- [ ] Findings only: no harness code changes land under this issue.
- [ ] Tracker `check` passes.

## Verification

Review the notes and the shortlist in this issue: every opencode2 claim cites
a file/line, every candidate maps to an issue ref, and no code diff is
attributable to this issue. `bun .opencode/scripts/issue-tracker.ts check`
is green.

## Notes

- Low priority by user directive (2026-10-19); filed 2026-10-19.
- Related: #57 (compaction-derived digest already landed), #49 (context audit
  and cut, tc side), #46 (v3 batch — this study deliberately does not gate it).
- Reference sources from the 2026-10-18 opencode2 study:
  `packages/core/src/session/compaction.ts` and `runner/llm.ts` (see #57's
  context for exact ranges), plus whatever else the survey finds.
- Assumption: filed as a root issue (no parent) so the v3 close-out (#46) is
  not gated on this low-priority study; re-parent on request.
- Consult (2026-10-19, oc survey A-group triage): A4 (compaction trim/discard
  rules) and A5 (overflow/truncation recovery — the shrink ladder is already
  in the Context list) are absorbed into this study's scope. A3 (bounded
  trajectory) is absorbed into this study's scope too (user decision
  2026-10-19, after the #71 c/d matrices landed).

### Study (2026-10-19, opencode2 / opencode tree
`a1f590a`)


Findings only. No harness code changed under this issue.

Method: surveyed the opencode2 source tree at
`/home/illu/repo/opencode`, revision
`a1f590a` (`a1f590a2748d171e4740abd68c5649a2e23d2f7d`, 2026-10-18), by reading
`packages/core/src/session/{compaction,context,history,model-request,provider-context,instruction-state,message-updater,projector}.ts`,
`packages/core/src/session/runner/{llm,step,to-llm-message}.ts`,
`packages/schema/src/config/compaction.ts`, and the compaction
protocols under `packages/ai/src/{provider-error,protocols}`. The tc side
(`src/loop.ts`) was read only to ground the shortlist. All opencode2 citations
are `path:line` or `path:start-end` in that revision.

Terminology note: opencode2 has no "pinned selection" concept. The issue's
"pinned" maps, in opencode2, to (a) the per-request instruction **epoch
baseline** that is always rendered into the system block, and (b) the **latest
completed checkpoint** that is pinned as the first history message. This study
notes both.

---

## Study notes

### 1. Context assembly order (system / pinned / verbatim tail)

**System block.** Every primary and compaction request is built by
`baseTranscript`, which emits the system parts in a fixed order:
`[agent.system ?? SessionSystemPrompt.make(...), initial]`, dropping empty
parts (`packages/core/src/session/model-request.ts:100-120`). `initial` is the
instruction epoch baseline, defined as "the epoch baseline shown at the start of
every model request" and re-rendered from the stored epoch values
(`packages/core/src/session/instruction-state.ts:164-174`). The instruction
source list itself is ordered most-shared → least-shared so the shared prefix
stays a reusable prompt-cache prefix: code-mode catalog, MCP, references,
skills, discovery, built-ins, then per-session entries
(`packages/core/src/session/context.ts:144-158`).

**Pinned baseline / inline instruction updates.** The epoch baseline is
advanced (pinned forward) whenever a compaction completes:
`InstructionState.advanceEpoch` sets `epoch_start = through_seq = seq` and
freezes `initial_values = current_values`
(`packages/core/src/session/instruction-state.ts:139-154`), invoked from the
projector on `session.compaction.ended`
(`packages/core/src/session/projector.ts:730-735`). Instruction deltas after the
baseline are carried as inline `system` history messages
(`packages/core/src/session/runner/to-llm-message.ts:291-292`) and are dropped
from a read when they precede the latest native checkpoint (see §5).

**Checkpoint pinned first.** History always loads from the latest completed
compaction boundary: `latestCompaction` selects the newest completed compaction
row under the provenance boundary (`packages/core/src/session/history.ts:28-60`)
and `messageEntries` starts the ascending scan at that row's `seq`
(`packages/core/src/session/history.ts:78-108`). The loaded first message is
therefore the checkpoint; `previousCompaction` asserts exactly that ("a
previous one is always the first message",
`packages/core/src/session/compaction.ts:689-693`). A textual checkpoint is
rendered as a single `user` message with the wrappers
`<conversation-checkpoint>`, `<summary>`, and `<recent-context>`
(`packages/core/src/session/runner/to-llm-message.ts:306-325`).

**Verbatim tail.** Compaction keeps the newest messages within `keep` tokens
verbatim *beside* the summary. `Settings.keep` defaults to `15_000` tokens
(`packages/core/src/session/compaction.ts:195-197`; schema
`packages/schema/src/config/compaction.ts:6-14`; config wiring
`packages/core/src/config/plugin/compaction.ts:15-24`). `splitConversation`
splits into `older` (to summarize) and `recent` (kept verbatim as text), and
`recentStart` walks newest→oldest, always keeping the newest entry and dropping
oldest until the `keep` allowance fits
(`packages/core/src/session/compaction.ts:704-744`). The `keep` allowance is
enforced with per-entry token estimates and a +1 separator
(`packages/core/src/session/compaction.ts:728-731`).

So the effective per-request order is: **system =
[role/system prompt, instruction baseline] → first message = pinned
checkpoint (`summary` + `recent-context`) → newer history → newest exchange**,
with `keep` tokens of the newest messages preserved verbatim inside the
checkpoint's `recent` field.

### 2. Compaction trigger conditions and thresholds

**Automatic vs manual gate.** `compact` skips every non-manual trigger when
`settings.auto` is false ("Only the user compacts when automatic compaction is
off, overflow included"); an `auto` trigger additionally requires `due(...)`
(`packages/core/src/session/compaction.ts:205-212`). `auto` defaults to true
(`packages/core/src/session/compaction.ts:195-197`) and is configurable
(`packages/core/src/config/plugin/compaction.ts:19`).

**`due` predicate.** Auto compaction fires when the estimated context reaches
the ceiling, but it *skips* in two cases: (a) the last message is already a
completed compaction ("A compaction just completed; let the runner rebuild the
request from it first"), and (b) no provider-measured prompt exists after the
latest checkpoint ("An encrypted native window estimates as nothing, so wait for
a response to measure it") (`packages/core/src/session/compaction.ts:242-251`).
The estimate is anchored to the newest same-provider assistant message that
reported token usage; only that provider's counts are trusted
(`packages/core/src/session/compaction.ts:874-904`,
`packages/core/src/session/compaction.ts:920-929`).

**Ceiling / reserve.** `calculateCeiling` returns `window − buffer` when a
buffer is configured, else `window − max(floor(window*0.1), RESERVE_MIN)` with
`RESERVE_MIN = 16_000`, keeping 10% (or 16k, whichever is larger) free for the
reply; an unknown window (`window <= 0`) is infinite and never auto-triggers
(`packages/core/src/session/compaction.ts:906-918`,
`packages/core/src/session/compaction.ts:96-99`). When the window is unknown the
compaction request still aims at a `UNKNOWN_WINDOW = 200_000` fallback
(`packages/core/src/session/compaction.ts:99`, `packages/core/src/session/compaction.ts:222-225`).

**Overflow trigger.** `Trigger` distinguishes `auto`, `overflow` (the provider
just rejected the context), and `manual` (`/compact`)
(`packages/core/src/session/compaction.ts:53-57`). The runner calls
`compaction.compact({reason:"auto", ...})` before every step
(`packages/core/src/session/runner/llm.ts:220-225`), and passes a
`recoverOverflow` effect that runs `compact({reason:"overflow"})` only after a
provider rejection and only if no output has started
(`packages/core/src/session/runner/llm.ts:264-271`,
`packages/core/src/session/runner/step.ts:155-167`). `overflow` is identified by
the typed classification `context-overflow`, never by pattern-matching text at
the call site (`packages/ai/src/provider-error.ts:72-75`), with the underlying
classification assigned in `packages/ai/src/provider-error.ts:252-258`.

### 3. Checkpoint generation and update-in-place semantics

**Summary shape.** The summary template forces fixed headings (Objective,
Requirements, Decisions, Work State {Completed/Active/Blocked}, Next Move,
Relevant Files, Important Context) and terse bullets
(`packages/core/src/session/compaction.ts:104-143`). The prompt explicitly tells
the model to omit setup the next agent receives separately (AGENTS.md,
environment), and to preserve exact paths/symbols/commands
(`packages/core/src/session/compaction.ts:145-152`).

**First vs update.** `buildPrompt(update, legacy)` branches: a first compaction
says "summarize the conversation above", while an update says "Update the
existing checkpoint in the conversation above into one consolidated summary"
and "Newer history always takes precedence over the existing checkpoint.
Preserve previous information unless newer history clearly contradicts,
supersedes, resolves, or makes it stale"
(`packages/core/src/session/compaction.ts:145-176`). Whether this is an update
is chosen by `previous !== undefined` from `previousCompaction(context.messages)`
(`packages/core/src/session/compaction.ts:281-282`,
`packages/core/src/session/compaction.ts:689-693`).

**One nudge, then failure.** A reply that fails to fill any template heading
gets exactly one `NUDGE` retry before the compaction fails with
`compaction.failed` (`packages/core/src/session/compaction.ts:178-179`,
`packages/core/src/session/compaction.ts:289-315`).

**Update-in-place on the message row.** `session.compaction.started` appends a
`running` compaction message (`packages/core/src/session/message-updater.ts:413-425`);
`session.compaction.ended` finds the current running compaction and *updates it
in place* to `completed` (status, summary=text, recent, providerContext,
model, cost, tokens), and only appends a fresh completed message when no
running one exists (`packages/core/src/session/message-updater.ts:426-462`).
Completing also advances the instruction epoch so the baseline supersedes the
chronological updates before it (`packages/core/src/session/projector.ts:730-735`).
The update prompt notes a one-time legacy rewrite for checkpoints written with
the old "Additional Context" template
(`packages/core/src/session/compaction.ts:160-182`).

**Native (provider-side) checkpoints** are a separate path: "a native
compaction fills `providerContext`" (`packages/core/src/session/compaction.ts:71-80`),
and an endpoint compaction must return exactly one encrypted checkpoint
(`packages/ai/src/protocols/utils/responses-compaction.ts:145-153`) or exactly
one trigger checkpoint (`packages/ai/src/protocols/utils/responses-checkpoint.ts:96-108`);
a trigger checkpoint cannot change after completion
(`packages/ai/src/protocols/utils/responses-checkpoint.ts:47-51`).

### 4. Shrink ladder on repeated provider overflow

**The ladder.** `SHRINK_STEPS = [0.7, 0.5, 0.35]`: after each "too long"
rejection the next attempt aims at that share of the first rejected request's
size (`packages/core/src/session/compaction.ts:94-95`). The first overflow
attempt already aims below the estimate
(`Math.floor(estimateContext(context) * SHRINK_STEPS[0])`,
`packages/core/src/session/compaction.ts:226-228`).

**The loop.** `deliver` repeatedly: (a) send as-is if the estimate fits
`target`; (b) otherwise flatten-and-drop oldest exchanges toward `target`; (c) on
`payload-too-large` for the unchanged request, resend once as media-free text
without counting a rejection; (d) on `payload-too-large` or a context-overflow
failure, take the next `SHRINK_STEPS` value and retry; when the ladder is
exhausted (`SHRINK_STEPS[rejections] === undefined`) fail with the provider
error; (e) any other error goes through the session retry policy
(`packages/core/src/session/compaction.ts:390-461`). The failure text is fixed:
"cannot be reduced further without losing the latest exchange or checkpoint"
(`packages/core/src/session/compaction.ts:419-427`).

**Runner-side guard.** After one successful compaction, the runner sets
`recoverOverflow = false` on the `Compacted` outcome so a subsequent overflow in
the same step does not compact again
(`packages/core/src/session/runner/llm.ts:320-323`), and the attempt refuses to
recover once output has started (`packages/core/src/session/runner/step.ts:155-167`).

### 5. Discard rules for older messages

**Keep-newest allowance.** The verbatim tail drops oldest entries until the
`keep` budget fits, always keeping the newest one, and starts the tail at a
user-message boundary so an assistant's tool calls/results stay together
(`packages/core/src/session/compaction.ts:727-744`). With a single exchange and
no room, it summarizes everything and keeps nothing unless a previous summary
already kept recent text (`packages/core/src/session/compaction.ts:737-744`).

**Whole-exchange discard.** `flattenAndDropOldest` groups the request into
exchanges (a user message and everything up to the next user message), keeps or
drops each *whole*, always re-emits the previous summary in front, and drops
oldest-first with an `[N older exchanges omitted]` note; it returns undefined
when even the newest exchange cannot fit
(`packages/core/src/session/compaction.ts:463-510`). The room calculation
reserves space for the longest possible omitted-note before choosing what to
keep (`packages/core/src/session/compaction.ts:498-505`).

**What the flattened view leaves out.** The transcript form (`messageToText`)
omits compaction and system messages, drops background shell output, and
truncates tool output to `TOOL_OUTPUT_MAX_CHARS = 1_250`
(`packages/core/src/session/compaction.ts:100`, `packages/core/src/session/compaction.ts:758-826`).
The request-flattening form (`flattenMessage`) drops system messages and
replaces media with `[<mime> omitted]`
(`packages/core/src/session/compaction.ts:828-849`). `recentUserMessages` keeps
only whole, real user messages (no synthetic guidance, no half attachments)
within `keep` (`packages/core/src/session/compaction.ts:859-872`).

**History-level discard.** A read honors a boundary: local summaries always
bound a history, native windows bound only model-neutral readers (`latest`) and
only when the target model can replay them
(`packages/core/src/session/history.ts:16-26`,
`packages/core/src/session/history.ts:28-60`). `messageEntries` also filters out
`system` (instruction-update) messages that precede the latest native
checkpoint, because completing the native checkpoint already advanced the
instruction epoch: "the baseline supersedes the chronological updates before it"
(`packages/core/src/session/history.ts:99-107`).

---

## Ranked absorption shortlist

Each candidate states expected effect (context size / storm mitigation /
failure-mode coverage), cost, and target. Cost assumes the tc harness only
(`src/loop.ts`), measured on the existing benchmark.

1. **Structured, update-in-place checkpoint replacing the causal attempt
   list.**
   - Basis: opencode2's fixed-heading summary that is *updated*, not regenerated
     (`compaction.ts:145-176`), persisted by mutating the running row
     (`message-updater.ts:426-462`) and pinned first (`history.ts:28-108`).
   - Effect: storm mitigation (Work State / Next Move / "ruled out" guidance
     changes the model's next attempt rather than only reporting cause counts)
     plus context size (bounded sections instead of an append-only cause list).
   - Cost: medium — extend the #57 digest into the template; prompt + tests;
     re-measure the storm matrix.
   - Target: **#65** (open; rejection/verification-cycle storms).

2. **Carry the newest exchange verbatim beside the digest (`recent-context`
   analogue).**
   - Basis: the checkpoint stores the newest `keep` tokens verbatim next to the
     summary and omits only the older part
     (`compaction.ts:704-744`, `to-llm-message.ts:311-325`).
   - Effect: storm mitigation + failure-mode coverage (the model can see the
     exact last diagnostics/attempt it is iterating on instead of re-deriving
     them from a one-line digest).
   - Cost: low — render the newest record's diagnostics tail (already capped by
     `DIAGNOSTICS_LIMIT = 4_000`) into continuation prompts; tests.
   - Target: new issue: "Carry the newest exchange verbatim beside the attempt digest".

3. **Graded shrink ladder for context that must be reduced.**
   - Basis: `SHRINK_STEPS = [0.7, 0.5, 0.35]`, dropping whole oldest exchanges
     and failing only at the floor
     (`compaction.ts:94-95`, `compaction.ts:441-447`, `compaction.ts:463-510`).
   - Effect: context size + failure-mode coverage (a deterministic geometric
     target instead of a single hand-tuned budget, with a defined give-up).
   - Cost: medium — a target-size function for continuation context plus tests;
     must not regress json/sexp happy paths.
   - Target: new issue: "Repair-context shrink ladder on repeated rejection".

4. **Anchor context-size decisions to provider-reported usage; skip when a
   checkpoint just landed.**
   - Basis: `due` waits for a provider-measured prompt after the latest
     checkpoint and explicitly skips immediately after a completed compaction
     (`compaction.ts:242-251`, `compaction.ts:920-929`).
   - Effect: context size + failure-mode coverage (no digest/trim thrash on
     every round; decisions based on measured tokens, not character estimates —
     tc already reads `total_tokens` at `loop.ts:1333-1354` but only for the
     budget).
   - Cost: low-medium — thread measured usage into one trigger predicate; tests.
   - Target: new issue: "Anchor harness context-size decisions to provider-reported usage".

5. **Classify provider context-overflow / payload-too-large and recover, not
   fail.**
   - Basis: typed `context-overflow` / `payload-too-large` classifications and
     the recover path, distinct from retryable errors
     (`ai/src/provider-error.ts:66-75`, `ai/src/provider-error.ts:252-258`,
     `compaction.ts:434-458`).
   - Effect: failure-mode coverage (tc currently has no context-overflow path at
     all; a provider "too long" reply ends the run).
   - Cost: medium — a classification branch in `src/openai.ts` plus a harness
     recovery path.
   - Target: new issue (sibling of **#74**, the provider retry family):
     "Classify provider context-overflow and payload-too-large separately from terminal errors".

6. **Bound output-limit continuations to a three-strike.**
   - Basis: the runner counts the last three settled messages and, if all are
     assistant `length` finishes, fails instead of continuing again
     (`runner/llm.ts:290-319`).
   - Effect: failure-mode coverage (a repeatedly truncated reply ends through a
     defined summary/stop path rather than burning budget).
   - Cost: low — count consecutive `finish_reason == "length"` replies in
     `records` and terminate.
   - Target: new issue (sibling of **#74**): "Bound output-limit continuations to a three-strike".

### Mapping recap

| # | Target | Effect focus |
|---|--------|--------------|
| 1 | #65 | storm mitigation + context size |
| 2 | new issue | storm mitigation + failure-mode coverage |
| 3 | new issue | context size + failure-mode coverage |
| 4 | new issue | context size + failure-mode coverage |
| 5 | new issue (sibling of #74) | failure-mode coverage |
| 6 | new issue (sibling of #74) | failure-mode coverage |

No harness code changes are attributable to this issue; this file is the only
artifact.
