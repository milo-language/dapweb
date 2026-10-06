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
clang -g -O0 examples/watch.c -o /tmp/dapweb_watch

pass=0
fail=0
failed=""

# Run one suite and count it. Exiting 0 is not enough: a suite whose matcher stops
# matching (a renamed message type, a regex over source that moved) checks nothing and
# still exits 0. Every suite prints "  ok <label>" per passing check, so zero of those
# is a failure.
run_checked() {
    name="$1"; shift
    out="/tmp/dapweb_test_out_$$_$name"
    # Output streams through tee; the exit status rides out in a side file because
    # POSIX sh has no PIPESTATUS. The `if` keeps set -e from aborting on a failing suite.
    { if bun "tests/$name.ts" "$@"; then rc=0; else rc=$?; fi; echo "$rc" >"$out.status"; } 2>&1 | tee "$out"
    st=$(cat "$out.status")
    oks=$(grep -c '^  ok ' "$out" || true)
    if [ "$st" -eq 0 ] && [ "$oks" -gt 0 ]; then
        pass=$((pass + 1))
    else
        [ "$st" -eq 0 ] && echo "  FAIL $name: exited 0 but reported no passing checks"
        fail=$((fail + 1)); failed="$failed $name"
    fi
    rm -f "$out" "$out.status"
}

# A suite that needs a live server: spawn one, wait for the port, run, kill.
serve_suite() {
    name="$1"; port="$2"; shift 2
    case "$name" in *"$filter"*) ;; *) return 0 ;; esac
    echo ""
    echo "── $name (port $port)"
    # Something else on the port (a dev server) would answer every probe while
    # ours dies on bind, and the suite would quietly test the wrong server.
    if curl -s -o /dev/null "http://localhost:$port/api/state"; then
        echo "  FAIL $name: port $port already in use (set DAPWEB_TEST_PORT_BASE)"
        fail=$((fail + 1)); failed="$failed $name"; return 0
    fi
    XDG_STATE_HOME="$state/$name" DAPWEB_NO_OPEN=1 \
        ./dapweb web --port "$port" --quiet "$@" >"/tmp/dapweb_test_$name.log" 2>&1 &
    srv=$!
    i=0
    while [ $i -lt 100 ]; do
        curl -s -o /dev/null "http://localhost:$port/api/state" && break
        i=$((i + 1)); sleep 0.1
    done
    if ! kill -0 "$srv" 2>/dev/null; then
        echo "  FAIL $name: its server exited at startup (port $port taken?), see /tmp/dapweb_test_$name.log"
        fail=$((fail + 1)); failed="$failed $name"; return 0
    fi
    run_checked "$name" "$port" ./dapweb
    kill "$srv" 2>/dev/null || true
    wait "$srv" 2>/dev/null || true
}

# A suite that spawns its own server: it only needs the binary path.
self_suite() {
    name="$1"
    case "$name" in *"$filter"*) ;; *) return 0 ;; esac
    echo ""
    echo "── $name (self-spawning)"
    run_checked "$name" ./dapweb
}

# Raw syscalls belong in milo's std behind safe APIs, so application code has
# no `unsafe` at all. Counts as a suite so a regression fails the run.
no_unsafe() {
    case "no-unsafe" in *"$filter"*) ;; *) return 0 ;; esac
    echo ""
    echo "── no-unsafe"
    if hits=$(grep -rnw --include='*.milo' unsafe src); then
        echo "$hits" | sed 's/^/  /'
        echo "  FAIL no-unsafe: $(echo "$hits" | wc -l | tr -d ' ') line(s) under src/ use unsafe"
        fail=$((fail + 1)); failed="$failed no-unsafe"
    else
        echo "  ok no unsafe under src/"
        pass=$((pass + 1))
    fi
}

# Pure milo functions (runtime detection, optimization parsing) tested in
# milo, through `milo test` on every *_test.milo under src. Needs the compiler,
# located the way build.sh locates it.
milo_unit() {
    case "milo-unit" in *"$filter"*) ;; *) return 0 ;; esac
    echo ""
    echo "── milo-unit"
    m="${MILO:-../milo/src/main.ts}"
    case "$m" in *.ts) mrun="bun run $m" ;; *) mrun="$m" ;; esac
    out="/tmp/dapweb_test_out_$$_milo_unit"
    if $mrun test src >"$out" 2>&1; then rc=0; else rc=$?; fi
    sed 's/^/  /' "$out"
    # `milo test` exiting 0 with nothing run would pass silently, so a passing
    # count is required too, the same rule run_checked applies to bun suites.
    if [ "$rc" -eq 0 ] && grep -Eq "[1-9][0-9]* pass, 0 fail" "$out"; then
        echo "  ok milo unit tests"
        pass=$((pass + 1))
    else
        echo "  FAIL milo-unit (exit $rc; MILO=$m)"
        fail=$((fail + 1)); failed="$failed milo-unit"
    fi
    rm -f "$out"
}

no_unsafe
milo_unit
serve_suite e2e            $((base +  0)) --program /tmp/dapweb_inter --source /tmp/dapweb_inter.c
serve_suite e2e-m8         $((base + 10)) --program /tmp/dapweb_inter --source /tmp/dapweb_inter.c
serve_suite e2e-multifile  $((base + 20)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-restart    $((base + 30)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-codebug    $((base + 40)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-session    $((base + 50)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-threads    $((base + 60)) --program /tmp/dapweb_threads
serve_suite e2e-security   $((base + 70))
serve_suite e2e-latejoin   $((base + 80)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-goto       $((base + 90)) --program /tmp/dapweb_nested --source examples/nested/main.c
serve_suite e2e-watch      $((base + 100)) --program /tmp/dapweb_watch --source examples/watch.c
self_suite  configform
self_suite  tablabels
self_suite  inlinevalues
self_suite  primary
self_suite  threadlabel
self_suite  session-reducer
self_suite  follow
self_suite  recordedstops
self_suite  hermetic
self_suite  api
self_suite  e2e-agent
self_suite  e2e-timeline
self_suite  e2e-config
self_suite  e2e-attach
self_suite  e2e-commands
self_suite  e2e-start
self_suite  e2e-history
self_suite  journal
self_suite  update

rm -rf "$state"
echo ""
echo "suites: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || { echo "failed:$failed"; exit 1; }
