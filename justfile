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

# Install the local tsed CLI globally with Bun; the entry points at this checkout.
tsed-install:
    #!/usr/bin/env bash
    set -euo pipefail
    # `bun add -g` appends duplicate keys on a repeat install, so replace the
    # entry instead of adding to it.
    bun remove -g @tc/typescript-editor >/dev/null 2>&1 || true
    bun add -g "{{justfile_directory()}}/typescript-editor"

# Regenerate the committed tsed parser/help/completions from its .scs source.
tsed-generate:
    scs generate typescript-editor/scs/tsed.scs --out typescript-editor/scs/generated --targets ts,runtime,bash,zsh,fish,elvish,pwsh,nu

# Verify the committed tsed generated artifacts match the .scs source.
tsed-check:
    scs generate typescript-editor/scs/tsed.scs --out typescript-editor/scs/generated --targets ts,runtime,bash,zsh,fish,elvish,pwsh,nu --check

# Format the tree with oxfmt.
format:
    bunx oxfmt
