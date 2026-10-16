---
id: 17
title: Benchmark fixtures G1–G3 as test-only spec projects
status: todo
priority: medium
milestone: null
parent: 16
deps: []
labels: [benchmark]
created: 2026-10-17
---

## Context

The benchmark tasks are from-scratch generation. Each fixture contains only a
`tsconfig.json` and the specification test file; the agent must create the
implementation module itself (possible for typescript-coder only after #15).
No stub file exists. The test files are the frozen contract and must not be
edited by the agents during runs.

## Goal

Three fixture projects (`json-parser`, `sexp-parser`, `minilisp`), reference
solutions kept outside the fixtures, and an offline checker that proves each
fixture is red before the reference and green after it.

## Deliverables

- `benchmark/fixtures/json-parser/{tsconfig.json,src/json.test.ts}`
- `benchmark/fixtures/sexp-parser/{tsconfig.json,src/sexp.test.ts}`
- `benchmark/fixtures/minilisp/{tsconfig.json,src/lisp.test.ts}`
- `benchmark/references/{json,sexp,lisp}.ts` — reference implementations, never
  copied into agent workspaces (the runner copies only the fixture directory)
- `benchmark/check.ts` — offline fixture verifier
- root `tsconfig.json`: add `"benchmark"` to `include` and
  `"benchmark/fixtures"` to a new `exclude`, so `bunx tsc --noEmit` typechecks
  the checker and references but not the fixture projects

Fixture tsconfig mirrors `acceptance/fixtures/fix-answer/tsconfig.json`: strict,
`noEmit`, `module: ESNext`, `moduleResolution: bundler`, `skipLibCheck`,
`include: ["src"]`, `exclude: ["src/**/*.test.ts"]`.

### G1 json-parser

`src/json.ts` must export
`type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }`
and `function parseJson(text: string): JsonValue`. Spec:

- literals: `null`, `true`, `false`; numbers `42`, `-3.5`, `1e3` → 1000,
  `2.5E-2` → 0.025
- strings: empty string; escapes `\" \\ \/ \b \f \n \r \t`; `\u0041` → `"A"`
- arrays: `[]`, `[1, true, null]`, nested; objects: `{}`,
  `{"a":1,"b":{"c":[2,null]}}`
- whitespace-tolerant: `' { "a" : [ 1 , 2 ] } '`
- throws `SyntaxError`: `""`, `"tru"`, `"01"`, `"[1,]"`, `'{"a":}'`, `'"abc'`

### G2 sexp-parser

`src/sexp.ts` must export `type Sexp = string | number | Sexp[]` and
`function parseSexp(text: string): Sexp` parsing exactly one expression, outer
whitespace ignored. Spec:

- atoms: `42` → number, `-7`, `3.5`; symbols `foo`, `+`, `foo-bar?` → string
- lists: `()` → `[]`, `(a b c)`, nested `(a (b 1) ())`
- whitespace forms: `'  ( a\n\tb )  '`
- throws `SyntaxError`: `""`, `"  "`, `"(a"`, `")"`, `"(a))"`, `"(a b) c"`,
  `"a b"`

### G3 minilisp

`src/lisp.ts` must export `type LispValue = number | boolean | LispValue[]` and
`function run(program: string): LispValue`. Spec:

- evaluates all top-level forms in order; returns the last value; single file
  with its own parser (must not import from the other fixtures)
- literals: numbers, `true`/`false`; symbols resolve in the environment
- builtins, exactly 2 args each: `+ - * / =`
- special forms: `(if c t e)` (only `false` is falsy), `(define x expr)`,
  `(define (f a...) body...)`, `(lambda (a...) body...)`; closures capture
  their defining environment
- pairs: `(cons a b)` → `[a, b]`; `(car p)` → first; `(cdr p)` → second
- examples: `(+ 1 2)` → 3; `(if (= 3 3) 10 20)` → 10; `(define x 21) (+ x x)`
  → 42; `((lambda (x) (* x x)) 9)` → 81;
  `(define (adder n) (lambda (x) (+ x n))) ((adder 10) 5)` → 15;
  `(define (fact n) (if (= n 0) 1 (* n (fact (- n 1))))) (fact 5)` → 120;
  `(cons 1 (cons 2 3))` → `[1, [2, 3]]`; `(car ...)` / `(cdr ...)` of that pair
- `run("(unknown 1)")` throws

### benchmark/check.ts (offline, no model calls)

For each fixture: copy it to a temp workspace; run `bun test` (expect non-zero
with a module-resolution error for the target module); then copy
`benchmark/references/<name>.ts` to `src/<name>.ts`; run `bun test` (expect 0)
and tsc (expect 0). Initial tsc is not asserted: with test files excluded and
no implementation yet, `tsc` reports "no inputs" until the module exists.
Workspaces under repo-local `./tmp/benchmark-check/`, cleaned unless `--keep`;
tsc binary from the repo's `node_modules/typescript/bin/tsc` (same pattern as
`acceptance/run.ts`). Prints one PASS/FAIL line per task and exits non-zero if
any check fails.

## Acceptance criteria

- [ ] Fixture directories contain exactly a `tsconfig.json` and one spec test
      file; no implementation files.
- [ ] `bun run benchmark/check.ts` exits 0 and prints 3 PASS lines; each fixture
      is red before the reference (missing module) and green after it (tests +
      tsc).
- [ ] `bunx tsc --noEmit` still exits 0 with `benchmark` included and
      `benchmark/fixtures` excluded.
- [ ] `bun test` is unaffected by the new files (root config `root = "./src"`).
- [ ] Reference solutions live outside the fixture directories, so copying a
      fixture cannot leak a solution into an agent workspace.

## Verification

```
bun run benchmark/check.ts
bunx tsc --noEmit
bun test
```

## Notes

- The spec bullets above are the contract; test files may add minor cases but
  must not weaken these.
- Probe (2026-10-17): `bun test` run inside a repo-local temp workspace
  discovers only that workspace's `src/*.test.ts` (verified with a temporary
  `tmp/bunfig-probe/`), so repo-local temp directories are safe and comply
  with AGENTS.md.
- Depends on nothing; blocks #18.
- Non-goals: scoring partial implementations, hidden tests beyond the frozen
  spec file.
