---
id: 86
title: "CLI: emit a JSON result object on usage errors under --format json"
status: done
priority: medium
milestone: null
parent: 79
deps: []
labels: [cli, integration]
created: 2026-10-20
---

## Context

The `--format json` channel (from #80) promises one `typescript-coder-result@1`
object on stdout, diagnostics on stderr, and exit 0 iff verified. A CLI usage
error bypasses that: `parseCliOptions` prints to stderr and calls
`process.exit(1)` before any result is emitted, so a machine caller parses empty
stdout. Found while doing #83: `printf 'noop' | tc --format json --bogus-flag`
exits 1 with 0 bytes on stdout (stderr `error: unknown argument: --bogus-flag`).

## Goal

When argv requests JSON and option parsing fails, stdout still carries a
`typescript-coder-result@1` failure object.

## Acceptance criteria

- [ ] `tc --format json <bad-flag>` prints one result object on stdout (`status: failed`, `verified: false`, `diagnostics` naming the error) and exits non-zero.
- [ ] the human error and help text still go to stderr.
- [ ] the default `--format text` path is unchanged.
- [ ] unit tests cover the JSON-on-usage-error path.

## Verification

`bunx tsc --noEmit`; `bun test`; the repro above now yields parseable stdout.

## Notes
- Added argvRequestsJson + reportUsageError to src/main.ts: a CLI usage error under --format json now writes one typescript-coder-result@1 failure object to stdout (diagnostics naming the error) while the human error and help stay on stderr and the exit code stays 1. parseCliOptions takes an io and exits with reportUsageError's code; the default text path is byte-identical (stdout empty on a usage error). New src/main.test.ts covers argvRequestsJson and both reportUsageError paths. Verified: bunx tsc --noEmit clean; bun test src/main.test.ts 8 pass; bun test 861 pass; repro prints the JSON line to stdout, exit=1.
