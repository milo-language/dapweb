#!/bin/sh
# One command to run every dapweb gate against an already-built ./dapweb.
#   scripts/build.sh && scripts/test.sh      # everything
#   scripts/test.sh codebug                  # one suite (substring match on the filename)
#
# Each suite gets its OWN freshly spawned server on its own port with a throwaway
# $XDG_STATE_HOME, so no suite can see another's session registry, config history
# or breakpoints. Suites that spawn their own server (api, config, history) are
# handed the binary instead of a port.
set -e
# -P: resolve symlinks. On macOS /tmp is a symlink to /private/tmp, and the
# suites derive source paths from import.meta.url (already resolved) while a
# debuggee compiled from the unresolved path records the OTHER spelling in
# DWARF. lldb matches breakpoints on the full path, so the two must agree or
# every breakpoint silently fails to bind.
cd "$(cd "$(dirname "$0")/.." && pwd -P)"

[ -x ./dapweb ] || { echo "no ./dapweb — run scripts/build.sh first" >&2; exit 1; }

filter="${1:-}"
# Two servers must never collide on a dev box running this twice, and
# e2e-session spawns a second server at port+3, so suites are 10 apart.
base="${DAPWEB_TEST_PORT_BASE:-$((8600 + $$ % 100 * 10))}"
state="/tmp/dapweb_test_state_$$"
rm -rf "$state"

# Compile the debuggees FROM THE REPO ROOT with relative paths: lldb matches
# breakpoints on the full DWARF path, so `clang -g examples/x.c` records
# "examples/x.c" and a suite referencing that path binds. Compiling from /tmp
# records a path nothing references and every breakpoint silently never binds.
echo "building debuggees"
# The interactive suites assert the DWARF path ends with "dapweb_inter.c", so
# the source is copied to /tmp under that name and compiled from there.
cp examples/interactive.c /tmp/dapweb_inter.c
clang -g -O0 /tmp/dapweb_inter.c -o /tmp/dapweb_inter
clang -g -O0 examples/nested/main.c examples/nested/shapes.c -o /tmp/dapweb_nested -lm
clang -g -O0 examples/threads.c -o /tmp/dapweb_threads -lpthread

pass=0
fail=0
failed=""

# A suite that needs a live server: spawn one, wait for the port, run, kill.
serve_suite() {
    name="$1"; port="$2"; shift 2
    case "$name" in *"$filter"*) ;; *) return 0 ;; esac
    echo ""
    echo "── $name (port $port)"
    XDG_STATE_HOME="$state/$name" DAPWEB_NO_OPEN=1 \
        ./dapweb web --port "$port" --quiet "$@" >"/tmp/dapweb_test_$name.log" 2>&1 &
    srv=$!
    i=0
    while [ $i -lt 100 ]; do
        curl -s -o /dev/null "http://localhost:$port/api/state" && break
        i=$((i + 1)); sleep 0.1
    done
    if bun "tests/$name.ts" "$port"; then pass=$((pass + 1)); else fail=$((fail + 1)); failed="$failed $name"; fi
    kill "$srv" 2>/dev/null || true
    wait "$srv" 2>/dev/null || true
}

# A suite that spawns its own server: it only needs the binary path.
self_suite() {
    name="$1"
    case "$name" in *"$filter"*) ;; *) return 0 ;; esac
    echo ""
    echo "── $name (self-spawning)"
    if bun "tests/$name.ts" ./dapweb; then pass=$((pass + 1)); else fail=$((fail + 1)); failed="$failed $name"; fi
}

serve_suite e2e            $((base +  0)) --program /tmp/dapweb_inter --source /tmp/dapweb_inter.c
serve_suite e2e-m8         $((base + 10)) --program /tmp/dapweb_inter --source /tmp/dapweb_inter.c
serve_suite e2e-multifile  $((base + 20)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-restart    $((base + 30)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-codebug    $((base + 40)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-session    $((base + 50)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-threads    $((base + 60)) --program /tmp/dapweb_threads
self_suite  api
self_suite  e2e-config
self_suite  e2e-history

rm -rf "$state"
echo ""
echo "suites: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || { echo "failed:$failed"; exit 1; }
