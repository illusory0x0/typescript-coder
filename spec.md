# typescript-coder — Specification

## 1. Goal

A self-contained TypeScript coding agent. It reads an issue from **stdin**, uses a
hand-written TypeScript frontend plus a symbol index to select a target symbol
(`Locator`), asks an OpenAI-compatible LLM to emit a **single-edit JSON object**
(`{"edits":[{"anchor","replacement"}]}`) for that symbol, splices the replacement
over the anchor's matched range + `oxfmt`, and accepts the result
only if `tsc --noEmit` and `bun test` pass. On failure it keeps the attempted
state, retries up to **3** times with a rebuilt bounded context, then reports an
explanation for the planning main agent.

## 2. Language & runtime

- Language: TypeScript (ESM, strict).
- Runtime / package manager / test runner: **Bun** (`bun test`).
- External dependencies: `oxfmt`, `tsc`, `bun`.

## 3. Design premise

TypeScript symbol resolution depends on:

- lexical scope,
- a few overloading rules,
- runtime symbols vs type symbols (declaration spaces),
- namespaces,
- types.

The frontend must model these explicitly rather than deferring to `tsc`.

## 4. Core abstractions

### Locator

| field  | type   | description                                  | example         |
| ------ | ------ | -------------------------------------------- | --------------- |
| `path` | string | filesystem path                              | `src/lexer.ts`  |
| `name` | string | dotted member path of the symbol             | `lexer.make`    |
| `kind` | string | disambiguator / declaration kind             | `function`      |

`kind` vocabulary (v1): `function`, `method`, `class`, `interface`, `type`,
`variable`, `namespace`, `enum`, and other declaration kinds as the binder adds
them.

### Edit

| field        | type    | description                                                                    |
| ------------ | ------- | ------------------------------------------------------------------------------ |
| `locator`    | Locator | the symbol being replaced                                                      |
| `anchor`     | string  | snippet copied from the current source, structurally matched inside the symbol |
| `llm-output` | string  | the edit's replacement TypeScript AST text snippet                             |

### apply-edits

```ts
applyEdits(source: string, edits: Edit[]): string
```

Matches each edit's anchor structurally (AST equivalence: trivia and comments
ignored, identifiers compared exactly) inside the locator's symbol, splices the
replacement over exactly that range, then formats with `oxfmt`. Returns the new
source. A whole-symbol anchor performs a full replacement; zero or multiple
anchor matches fail the attempt with `anchor-not-found` / `anchor-ambiguous`.

### append/create (missing symbol)

When a `Locator` names a symbol that is not in the index, the locator enters
**append mode** instead of failing: the LLM output is the complete code
declaring the symbol, appended to the locator's file — created together with
any missing parent directories when absent — newline-normalized and separated
from existing content by one blank line, then the whole result is formatted
with `oxfmt` and verified by the same check + test gate. On failure the attempted
state stays on disk (keep-progress): an existing file keeps the failed attempt's
content, a created file stays, and the next attempt rewrites the first appended
region.

A path is appendable only when it is relative, has no `..` segment, resolves
inside `cwd`, and does not point under `node_modules`, `.git`, `dist`, or a
hidden directory. Absolute or escaping paths stay invalid locators and nothing
outside `cwd` is ever written.

## 5. Source layout

| file          | responsibility                                                  |
| ------------- | --------------------------------------------------------------- |
| `lexer.ts`    | full TypeScript lexer, **no error tolerance** (throws with loc) |
| `parser.ts`   | full TypeScript grammar parser, recursive descent → AST + spans |
| `utility.ts`  | shared helpers + binder / symbol index                          |
| `editor.ts`   | `apply-edits` action + `oxfmt` formatting                       |
| `openai.ts`   | OpenAI-compatible provider, `tools` param                       |
| `loop.ts`     | main agent loop                                                 |
| `scroll.ts`   | signature view + on-demand expand                               |
| `cli.ts`      | entry point (currently `--help` only)                           |
| `main.ts`     | wires stdin → loop                                              |

## 6. Agent loop

**Input:** the planning main agent's issue, delivered on **stdin** (free text).

```
harness:
  - parse project TypeScript files into AST
  - build symbol index
  - combine context

model:
  - LLM reads context                    # yaml
  - LLM selects modified symbol          # json (Locator)
  - LLM outputs a single-edit JSON object # {"edits":[{"anchor","replacement"}]}

harness:
  - apply edits          # replace the symbol range, or append/create when missing
  - run TypeScript checker   (tsc --noEmit)
  - run TypeScript tests     (bun test)
```

- **selection:** a locator whose symbol is not in the index enters append mode
  when its path is safe (see §4); otherwise it stays an invalid locator and the
  model is asked to select again.
- **append/create:** the LLM output is the complete declaration of the missing
  symbol; the harness appends it to the locator's file (creating file and parent
  directories when absent), formats with `oxfmt`, and runs the same check + test
  gate. Keep-progress on failure: an existing file keeps the failed attempt's
  content, a created file stays, and a retry rewrites the first appended region.
- **on-failure:** report staged diagnostics (edits-invalid, anchor-not-found,
  anchor-ambiguous, format, tsc, tests) → keep the
  attempted state → retry with a rebuilt bounded context (system + issue/context
  + locator + attempt-aware retry prompt carrying the current source).
- **truncation:** `finishReason: "length"` is classified as `truncated`, never
  applied, and the retry asks for a more compact replacement.
