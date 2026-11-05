# Type-check the root harnesses and both workspace packages.
typecheck:
    bunx tsc --noEmit
    cd typescript-editor && bunx tsc --noEmit
    cd harness && bunx tsc --noEmit

# Run the offline test suites with bounded file-level workers. No network or API key.
# Opt into real-model suites with `just test --api llm` (costs money).
test *args:
    bun run scripts/test.ts {{args}}

# Alias for an explicit offline worker count: `just test --jobs <n>`.
test-parallel jobs=`nproc`:
    bun run scripts/test.ts --jobs {{quote(jobs)}}

# Run acceptance scenarios; flags pass through, e.g. `just accept --live`.
accept *args:
    bun run acceptance/run.ts {{args}}

# Format the tree with oxfmt.
format:
    bunx oxfmt
