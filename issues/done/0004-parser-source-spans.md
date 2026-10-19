---
id: 4
title: Recursive-descent parser with source spans
status: done
priority: medium
milestone: M2
parent: 1
deps: [3]
labels: [frontend]
created: 2026-10-16
---

## Context

Milestone **M2** of [spec.md](../../docs/spec.md) §11, implementing `parser.ts` (spec
§5). Consumes the lexer token stream and produces an AST annotated with source
spans. Per spec §9 the surface is modern app TS: ES2024 syntax, full TS type
grammar, decorators, namespaces, `.d.ts`, declaration merging, and overloads —
**excluding** JSX/TSX.

## Goal

`parser.ts` parses the supported TypeScript surface into an AST where every node
carries a source span, and rejects malformed input with a located error.

## Acceptance criteria

- [x] Recursive-descent parser produces an AST with source spans for ES2024 + TS
      type grammar constructs (declarations, statements, expressions, types).
- [x] Decorators, namespaces, `.d.ts`, declaration merging, and overload
      signatures parse correctly.
- [x] JSX/TSX is out of scope and is not required to parse.
- [x] Malformed input throws a located parse error.
- [x] AST snapshot tests pass over the fixture corpus.

## Verification

```
bun test src/parser.test.ts
```

## Notes

- Depends on #3 (lexer).
- Blocks #5 (binder).
- AST shape is the contract consumed by the binder (#5) and editor (#6).
- **Contract for #5** (`src/parser.ts`, 5.4k lines, 225 tests green):
  - `new Parser(source).parseProgram(): Program` where
    `Program { kind:"Program", body: Statement[], source, start:0, end:len }`.
  - Public parse entry points: `parseProgram`, `parseExpression`,
    `parseAssignmentExpression`, `parseType`, `parseParameters`,
    `parseTypeParameters`, `parseBindingName`.
  - Every node has `kind`, `start`, `end` (code-unit offsets). Node families:
    expressions (Identifier, literals, Unary/Update/Binary/Logical/Conditional/
    Assignment/Sequence, Member/Call/New/TaggedTemplate/Yield/Import/As/
    TypeAssertion/NonNull, Arrow/Function/Class expressions, Template/Regex,
    Array/Object with ObjectMethod, SpreadElement), types (KeywordType,
    TypeReference, literals, unions/intersections, Array/Tuple/IndexedAccess,
    TypeOperator, TypeLiteral + signatures, Function/Constructor types,
    Conditional/Infer/Mapped/TemplateLiteral/Import types, Parameter,
    TypeParameter, TypePredicate), statements (Program, Block, Expression, Empty,
    Variable, Function, Return, If/While/DoWhile/For/ForIn/ForOf/Switch/Try/
    Throw/Break/Continue/Labeled, Interface, TypeAlias, Enum, Namespace,
    ClassDeclaration + members, Import family, Export family, ImportEquals),
    plus binding patterns (ArrayPattern/ObjectPattern/BindingElement).
  - Declarations to bind: VariableStatement (`declarationKind`, declarators with
    `name: BindingName`), FunctionDeclaration (body null = overload), Class,
    Interface, TypeAlias, Enum, Namespace, imports (default/namespace/named/
    equals), exports wrap declarations.
  - `ParseError` carries `offset`/`line`/`column`; no error recovery.
- **Known parser limitations** (documented, not required yet): private `#names`,
  import attributes (`with { type: "json" }`), `using` declarations,
  `<const>` assertion (`as const` works), mapped-type key remapping
  (`as` clause), `typeof import("m")` type query.
- **Implementation history:** delegated in 16 bounded chunks (single-shot
  delegations failed silently; see umbrella notes); final review by main agent.
- Verified 2026-10-16: `bun test src/parser.test.ts` 225 pass / 0 fail;
  `bunx tsc --noEmit` exit 0; `bun test` 268 pass / 0 fail across 3 files;
  corpus test parses all 6 `src/*.ts` files (~10.4k lines) without throwing.
