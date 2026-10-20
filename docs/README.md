# Documentation

These docs describe the `tc` (typescript-coder) loop. Read them in this order,
or jump to the one you need.

- [glossary](glossary.md) — the loop vocabulary: Run / Edit / Verification, and
  the Selection terms everything else leans on.
- [design](design.md) — the architecture: components, the two loops, the flows
  between them, and the invariants they hold.
- [spec](spec.md) — the product spec: the loop's behavior, the wire protocol,
  and the failure/rejection policy.
- [edit-protocol](edit-protocol.md) — the compact, positional selection syntax
  the model emits (`select → match → pick → replace`) and its semantics.
- [subagent](subagent.md) — delegating one scoped edit to `tc`: invocation,
  targets, result schema, and retry.
- [review-guide](review-guide.md) — where human review pays off, tiered by blast
  radius.
- [feedback](feedback.md) — the `feedback/` format for the opencode→`tc`
  critique pool.
