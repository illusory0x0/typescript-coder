# Type-check the source tree.
typecheck:
    bunx tsc --noEmit

# Run the unit test suite (serial and deterministic; the default).
test:
    bun test

# Run the unit tests in bounded worker processes; serial `just test` stays the default.
test-parallel jobs=`nproc`:
    #!/usr/bin/env bash
    set -euo pipefail
    jobs=${TC_TEST_JOBS:-{{quote(jobs)}}}
    if ! [[ "$jobs" =~ ^[1-9][0-9]*$ ]]; then
        echo "test-parallel: jobs must be a positive integer, got '$jobs'" >&2
        exit 2
    fi
    if (( jobs > 4 )); then
        echo "test-parallel: capping $jobs workers at 4 to bound tsc/test subprocess memory" >&2
        jobs=4
    fi
    exec bun test --parallel="$jobs"

# Run acceptance scenarios; flags pass through, e.g. `just accept --live`.
accept *args:
    bun run acceptance/run.ts {{args}}

# Format the tree with oxfmt.
format:
    bunx oxfmt
