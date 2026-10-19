# Glossary — harness loop terminology

Core flow vocabulary for the v2 loop redesign: **three terms** — Run / Edit /
Verification. The old loop names (turn / selection / correction / attempt) are
folded into them — see [Folded terms](#folded-terms).

## Core flow

```
Run (运行) — top-level agent loop
└─ loop:
     Edit (编辑)          micro agent loop, ≤3
     Verification (验证)   tsc + test
```

| Term | 中文 | Definition | Budget |
|---|---|---|---|
| **Run** | 运行 | Top-level agent loop: repeats Edit → Verification until the task succeeds or the run terminates (token budget, the model's `STOP`, or the 32-iteration cap). | token budget (120k); ≤32 Run iterations (#52), then the run ends |
| **Edit** | 编辑 | Micro agent loop: model exchanges until one valid edit is produced and applied (pick target, write payload, fix matcher, pass the syntax gate). The first round picks the target; afterwards revisions touch content only, except that a round opened by failing verification may re-pin to another declaration in the same file (its own {path, symbol, kind}, resolving uniquely in the current source). | ≤3 exchanges per Run iteration, shared by target-picking and content revision (no separate selection budget); exhausted below the 32-iteration cap → a continuation prompt asks the model to reply `STOP` or return a corrected edit/selection for a fresh round; at the cap the whole Run ends (LLM writes a summary first) |
| **Verification** | 验证 | tsc + test gate (no model exchange). | pass → done; fail → Run enters its next iteration |

## Folded terms

The old names are not separate terms; each is just part of the flow above:

- **Turn** → one model exchange inside the Edit loop.
- **Selection** → the first round(s) of the Edit loop (picking mode + address).
- **Correction** → a re-ask inside the Edit loop after a soft failure
  (protocol / address / echo / matcher / no-op / repeat / duplicate / gate /
  format / truncated); consumes the same ≤3.
- **Attempt** → one iteration of the Run loop.
- **Anchor / Locator** → merged into one payload: the old locator is the
  address, the old anchor is the optional `matcher`.
- **Multi-payload batch (#69)** → an opt-in `modify` reply shape
  (`{"payloads":[…]}`) carrying several **path-independent** edits, one per file,
  applied atomically in one exchange; off by default.

## Notes

- **Continuation (#52)**: a round that exhausts its ≤3 exchanges below the
  32-iteration cap opens the next round with a continuation prompt; that prompt
  offers `STOP` (the no-progress ask below does too), whose reply is recorded as
  the `stopped` exchange outcome and ends the run through the termination matrix
  (LLM summary last).
- **No-progress ask (#54/#60)**: a round that opens after `MAX_STALLED_ROUNDS`
  (8) consecutive no-progress rounds — failed verifications and rounds that end
  with no applied edit (rejection-exhausted, truncated, or spent picking) both
  advance the run-scope streak — starts with the no-progress framing
  instead of the ordinary exchange header — the consecutive-failed-round count,
  the current round (N of 32), `STOP` to end the run (only when the failures
  cannot be resolved), and concrete alternatives (change the matcher shape,
  re-pin to a declaration the diagnostics name, restructure the declaration) —
  keeping the retry shape (pinned selection, current source, diagnostics, JSON
  payload). It recurs at every further multiple of 8. A #52 continuation round
  keeps its own framing, except that the continuation directly following a
  milestone round carries the ask instead (how rejection-exhausted cycles,
  whose every round is a continuation, reach the decision point); a selection
  continuation keeps its own `STOP` framing.
- **Stalled stop (#54)**: a `STOP` reply to the no-progress ask (its first
  exchange only, trimmed and case-insensitive) ends the run through the
  termination matrix (`edit-exhausted`), recorded as a `stopped` exchange row
  whose diagnostics name the consecutive failed rounds; any other reply is
  processed as a normal first exchange, guards first (an identical resend is
  `stage: repeat`).
- **Attempt digest (#57)**: the #52 round-continuation prompts (edit and
  selection variants) and the #54 no-progress ask append a bounded `Prior
  attempts` checkpoint after the diagnostics: one line per failed attempt
  `- #<n> <class>: <first informative diagnostics line>`, where the class is the
  #56 rejection cause (or the `tsc`/`tests` verification outcome) and only the
  chosen line enters it — never a code frame or a raw replacement. It is built
  incrementally from the record rows beyond a run-scope cursor, so a later
  continuation keeps the earlier lines and raises the counts. The text is capped
  at 1,200 characters: the header, the omitted-entries line, and the ruled-out
  block are reserved first, then the oldest entries are evicted with the omitted
  count kept accurate while the per-class counts still span every attempt. A
  class repeated ≥3 times adds a `Ruled out after <n> repeats: <class> —
  <action>` line (count desc, then name), reusing the #56 escalation text for
  rejection causes and a fixed sentence for `tsc`/`tests` (change the
  declaration structure instead of re-editing the same spot). Ordinary retries
  carry no digest.
- **Failure history (#71)**: a bounded note in the retry/continuation prompts
  when the trailing verification failures are not converging — the same
  fingerprint across ≥3 consecutive rounds, or a strict ABAB cycle over ≥4 —
  naming the unchanged failing set or the two cycling states (clamped,
  diagnostics only). It rides ordinary retries, #52 continuations and the #54
  ask; a passing verification resets the chain.
- **Rejection policy (#56/#65)**: every soft failure is classified into a typed
  cause — `protocol`, `echo`, `address`, the three matcher sub-causes
  (`matcher-unparseable`, `matcher-not-found`, `matcher-ambiguous`), `no-op`,
  `repeat`,
  `duplicate`, `gate`, `format`, `truncated` — carried on the record row; the
  re-ask's lead sentence is that cause's concrete correction instead of the
  generic "make minimal corrective changes". Consecutive same-cause rejections
  accumulate in a run-scope streak that spans rounds and #52 continuations,
  resets only on an applied edit, and from the second one adds the cause's
  escalation (matcher causes: this attempt MUST omit `matcher` and return the
  complete declaration). `repeat`/`duplicate` state that the file already
  reflects the submission — the change is in place or the rejection stands, or
  the declaration already exists — so a resend cannot change anything and the
  next attempt must differ in target, matcher, or replacement (the rejected
  replacement text is never re-echoed). `no-op` states that the intended change
  is already in the file and points at the round's pending failures. An
  `address` rejection naming a symbol the current source does not declare keeps
  the add path open — the declaration must ride inside the replacement of an
  address that resolves, and mode `create` applies only while the run is still
  choosing a target — without weakening the address guard. The
  #54 no-progress ask still wins when both would apply.
- **Harness fault (#56)**: a `format` rejection whose formatter message carries
  the duplicate-modifier signature (`'export' modifier already seen`) means the
  harness built an invalid edit candidate, not that the model erred. The
  rejection row is recorded and the run exits through the termination matrix as
  `harness-fault` with the full diagnostics and exactly one summary call — it
  is never retried.
- **Edit shape**: one flat payload `{path, symbol, kind, matcher, replacement}`
  per edit; `path × symbol × kind` is the address, `matcher` locates the range
  inside the symbol (a statement, member, expression, or contiguous statement
  run; omitted ⇒ whole-symbol rewrite). One matcher per edit —
  multiple changes happen across Edit rounds (the old `edits[]` batch is gone).
- **Syntax-preservation** (highest-priority invariant): the syntax gate rejects
  an edit whose `after` fails to parse — the splice is discarded, nothing is
  written. A broken `prev` ends the Run.
- **delete special case**: Edit only picks the target (selected → deleted); a
  deletion that fails Verification ends the Run.
- **Failure summaries**: when a Run ends in failure, the LLM writes the summary
  as the final action, in the fixed four labeled sections — `Accomplished`,
  `Failed and why`, `Remaining`, `Next step` — so every termination path reads
  the same; the outer layer (CLI / benchmark runner) commits it into
  `failures/` in this repo — the harness itself does not.
