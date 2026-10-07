#!/bin/sh
# Build the replay demo with debug info and record one run of it.
#   examples/replay-demo/record.sh            # -> examples/replay-demo/out/orders{,.mrr}
#   OUT=/tmp/rr examples/replay-demo/record.sh
# Then debug the recording, backwards included:
#   ./dapweb --replay examples/replay-demo/out/orders.mrr examples/replay-demo/out/orders
#
# The trace holds every answer the program got from the OS (the ledger file's
# bytes, the clock, which task the scheduler woke), so the replay runs the same
# way after orders.txt is edited or deleted.
set -e
# From the repo root: the DWARF records source paths relative to where the
# compiler ran, and dapweb's breakpoints name them from here.
cd "$(cd "$(dirname "$0")/../.." && pwd -P)"

# The milo compiler, found the way scripts/build.sh finds it.
MILO="${MILO:-../milo/src/main.ts}"
case "$MILO" in
    *.ts) MILO_RUN="bun run $MILO" ;;
    *)    MILO_RUN="$MILO" ;;
esac

OUT="${OUT:-examples/replay-demo/out}"
mkdir -p "$OUT"
# -g is the DWARF; --debug is -O0, so every local is where the source says.
$MILO_RUN build examples/replay-demo/orders.milo -g --debug -o "$OUT/orders"
rm -f "$OUT/orders.mrr"
# The run fails on purpose (the ledger does not balance): that is the bug to
# find. The trace is written record by record, so the abort loses nothing.
MILO_RECORD="$OUT/orders.mrr" "$OUT/orders" || true
echo "recorded $OUT/orders.mrr"
echo "debug it: ./dapweb --replay $OUT/orders.mrr $OUT/orders"
