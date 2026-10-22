---
id: 24
title: "Offer a valid fallback after repeated edit-dsl address failures"
status: done
priority: medium
milestone: null
parent: 22
deps: [23]
labels: [agent-loop, edit-protocol]
created: 2026-10-22
---

## Context

When edit-dsl address resolution fails, the retry prompt repeats the address
diagnostic plus the whole current source. In the 2026-10-22 `minilisp` tc runs,
the model repeatedly sent an invalid variable kind, then emitted protocol
errors (missing `end`, unparseable matcher, no-op), and never switched to a raw
`write`. The run consumed 121,272 and 120,729 provider tokens against the
120,000 budget.

The model eventually wrote a usable fallback into its own final summary
("use a raw `write src/lisp.ts with … done`"), but by then the budget was
exhausted. The loop needs to offer that concrete recovery earlier.

## Goal

After repeated address failures, give the model a valid, concrete recovery
action so an unaddressable target cannot loop until the token budget is
exhausted.

## Acceptance criteria

- [ ] A repeated address failure produces a retry lead naming a valid bare
      `select <name>` or raw `write <path> with … done` fallback.
- [ ] The fallback is derived from the live index/diagnostic, not a hardcoded
      target name.
- [ ] A scripted loop test reproduces the kind-mismatch address loop and
      asserts recovery through the fallback without a token-budget
      termination.
- [ ] Existing address/protocol rejection messages remain unchanged when no
      fallback applies.
- [ ] `just typecheck && just test` pass.

## Verification

```sh
just typecheck
just test
```

The regression test should assert both recovery and the absence of a
`token-budget` termination on the scripted run.

## Notes

Depends on #23 so the fallback vocabulary matches the normalized variable
kinds. Local function/block scope targets are out of scope; use the bare-select
or raw-write path rather than expanding the index here.
- Implemented the repeated-address fallback. The edit-dsl loop now counts address rejections since the last applied edit (independent of the same-cause streak, so an address/protocol alternation cannot hide them). After the second address failure, `rejectionLead` emits a live-target escape derived from the failing locator: a bare `select <name> in <path>` omitting the kind, plus a raw `write <path> with ----- … ----- done` whole-file repair. The undeclared-name create/add-path wording and JSON protocol stay unchanged. Selection retries fold the fallback into the prompt; content retries carry it as the correction lead. Added a unit test with a non-hardcoded path/name and a scripted loop test (two wrong-kind selects, then bare select/edit) asserting recovery and no token-budget termination. Verified: `just typecheck`; `just test` (1237 pass, 0 fail); `just accept --all` (8/8 pass).
