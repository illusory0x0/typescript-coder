# Glossary — harness loop terminology

Core flow vocabulary for the v2 loop redesign: **three terms** — Run / Edit /
Verification. The old loop names (turn / selection / correction / attempt) are
folded into them — see [Folded terms](#folded-terms).

Design only: `src/` and `spec.md` still use the old shape; do not assume these
terms exist in code yet.

## Core flow

```
Run (运行) — top-level agent loop
└─ loop:
     Edit (编辑)          micro agent loop, ≤3
     Verification (验证)   tsc + test
```

| Term | 中文 | Definition | Budget |
|---|---|---|---|
| **Run** | 运行 | Top-level agent loop: repeats Edit → Verification until the task succeeds or the token budget runs out. | token budget (120k); no iteration cap |
| **Edit** | 编辑 | Micro agent loop: model exchanges until one valid edit is produced and applied (pick target, write payload, fix matcher, pass the syntax gate). The first round picks the target; afterwards the target is fixed and revisions touch content only. | ≤3 exchanges per Run iteration, shared by target-picking and content revision (no separate selection budget); exhausted without a valid edit → the whole Run ends (LLM writes a summary first) |
| **Verification** | 验证 | tsc + test gate (no model exchange). | pass → done; fail → Run enters its next iteration |

## Folded terms

The old names are not separate terms; each is just part of the flow above:

- **Turn** → one model exchange inside the Edit loop.
- **Selection** → the first round(s) of the Edit loop (picking mode + address).
- **Correction** → a re-ask inside the Edit loop after a soft failure
  (protocol / address / matcher / gate / format); consumes the same ≤3.
- **Attempt** → one iteration of the Run loop.
- **Anchor / Locator** → merged into one payload: the old locator is the
  address, the old anchor is the optional `matcher`.

## Notes

- **Edit shape**: one flat payload `{path, symbol, kind, matcher, replacement}`
  per edit; `path × symbol × kind` is the address, `matcher` locates the range
  inside the symbol (omitted ⇒ whole-symbol rewrite). One matcher per edit —
  multiple changes happen across Edit rounds (the old `edits[]` batch is gone).
- **Syntax-preservation** (highest-priority invariant): the syntax gate rejects
  an edit whose `after` fails to parse — the splice is discarded, nothing is
  written. A broken `prev` ends the Run.
- **delete special case**: Edit only picks the target (selected → deleted); a
  deletion that fails Verification ends the Run.
- **Failure summaries**: when a Run ends in failure, the LLM writes the summary
  as the final action; the outer layer (CLI / benchmark runner) commits it into
  `failures/` in this repo — the harness itself does not.
