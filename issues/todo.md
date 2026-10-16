# Todo

Issue tracker for `typescript-coder`. Filed from [spec.md](../spec.md).
The table is authoritative for scanning; the graph is authoritative for
structure.

```dot
digraph issues {
  rankdir=LR;
  node [shape=box, style="rounded,filled", fontname="Helvetica"];

  // status colors: todo=white, in-progress=lightyellow, review=lightblue,
  //                done=lightgreen, wontfix=lightgrey
  "1"  [label="#1 typescript-coder agent\n(done)", fillcolor="lightgreen"];
  "2"  [label="#2 Scaffold\n(done)", fillcolor="lightgreen"];
  "3"  [label="#3 Lexer\n(done)", fillcolor="lightgreen"];
  "4"  [label="#4 Parser\n(done)", fillcolor="lightgreen"];
  "5"  [label="#5 Binder & symbol index\n(done)", fillcolor="lightgreen"];
  "6"  [label="#6 Editor\n(done)", fillcolor="lightgreen"];
  "7"  [label="#7 Provider\n(done)", fillcolor="lightgreen"];
  "8"  [label="#8 Tools\n(done)", fillcolor="lightgreen"];
  "9"  [label="#9 Agent loop\n(done)", fillcolor="lightgreen"];
  "10" [label="#10 CLI & main\n(done)", fillcolor="lightgreen"];
  "11" [label="#11 Live e2e acceptance\n(todo)", fillcolor="white"];
  "12" [label="#12 Runner live layer\n(done)", fillcolor="lightgreen"];
  "13" [label="#13 Live run evidence\n(done)", fillcolor="lightgreen"];
  "14" [label="#14 Model records\n(done)", fillcolor="lightgreen"];

  // tree edges (parent -> child), solid
  "1" -> "2";
  "1" -> "3";
  "1" -> "4";
  "1" -> "5";
  "1" -> "6";
  "1" -> "7";
  "1" -> "8";
  "1" -> "9";
  "1" -> "10";

  // tree edges (parent -> child), solid
  "11" -> "12";
  "11" -> "13";
  "11" -> "14";

  // dependency edges (blocker -> blocked), dashed
  "2" -> "3" [style=dashed, label="blocks"];
  "3" -> "4" [style=dashed, label="blocks"];
  "4" -> "5" [style=dashed, label="blocks"];
  "5" -> "6" [style=dashed, label="blocks"];
  "2" -> "7" [style=dashed, label="blocks"];
  "6" -> "8" [style=dashed, label="blocks"];
  "6" -> "9" [style=dashed, label="blocks"];
  "7" -> "9" [style=dashed, label="blocks"];
  "8" -> "9" [style=dashed, label="blocks"];
  "9" -> "10" [style=dashed, label="blocks"];
  "12" -> "13" [style=dashed, label="blocks"];
  "13" -> "14" [style=dashed, label="blocks"];
}
```

| id  | title                       | status | priority | milestone | parent | deps    |
| --- | --------------------------- | ------ | -------- | --------- | ------ | ------- |
| 1   | [typescript-coder agent](done/0001-typescript-coder-agent.md) | done | medium |  |  |  |
| 2   | [Scaffold Bun/TypeScript project](done/0002-scaffold-bun-project.md) | done | medium | M0 | 1 |  |
| 3   | [Lexer with strict errors](done/0003-lexer-strict-errors.md) | done | medium | M1 | 1 | 2 |
| 4   | [Recursive-descent parser with source spans](done/0004-parser-source-spans.md) | done | medium | M2 | 1 | 3 |
| 5   | [Binder and symbol index](done/0005-binder-symbol-index.md) | done | medium | M3 | 1 | 4 |
| 6   | [Editor apply-edits and oxfmt formatting](done/0006-editor-apply-edits.md) | done | medium | M4 | 1 | 5 |
| 7   | [OpenAI-compatible provider with tools](done/0007-provider-openai.md) | done | medium | M5 | 1 | 2 |
| 8   | [Tools (rename, scroll, find-definition, check, test)](done/0008-tools.md) | done | medium | M6 | 1 | 6 |
| 9   | [Agent loop with verify, rollback, retry](done/0009-agent-loop.md) | done | medium | M7 | 1 | 6, 7, 8 |
| 10  | [CLI and main stdin entry](done/0010-cli-and-main.md) | done | medium | M8 | 1 | 9 |
| 11  | [Live end-to-end acceptance and model-record corrections](0011-live-e2e-acceptance.md) | todo | medium |  |  |  |
| 12  | [Add live layer to the acceptance runner](done/0012-runner-live-layer.md) | done | medium |  | 11 |  |
| 13  | [Run live end-to-end acceptance and capture evidence](done/0013-live-run-evidence.md) | done | medium |  | 11 | 12 |
| 14  | [Correct model records in spec and closed issues](done/0014-correct-model-records.md) | done | medium |  | 11 | 13 |
