#!/bin/sh
# One-command build: dapweb binary + web UI bundle.
#   scripts/build.sh            # dev: binary at -O0 (~1s) + UI bundle
#   scripts/build.sh bin        # dev binary only
#   scripts/build.sh ui         # UI bundle only
#   scripts/build.sh release    # -O2 binary (couple minutes: milo emits one
#                               # big LLVM module and clang -O2 chews on it) + UI
#
# The binary lands at the repo root (./dapweb) on purpose: the e2e tests spawn
# "./dapweb", and the server's --webroot default (src/web/ui/dist) resolves
# against the cwd — running from the root makes both Just Work. It's
# gitignored, so the root stays clean in git terms.
set -e
cd "$(dirname "$0")/.."

# milo compiler; override with MILO=/path/to/milo/src/main.ts or a milo binary.
# A .ts path needs "bun run" in front; a compiled binary (what the CI downloads
# from the compiler's releases) is invoked directly.
MILO="${MILO:-../milo/src/main.ts}"
case "$MILO" in
    *.ts) MILO_RUN="bun run $MILO" ;;
    *)    MILO_RUN="$MILO" ;;
esac

# echo each command with wall-clock timing
run() {
    echo "+ $*"
    start=$(date +%s)
    "$@"
    echo "  (took $(($(date +%s) - start))s)"
}

what="${1:-all}"
case "$what" in
    all|bin)  run $MILO_RUN build src/main.milo --debug -o dapweb ;;
    release)  run $MILO_RUN build src/main.milo -o dapweb ;;
esac
case "$what" in
    all|release|ui)  run src/web/ui/build.sh ;;
esac
