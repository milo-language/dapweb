# Dapweb Design

Vision: a web UI and an agent CLI for any DAP debugger, sharing one live session, written
in Milo. Open work lives in `roadmap.md`; this file keeps the principle and the facts that
cost a debugging session to learn.

**Design principle: map to the DAP spec as closely as possible.** The config object is a
verbatim launch/attach request body (VS Code launch.json shape); dapweb-only keys
(`source`, `adapter`, `stopAtMain`) stay clearly separated and lower to DAP-native
constructs. No invented protocol.

**Shape.** `src/web/state.milo` holds all session state (`gSession`); `snapshot()` is the
ordered replay a joining peer receives, and the live pushes render through the same
functions. `dispatch.milo` has one handler per command in `src/commands.milo`;
`dap_reader.milo` owns the adapter connection; `peers.milo` fans broadcasts out as sealed,
shared buffers; `http.milo` parses each request once. The UI folds the same message stream
through the pure `sessionReducer` (`src/web/ui/src/session.ts`).

## Hard-won operational facts

Adapters:

- **Adapter must be spawned by absolute path.** lldb-dap builds its runInTerminal launcher
  argv from its own argv[0]; spawn it bare and the pty launcher exits 127 while the adapter
  blocks on its comm-file forever, with no error surfaced. The server resolves against
  PATH at startup (`resolveInPath`).
- **Breakpoint source path must match the debuggee's DWARF path.** `clang -g examples/foo.c
  -o /tmp/foo` records `examples/foo.c`; a bp on `/tmp/foo.c` silently never binds (lldb
  matches the full path). Compile from the path you'll reference, or use lldb
  `target.source-map`. On macOS `/tmp` is a symlink to `/private/tmp`, which is the same
  trap.
- **lldb-dap runInTerminal args**: `[<lldb-dap-abs-path>, --comm-file <fifo>,
  --debugger-pid <pid>, --launch-target <program>]`; the launcher waits on the comm-file,
  then execs the target.
- **restart emits `exited` for the old process**: only `terminated`/EOF may end the
  session. lldb-dap handles `restart` but never advertises `supportsRestartRequest`; try
  then fall back, rather than gating on the capability.
- **lldb-dap fills its thread list lazily after a stop**: an immediate `threads` response
  usually has only the stopping thread; the server re-polls 3x at 300ms.
- **lldb-dap reports the stop-at-main breakpoint as plain `reason: "breakpoint"`.** The
  server records the id `setFunctionBreakpoints` returned for main and compares it with
  the stop's `hitBreakpointIds` to set `atMain`.
- **lldb-dap reports a watchpoint stop on the line after the write** (reason `"data
  breakpoint"`): the trap fires once the writing instruction retires. Its dataId is
  `"ADDR/SIZE"` and it never answers `canPersist`, so dapweb drops data breakpoints when
  the run ends. With no `variablesReference`, `dataBreakpointInfo` evaluates `name` and
  watches the address it VALUES to (`g_total` = 0 is refused, `&g_total` works).
- **readMemory at unmapped pages**: lldb-dap replies success-but-empty (no error, no
  data); surface it in the Memory pane, not the terminal.

Terminal:

- **Stdin before the pty exists must be buffered** (adapter launch takes ~1s; keystrokes
  would vanish); flushed when the pty arrives.
- **Write keystrokes with `Pty.writeOnce`, not `Pty.write`.** `write` parks until the bytes
  go, so a debuggee that never reads stdin would stall that peer's reader task.
- **Apply the terminal size before spawn.** The forked child sets the slave's size from the
  Pty's rows/cols at startup and overwrites a resize that raced it.

Server:

- **The WS writer task must finish before its socket closes.** A writer still draining
  queued frames otherwise writes into a closed fd or, worse, into whatever new connection
  reused the fd number. The reader joins the writer before the `WsConn` drops.
- **Read request headers to the blank line before judging them.** Headers can arrive split
  across TCP segments; the Host/Origin gate would refuse a request whose Host had not
  arrived yet.
- **Security model:** loopback-only listener, Host must name loopback (DNS rebinding),
  Origin when present must be the server's own (cross-site `text/plain` POSTs and WS
  upgrades skip CORS preflight). There is no authentication: any local user can drive it.
- **Teardown sleeps block on purpose** (`sleepBlockingMs` in `killAdapterSrv` and
  `reapDebuggee`): they run with half-torn-down state, and a parking sleep would let a
  peer's command act on it.
- **Idle-TTL reaper is a green task on `sleepMs`**; the scheduler bounds its kevent wait by
  the nearest timer, so no OS ticker thread is needed.
- **id-correlated broadcasts**: replies ride the shared bus, so every peer must ignore ids
  it did not send.
