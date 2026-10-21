# Delegating to `tc` — the sub-agent recipe

Audience: an `oc` (opencode) planner that hands scoped coding tasks to
`typescript-coder` (`tc`). This is the contract for one call: what to send,
what comes back, and how to retry. Behavior is defined by `src/cli.ts`,
`src/result.ts`, and `src/main.ts`; the loop internals are in `docs/spec.md`
§6 and `docs/design.md` §3.2.

`tc` is **stateless across calls**: it reads the task from stdin, edits files in
`--cwd`, runs its own verification, and returns one result. Nothing survives the
process, so the caller must put the full context in the task text and re-send
what still matters on a retry.

## When to delegate

- **Delegate to `tc`** a scoped, verifiable source edit with an explicit symbol
  target (or a small set of them): "change the body of `src/foo.ts`
  `parseExpr` so the failing test passes", with `--targets` naming the exact
  `{path, symbol, kind}` addresses.
- **Edit directly** for documentation, config, or any change with no clear
  symbol target, and for one-line mechanical edits where a whole loop call
  costs more than the edit.

## Invocation

```
tc --format json --token-budget <n> --model <id> \
   [--cwd <dir>] [--check <cmd>] [--test <cmd>] [--timeout <ms>] [--targets <file.json>] \
   < task.txt
```

Equivalent without the `bin` entry installed:

```
bun run src/main.ts --format json --token-budget <n> --model <id> … < task.txt
```

| flag | meaning |
| ---- | ------- |
| (stdin) | the free-text task; the only required input. Trimmed; empty ⇒ a failed result, exit 1 |
| `--format <text\|json>` | `text` (default) prints a human line; `json` prints exactly one `typescript-coder-result@1` object on stdout |
| `--model <id>` | OpenAI-compatible model id (default `deepseek-v4.1-flash`) |
| `--token-budget <n>` | hard per-call token cap, a positive integer (default `120000`) |
| `--check <cmd>` | verification command to run after each edit; the value is split on whitespace into argv (default `bunx tsc --noEmit`) |
| `--test <cmd>` | test command to run after each edit; whitespace-split (default `bun test`) |
| `--cwd <dir>` | workspace root for the run (default the process cwd) |
| `--timeout <ms>` | timeout in milliseconds for each `--check`/`--test` command, a positive integer (default `120000`) |
| `--targets <file>` | explicit address list (JSON file, see below); absent ⇒ `tc`'s own model-driven selection |
| `--multi-payload` | opt in to the `{"payloads":[…]}` batch reply on the discovery path; already implied by `--targets` |
| `-h`, `--help` | print help and exit 0 |

