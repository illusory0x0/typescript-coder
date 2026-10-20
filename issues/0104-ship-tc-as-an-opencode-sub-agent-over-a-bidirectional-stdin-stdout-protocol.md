---
id: 104
title: "Ship tc as an opencode sub-agent over a bidirectional stdin/stdout protocol"
status: todo
priority: medium
milestone: null
parent: null
deps: []
labels: [cli, integration]
created: 2026-10-20
---

## Context

`tc` is a **one-shot** CLI: `src/main.ts:189` reads stdin **to EOF**, runs one
loop, emits exactly one `typescript-coder-result@1` object on stdout, and
`process.exit()`s. There is no message framing, no per-message response, and no
persistent session — so a main agent cannot "send a message, get a reply, send
another".

Empirical probe (2026-10-20, real `tc` run in a sandbox, stdin held open):

| step | observed |
| --- | --- |
| message 1 sent, stdin open | stdout **0** bytes, stderr **0** bytes (waited 4 s) |
| message 2 sent, stdin still open | still **0** bytes (waited 4 s more) |
| EOF sent | one `typescript-coder-result@1` (`verified:true`), exit 0 — the sandbox edit was applied |
| write after exit | no error, **no reply** (dead pipe; process already gone) |

So the current CLI supports **one-shot delegation only**; a main agent can only
make repeated independent calls (stateless — full context re-sent each turn,
though on-disk keep-progress survives). Bidirectional `stdin`/`stdout`
coordination needs a new **persistent interactive mode**.

What already exists: the one-shot contract (`docs/subagent.md`: `--format json`,
`--targets`, result schema, retry recipe), a scripted+live acceptance harness
(`acceptance/run.ts`), and the loop internals (`docs/spec.md` §6 /
`docs/design.md` §3.2). Missing: any `opencode`-side registration/bridge and any
interactive protocol.

## Goal

An `oc` (opencode) main agent can coordinate with `tc` as a sub-agent
**bidirectionally over stdin/stdout** — repeatedly send instructions on one live
process and receive a response per instruction — with the readiness criteria
recorded and demonstrated.

## Acceptance criteria

- [ ] A persistent interactive mode exists (e.g. `tc --serve`) that keeps one
      process alive and speaks a **line-delimited JSON** request/response
      protocol over stdin/stdout: one request per line → exactly one
      `typescript-coder-result@1` response line, looping until EOF or an explicit
      shutdown; stdout carries only responses (diagnostics/progress to stderr).
- [ ] The request schema covers what a planner sends per turn — issue text,
      `cwd`, `--targets` addresses, token budget, check/test commands — and the
      response reuses the existing result contract, so one-shot and interactive
      share the result format.
- [ ] Empirical e2e: a main agent drives the process with **≥2 successive
      messages** and receives a response to each (a real scoped edit reporting
      `verified:true`, then a second instruction), with the transcript and the
      resulting diff recorded as evidence.
- [ ] Multi-turn / state semantics are defined and demonstrated:
      stateless-per-call vs. on-disk keep-progress (no rollback), how a retry
      after `verified:false` is issued, and that the process survives a failed
      turn.
- [ ] The maturity bar is recorded (verification trust, per-call and total
      token+cost bound, provider/credential requirements via `OPENAI_API_KEY` /
      `OPENAI_BASE_URL`, known limits) plus a **go/no-go** for opencode
      delegating to `tc` in this mode.
- [ ] Backward compatibility: the existing one-shot invocation
      (`tc … < task.txt`, default `text` and `--format json`) is unchanged;
      `bun test`, `bun run accept`, and `benchmark/check.ts` stay green.

## Verification

```
bunx tsc --noEmit
bun test
bun run accept
# the milestone's own evidence:
#   - a transcript showing >=2 request lines in and >=2 result lines out, same process
#   - the resulting `verified:true` result(s) and the reviewed diff
```

## Notes

- Filed 2026-10-20 from the roadmap question "when is `tc` mature enough to be
  called by `opencode` as a sub-agent?"; the probe above (stdin held open → 0
  bytes until EOF) is the motivating evidence.
- Design sketch: a `--serve` (or `--interactive`) flag reading one JSON object
  per line, reusing `runMain`/`runLoop` per request and keeping the process alive
  across turns. Decide the exact framing (JSON-lines vs length-prefixed) during
  the work and record it.
- Open question: where the `opencode`-side registration/bridge lives — the
  `opencode` project's own config, or shipped by `tc` as an example agent
  definition + plugin.
- Non-goals: changing the one-shot contract, making `tc` stateful beyond on-disk
  keep-progress, or weakening verification ownership.
- Related: `docs/subagent.md` (one-shot contract), `acceptance/` (harness), and
  the reliability/cost umbrellas (#46).
