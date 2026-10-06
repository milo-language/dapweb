# Roadmap (from the 2026-10-05 design review)

Every phase ends green on `scripts/test.sh` (all suites) before the next one starts.
Small commits, each one passes the full test suite on its own.

## Findings

System:
- S1 no Origin/Host check on `/api` or WS upgrade; no token. A cross-site `text/plain` POST
  (no preflight) or DNS rebinding reaches `evaluate`, which can run commands on the machine. Bind address unverified (`TcpListener.bind(port)`).
- S2 session state = ~53 module globals in `server.milo`; late-joiner replay = ad hoc cached
  strings (`gStopMsg`, `gThreadsMsg`, `gRegionsMsg`, `gCapsMsg`). New state that nobody adds
  to the replay leaves late joiners with a partial session.
- S3 `server.milo` 3730 lines; `dapReaderLoop` ~540, `dispatchClientCmd` ~400 (if-chain).
- S4 DAP frames parsed up to 5x per message.
- S5 `docs/design.md` stale (MCP, "no JSON builder").
- S6 `App.tsx` 2557 lines, 75 `useState`.
- S7 one DAP client per server; M10 (js-debug child sessions) needs N.
- S8 pty resize sent by UI, dropped by server.

UI:
- U1 same-basename tabs indistinguishable (`main.c` `main.c`).
- U2 icon-only toolbar, no tooltips/shortcuts shown; cog icons cryptic.
- U3 status `stopped:23` lacks stop reason.
- U4 Exceptions panel shows C++/ObjC filters for C programs.
- U5 thread row truncated (queue name).
- U6 breakpoint list lacks source line text.
- U7 terminal opens on lldb banner chatter.
- U8 memory annotations break row grid.
- U9 Locals buried mid-sidebar; no collapsible panels.
- U10 empty state is bare dashes.

Features:
- F1 inline values in editor when stopped.
- F2 run to cursor / set next statement (DAP `goto`).
- F3 journal timeline: what the agent did, click a past stop to see its locals.
- F4 follow-the-agent: tab tracks agent's file/line, pink flash.
- F5 data breakpoints (DAP `dataBreakpoints`), entry from memory view.

Remove:
- R1 `importHistory` cmd (one-shot migration, no users).
- R2 `.claude/skills/speckit-*` + `.specify/` + `specs/` if unused.
- R3 duplicate committed images (`docs/shots` jpg + `docs/images` png).

## Phase 0: security (S1), done

Shipped: loopback-only listener (`listenLocal`, milo `TcpListener.bindAddr`), Host must be
loopback, Origin when present must be own origin, `tests/e2e-security.ts`, each check
mutation-tested. Also fixed a WS fd use-after-close found by the suite: a peer that drops
while its writer still has frames queued killed the server or wrote into a reused fd; R now
joins W before releasing the socket.

Deferred: per-session token. With tunnels dropped it only guards against other local users
on a shared machine; revisit if that matters.

Original plan:

- Reject `/api` + WS upgrade unless `Origin` absent (CLI) or equals own origin.
- Reject `Host` not `localhost` / `127.0.0.1` / `[::1]` (blocks DNS rebinding).
- Per-session random token: written to the session registry, sent by `dapweb api` as a
  header, injected into served `index.html` for the browser (same-origin only).
- Bind 127.0.0.1 explicitly. No tunnel support (decided): drop `x-forwarded-proto` handling.
- Test: new `tests/e2e-security.ts`: cross-origin POST, bad Host, missing/wrong token
  all rejected; CLI + browser paths still work. Confirm each check fails when its code is
  removed.

## Phase 1.5: zero `unsafe` in dapweb (new)

25 `unsafe` blocks in `src/` (24 in server.milo), nearly all one pattern: self-pipes to wake
green tasks, plus a `usleep` ticker thread. Root cause was Channel not parking green tasks;
std `Channel.recv` parks now.
- Replace wake pipes with `Channel.recv`; replace ticker with a green timer (add to std if
  missing); anything else raw (pty, fd IO) gets a safe std wrapper.
- Gate: `scripts/test.sh` fails if `unsafe` appears under `src/`.

Milo upstream items found on the way:
- `readFd`/`sendFd`/`recvFd` `exit(1)` when fcntl fails, including EBADF on POSIX. Should
  return -1; exiting turns a caller's fd bug into a crash with a misleading message.
