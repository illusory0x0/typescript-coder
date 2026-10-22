---
id: 24
title: "Offer a valid fallback after repeated edit-dsl address failures"
status: todo
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