- **max-retries:** 3; prompts are attempt-aware (attempt number + remaining
  budget).
- **exit:** LLM explains the failure reason for the main agent.
- **optimization:** stable system + issue/context prefix (cache-friendly);
  retries rebuild a bounded history and do not re-echo previous replacements.

## 7. Tools

Tools are **internal library APIs** in v1 (`src/tools.ts`): `rename`, `scroll`,
`find-definition`, `check`, `test`. The harness uses them directly; they are
covered by per-tool unit tests and are **never offered to the model**. v1 has no
agentic tool-execution loop: the loop sends no `tools` to the provider, and a
provider tool-call response is only ever parsed as a locator. Provider-level
`tools` parameter support stays (§8).

## 8. Provider

- type: openai-compatible
- tool-call format: `tools` param
- models: `deepseek-v4.1-flash`, `deepseek-v4-pro-0813`, `glm-5.3`, `zoe/glm-5.3`
  (the gateway's key-permitted chat ids; the earlier `deepseek`/`qwen` shorthand
  was inaccurate — `deepseek` is rejected and `qwen` has no chat model there,
  embedding only)
- credentials: `OPENAI_API_KEY`, `OPENAI_BASE_URL` (standard env vars)
- model selection: `--model` flag only
- entry: issue via stdin; `cli.ts` currently provides `--help` only

## 9. Frontend decisions

- Grammar surface: modern app TS — ES2024 syntax, full TS type grammar,
  decorators, namespaces, `.d.ts`, declaration merging, overloads.
  **Excludes** `.tsx` / JSX.
- Representation: **AST + source spans** (not a lossless CST). Edits splice the
  replacement over an anchor's matched range inside a symbol; `oxfmt` reprints.
  Comments inside the spliced range come from the LLM output.

## 10. Verification & done criteria

Edit is accepted only if both pass:

- `tsc --noEmit`
- `bun test`

**Anchor fixtures:**

1. On a fixture repo with a failing `bun test`, the agent applies a symbol
   replacement that turns tests green and keeps `tsc --noEmit` clean.
2. A deliberately-bad edit keeps its state on disk, the retry builds on it, and
   a final explanation follows.
3. Frontend passes the fixture corpus and a self-host smoke (after the agent
   edits its own `src/`, `tsc` / `bun test` still pass).

## 11. Milestones (work backwards, gated)

- **M0 · Scaffold** — `package.json` (bun, oxfmt, typescript), `tsconfig.json`
  (strict, ESM), `src/`, `bun test` wired. _Gate:_ clean `tsc --noEmit`.
- **M1 · `lexer.ts`** — full token set, trivia/comment capture, strict errors.
  _Gate:_ tokenizer snapshot tests over fixture corpus.
- **M2 · `parser.ts`** — recursive descent → AST + spans; app TS, no JSX.
  _Gate:_ AST snapshots; malformed input errors.
- **M3 · `utility.ts` + binder/index** — lexical scopes, overloads,
  runtime/type namespaces, namespaces; `Locator` → node map. _Gate:_ symbol
  lookup + find-definition tests.
- **M4 · `editor.ts`** — `applyEdits` span replacement (bottom-up) + `oxfmt`.
  _Gate:_ before/after unit tests.
- **M5 · `openai.ts`** — OpenAI-compatible chat + `tools`, env creds, model arg.
  _Gate:_ mocked-HTTP tests; optional live smoke.
- **M6 · Tools** — internal library APIs (`find-definition`, `check`, `test`,
  `scroll`, `rename`), not offered to the model in v1.
  _Gate:_ per-tool unit tests.
- **M7 · `loop.ts`** — context YAML → symbol select JSON → replacement text →
  apply → verify → keep-progress retry(3) → explanation; bounded rebuilt retry
  context.
  _Gate:_ end-to-end fix-a-failing-test fixture; bad-edit keep-progress test.
- **M8 · `cli.ts` + `main.ts`** — stdin issue reader, `--model`, `--help`.
  _Gate:_ self-host smoke test.

## 12. Risks & mitigations

| #   | risk                                                        | mitigation                                                        |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| R1  | Full TS grammar + binder is enormous                        | freeze an app-TS subset via fixtures; gate per milestone          |
| R2  | `oxfmt` native `@oxfmt/binding` may not load under Bun      | spike in M0; fall back to `bunx oxfmt` subprocess / prettier      |
| R3  | LLM tool-call / JSON flakiness (deepseek/qwen)              | strict JSON schema, low temperature, bounded retries              |
| R4  | whole-project `tsc` per retry is slow                       | incremental / changed-files scope, timeouts                       |
| R5  | overload / namespace Locator ambiguity                      | `kind` + signature disambiguation; find-definition corpus         |
| R6  | multiple edits shift spans                                  | apply bottom-up; one symbol per iteration in v1                   |
| R7  | retry context growth / prompt drift                         | stable system + issue/context prefix; bounded rebuilt context     |

## 13. Open items (defaults)

- Failure handling: keep-progress (attempted state stays on disk), per-attempt
  retry with a rebuilt bounded context, 3 total.
- One symbol per iteration in v1.
- `scroll` = signatures + N-line on-demand expand.
- Context/token budget: unbounded in v1.
- Distribution: `bun run` (no build step).
- Test discovery: repo-wide `bun test`.
- Formatting: default `oxfmt` config, TypeScript.
- Failure explanation surfaced on stderr + final stdout message.