- Scoped tasks (structured concurrency): a task spawned in a scope joins before scope exit,
  so it can borrow (`&conn`) instead of laundering an fd through `i32`. Makes the WS
  use-after-close unrepresentable rather than fixed.

## Phase 1: UI quick wins (U1-U10, S8), done

Shipped in two batches plus a primary call-to-action button (Run / Pause / Continue /
Run again), exit code in the pill, and empty states that name the next step.

Independent, small, one commit each. Order: U3, U1, U2, U7, U4, U6, U5, U10, U9, U8, S8.
- Test: existing e2e suites; add assertions for stop reason text (U3) and disambiguated
  tab labels (U1). Regenerate README shots at end of phase.

## Phase 2: server state + split (S2, S3, S4)

1. `Session` struct owns all session globals; `snapshot(): Json` replaces the cached
   replay strings. Hello for a new tab, `api state`, and the journal all read the same snapshot.
2. Parse each DAP frame once; extractors take `&Json`.
3. Dispatch: handler per `CmdSpec` entry, not an if-chain.
4. Split `server.milo` along seams: `dap_reader`, `dispatch`, `http`, `persist`
   (history/bps), `session_state`. Move the cluster needing fewest new exports first.
- Test: all suites green after every step; new late-join test asserts the snapshot a fresh
  tab gets == state a tab that watched live holds (stopped, threads, regions, caps, bps).
- Number: `server.milo` lines (3730 → target < 800, rest in modules).

Canonical-Milo cleanup folded into this phase:
- Remove pre-builder JSON helpers (`jStr`/`dStr`/`jObjRaw`, `var Q = "\""`), string-concat
  arrays (`/api/log`).
- One query-string parser (handleConnection has two copy-pasted loops).
- Index `while` loops → `for` / `join` where idiomatic.
- Survey milo std for no-copy idioms (span/freeze/seal, arena) before designing `Session`.
- Replace hand-rolled HTTP with std/http once it supports WS upgrade.

## Phase 3: UI state + split (S6)

- One reducer over the server event stream; its state shape mirrors `snapshot()`.
  Reset per-stop state on terminate: Registers still shows the last stop after exit.
  Pill says "paused on breakpoint" for stop-at-main (it is a breakpoint underneath);
  say "paused at main".
- Extract `MemView`, `RegistersPanel`, `StackView`, `DebugConsole`, `VarList` into files.
- Test: all suites green; `App.tsx` lines (2557 → target < 800).

## Phase 4: multi-client groundwork (S7)

- `Session` holds `Vec<DapClient>`; events tagged with child session id.
- Unblocks M10 (js-debug `startDebugging`). Do the design before Phase 2 step 4 locks file
  boundaries; implement here.

## Phase 5: features

Order: F1 inline values → F2 goto → F4 follow agent → F3 timeline → F5 data bps.
Each one gets an e2e test driven through `dapweb api` plus a browser assertion.

## Phase 5.5: landing page (new)

Inspiration: messenger.com. Huge bold headline in the accent colour, lots of whitespace,
copy + install one-liner on the left, overlapping tilted screenshots on the right (browser
UI over a terminal running `dapweb api`: the "one session, two peers" story), animated mark
in place of the mascot.
Decided: GitHub Pages (`docs/site/index.html`, static), light page with the dark app
screenshots. README links to it.

## Phase 6: cleanup (S5, R1-R3)

- Rewrite `design.md` as open work + hard-won facts only; fold this roadmap in when done.
- Delete R1.
- R2: delete speckit (`.claude/skills/speckit-*`, `.specify/`, `specs/`).
- R3: keep `docs/images` (what README shows); stop committing `docs/shots` (gitignore,
  local input to `annotate-shots.py`). No CI regeneration.
- Gate audit: every suite fails when its feature is broken (stub out handler, confirm red).

## Decisions (2026-10-05)

- Tunnels: dropped, localhost only.
- speckit: delete.
- Images: keep `docs/images` only; no CI regeneration.
- Timeline (F3): read-only replay of recorded stops (journal already has them); re-run to
  a past point is out of scope.
- Order: as above, UI quick wins before the server refactor.