Credentials come from the environment: `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

## Task text (stdin)

Free text, the `oc`-authored issue. Because `tc` keeps no state, include what a
fresh engineer would need: the files and symbols in play, the intent, the
constraints, and the failing signal. `--targets` fixes the addresses; the task
text still says what to change about them.

## Targets file

`--targets <file.json>` takes either shape — a top-level array or an object with
a `targets` array:

```json
[
  { "path": "src/a.ts", "symbol": "Alpha", "kind": "function" },
  { "path": "src/b.ts", "symbol": "Beta",  "kind": "class" }
]
```

```json
{ "targets": [ { "path": "src/a.ts", "symbol": "Alpha", "kind": "function" } ] }
```

Every entry is an object with non-empty string `path`, `symbol`, and `kind`; a
missing file, invalid JSON, an empty list, or a malformed entry is a startup
error (exit 1, message + help on stderr). The list must be non-empty.

- **Strict resolution.** Each address is resolved against the workspace symbol
  index with a strict AND of all three fields. A miss or an ambiguity is a
  reported diagnostic — `tc` never silently picks one candidate.
- **One target per file per exchange.** A single `{"payloads":[…]}` exchange can
  carry several targets (one per file). **Same-file targets are sequenced across
  exchanges** within the call: `tc` edits the first, then re-seeds the next in
  the following exchange, up to the loop's per-round budget.
- **Unapplied targets are reported.** A target that never resolves, or never
  gets applied, is named in `diagnostics` under `requested targets not applied:`
  and the run does **not** report `verified`. A target that resolves and is
  applied is listed in `files`.

`--targets` also forces the batch reply shape (it implies `--multi-payload`), so
one exchange can cover several files atomically.

## Result schema (`--format json`)

`--format json` writes **exactly one** `typescript-coder-result@1` object to
stdout — one line, `JSON.parse`-able, nothing else on stdout.

| field | type | meaning |
| ----- | ---- | ------- |
| `format` | `"typescript-coder-result@1"` | contract version |
| `status` | `"ok" \| "failed"` | `"ok"` iff `verified` |
| `verified` | boolean | `true` iff `tc`'s own check + test gate passed on the final state |
| `files` | `Array<{path,symbol,kind,outcome}>` | declarations an applied exchange wrote, de-duplicated by address; `outcome` is currently always `"applied"` |
| `targets` | `Array<{path,symbol,kind}>` | echoes the requested `--targets` addresses (empty on the discovery path) |
| `records` | number | raw loop record rows (exchanges + verification steps), not a file count |
| `tokens` | `{input,output,total,cacheRead}` | numbers; provider token spend of the call |
| `terminationReason` | `null \| "token-budget" \| "edit-exhausted" \| "delete-verification-failed" \| "prev-broken" \| "harness-fault" \| "output-limit"` | why a failed run ended; `null` on success |
| `diagnostics` | `string \| null` | bounded staged diagnostics (including the unapplied-target report); `null` when nothing failed |

For a failed run the human prose — the failure-artifact path, diagnostics, and
the model's four-section summary — goes to **stderr**; stdout still carries only
the one result object. Example:

```json
{"format":"typescript-coder-result@1","status":"ok","verified":true,"files":[{"path":"src/a.ts","symbol":"Alpha","kind":"function","outcome":"applied"}],"targets":[{"path":"src/a.ts","symbol":"Alpha","kind":"function"}],"records":3,"tokens":{"input":1200,"output":80,"total":1280,"cacheRead":0},"terminationReason":null,"diagnostics":null}
```

## Exit codes and streams

- Exit `0` **iff** `verified` is `true`; otherwise exit `1`.
- Startup failures (bad flag, unreadable/invalid targets file, missing provider
  config) also exit `1` with an `error:` line and the help text on stderr; there
  is no JSON result on stdout in that case.
- stdout is the result only. Diagnostics, progress, and the explanation are
  stderr.

## Verification ownership

`tc` owns verification. After each edit it runs its own check command
(`--check`, default `bunx tsc --noEmit`) and test command (`--test`, default
`bun test`), and only reports `verified: true` when both pass on the final
state. Each check/test command is bounded by a 120 s timeout, raised per call
with `--timeout <ms>`.

The caller trusts `verified` and the exit code; it does not need to re-run
`tsc`/tests to decide success. An optional final smoke (for example, a quick
`bun test` on the touched area) is a reasonable belt-and-braces check but is not
required by the contract. Note keep-progress: a failed run leaves its attempted
state on disk (there is no rollback), so review the diff after any call that
modified files.

## Budget

`--token-budget` is a **hard per-call cap** on accumulated provider tokens
(default `120000`). When it is exceeded the run stops with
`terminationReason: "token-budget"`, `verified: false`. Set it per call to bound
the cost of the delegation; a review/retry pass is a new call with its own
budget.

## Delegation recipe

1. **Split.** Break the task into units that each end in a verifiable state.
2. **Choose targets.** Turn each unit into one or more explicit
   `{path, symbol, kind}` addresses from the workspace symbol index.
3. **Build the targets file.** Write the JSON (array or `{"targets":[…]}`, see
   above) under the caller's scratch dir.
4. **Write the task text.** Full context plus the intended change; remember
   `tc` is stateless.
5. **Invoke** with `--format json`, a `--token-budget`, `--cwd` set to the
   workspace, the matching `--check`/`--test`, and `--targets`.
6. **Parse.** `JSON.parse` the single stdout line; branch on `verified`/exit
   code. Read `files` to confirm what was applied, `targets` to confirm the
   echo, `tokens` for accounting, and `diagnostics` on failure.
7. **Retry on failure.** `tc` keeps progress, so do not blindly repeat: read
   `diagnostics`, refine the task text (narrow the change, add the failing
   signal, correct a wrong symbol/kind), and re-invoke. If only some targets
   remain unapplied, re-invoke with just those addresses — the already-applied
   ones are already on disk.

### Failure / retry path

- `verified: false` with `terminationReason: "edit-exhausted"` and a
  `requested targets not applied:` report means one or more addresses never
  resolved or never applied. Fix the addresses (a miss names the candidates the
  name does exist at; an ambiguity lists every declaration) and re-invoke.
- `"token-budget"` means the call ran out of budget: raise it or narrow the
  task text.
- `"prev-broken"` / `"harness-fault"` / `"delete-verification-failed"` /
  `"output-limit"` are terminal for that call's approach; adjust the task and
  start a fresh call rather than resending the identical request.
- A resend of the identical edit is rejected (`stage: repeat`), so a retry must
  change something — the task text, the replacement intent, or the address.

### Same-file sequencing

Within one call, `tc` sequences same-file targets across exchanges
automatically; the caller does not split them. The rule to respect when
composing a call is the inverse: a single `{"payloads":[…]}` exchange carries at
most one target per file, so if you want a file touched once per call, pass one
target for it. Two targets in the same file are fine but are handled in
successive exchanges, consuming the round's exchange budget.
