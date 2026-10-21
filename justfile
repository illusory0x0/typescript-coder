# Type-check the source tree.
typecheck:
    bunx tsc --noEmit

# Run the unit test suite.
test:
    bun test

# Run acceptance scenarios; flags pass through, e.g. `just accept --live`.
accept *args:
    bun run acceptance/run.ts {{args}}

# Format the tree with oxfmt.
format:
    bunx oxfmt
