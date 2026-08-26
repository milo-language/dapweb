# dapweb

<p align="center">
  <img src="docs/images/debugging.png" alt="dapweb stopped at a breakpoint: source view, call stack, locals, and an lldb terminal" width="900">
</p>

Web + AI interface for any DAP debugger. Written in [Milo](https://github.com/milo-language/milo).

**[Documentation](https://milo-language.github.io/milo/)** ·
**[Download a release](https://github.com/milo-language/dapweb/releases/tag/latest)**

## Install

```sh
P=$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
curl -fsSL https://github.com/milo-language/dapweb/releases/download/latest/dapweb-$P.tar.gz | tar xz
cd dapweb-$P
./dapweb /path/to/your-binary
```

Download through a browser instead and macOS quarantines the archive: the unsigned
binary is killed on first run and moved to the Trash. Either install with `curl` as
above, or clear the flag with `xattr -dr com.apple.quarantine <dir>` before running.

`--version` prints the commit the binary was built from. Releases roll on the `latest`
tag, so re-running the install command is the update path.

One binary, two subcommands:

- **`dapweb web`** — React + Monaco + xterm.js served by a Milo HTTP/WebSocket server that drives a DAP adapter (lldb-dap, debugpy, delve). Breakpoints (Monaco glyph gutter), stepping, threads, call stack, expandable locals, watch expressions, a debug console (full lldb command access), and a real PTY terminal — type into your program *while it runs*. Fully self-hosted: no CDN assets, nothing fetched at runtime (`bun tests/hermetic.ts` enforces it). Say what to debug in the toolbar's target bar; the full VS Code launch-configuration JSON lives behind ⚙ for the cases the bar cannot express.
- **`dapweb api`** — drive that same session from the CLI. Every verb is the exact `{"cmd": ...}` JSON the browser sends, so an agent, a shell script, or plain `curl` can list sessions, set breakpoints, run, step, and evaluate — no browser, no MCP. `dapweb api request` forwards arbitrary DAP-shaped JSON, so any adapter capability works with no new subcommand.
- **Shared session** — `dapweb web` hosts ONE session; every browser tab and every `dapweb api` call see and drive the same debuggee. Stop in the browser, have an agent evaluate an expression over `dapweb api`, watch the result appear in the UI.

## Build

```sh
src/web/ui/build.sh                                  # bundle UI → src/web/ui/dist (bun)
bun run ../milo/src/main.ts build src/main.milo -o dapweb
```

`build.sh` must run before `milo build`: the UI bundle is compiled into the binary with `embedFile()`, so a release is a single self-contained file that runs from any directory. For UI work, `--webroot src/web/ui/dist` serves from disk instead — `build.sh` + a browser refresh, no server rebuild.

## Run

```sh
# The 90% invocation: a path implies `web`, trailing tokens are the debuggee's argv.
clang -g -O0 examples/interactive.c -o /tmp/demo
./dapweb /tmp/demo alpha --beta

# Boots idle — open http://localhost:8080 and configure the target in the ⚙ drawer.
./dapweb web --port 8080

# Name the target with flags. --source is optional: the first stop's DWARF
# frame path auto-loads the editor. Type is inferred (.py → debugpy, .go → delve).
./dapweb web --program /tmp/demo --port 8080
./dapweb web --program demo.py

# --launch takes a VS Code launch configuration (inline JSON or a file path;
# any launch.json keys pass through to the adapter — args/env/cwd/initCommands/…)
./dapweb web --launch '{"type":"lldb","program":"/tmp/demo","args":["alpha"],"env":{"K":"V"}}'
./dapweb web --launch '{"type":"lldb","request":"attach","pid":12345}'
# …or a whole .vscode/launch.json; pick an entry by name
./dapweb web --launch .vscode/launch.json --config "debug tests"

# Drive a running session from the CLI (an agent, a script, or you).
./dapweb api list                          # live sessions (auto-prunes dead ones)
./dapweb api break --line 12               # set a breakpoint
./dapweb api run                           # launch; blocks until the first stop
./dapweb api eval 'x + 1'                  # evaluate in the current stop frame
./dapweb api state                         # JSON snapshot (phase, stop, stack, bps)

# Raw passthrough: any DAP-shaped command, block for a reply type of your choosing.
./dapweb api request --await stopped '{"cmd":"continue"}'
```

With one live session, `api` finds it automatically; with several, pass `--session <id>`
or `--port <n>`. Run `dapweb <command> --help` (or `dapweb api`) for the full command list.

> The API and WebSocket bind to whatever `dapweb web` listens on and are unauthenticated —
> `eval` reaches the debugger, so treat an exposed port as remote code execution. Keep it on
> localhost unless you intend otherwise.

## Using it

### Launch a program

Type the path in the target bar and press Enter. Arguments go on the same line,
shell-style, so `--flag "two words"` survives as one argument:

![the target bar in launch mode](docs/images/launch-args.png)

Focus the bar to get the recent targets. Breakpoints are remembered per program
and come back the next time you debug it, conditions included.

### Attach to a running process

Click **LAUNCH** to flip it to **ATTACH**. Nobody remembers a pid, so the bar
lists the running processes and filters as you type — pick one and it fills in:

![the target bar in attach mode](docs/images/attach.gif)

A pid works too. The bar writes the key the adapter actually wants (`pid` for
lldb, `processId` for debugpy and delve), so the config stays a launch.json you
could paste anywhere.

### Anything the bar cannot say

⚙ opens the launch configuration itself — env, cwd, `initCommands`, `justMyCode`,
whatever your adapter takes. It is a verbatim VS Code launch config, so a config
from your `.vscode/launch.json` or an answer on Stack Overflow works unchanged.
Esc closes it.

### Is this binary even debuggable?

The commonest reason a session runs but shows no source is a binary built without
`-g`, and nothing in a debugger usually tells you. Click **info** on the target
bar:

| carries DWARF | built without `-g` |
|---|---|
| ![binary with debug info](docs/images/binary-info.png) | ![binary without debug info](docs/images/binary-info-nodebug.png) |

It reads the headers only (ELF, Mach-O, PE, universal) and reports format, arch,
whether the symbol table survived, and where the debug info lives — including a
companion `.dSYM`, which is where `clang -g` leaves it on macOS.

### Let an agent drive while you watch

`dapweb api` and your browser share one session. An agent's commands are
announced in the debug console *before* they run, and its breakpoints show up in
your gutter as it sets them — so a program that moves on its own is never
unexplained:

![an agent driving the session](docs/images/agent-activity.gif)

```sh
dapweb api break --line 23 --path examples/nested/main.c
dapweb api request --await stopped '{"cmd":"continue"}'
dapweb api eval 'shapes[0].name'
```

The name in the console comes from `$DAPWEB_AGENT`, or `claude` when Claude Code
set `CLAUDECODE` in the environment.

### Down to the instructions

Two disassembly views: a pane beside the source, or the generated instructions
inline under each source line. Both track the pc, and instruction-level stepping
appears in the toolbar while they are open.

![inline disassembly](docs/images/asm-inline.png)

...or side by side, when you want to read a whole function's worth at once:

![disassembly beside the source](docs/images/asm-split.png)

### Milo

Milo programs debug like any other native target — `milo build x.milo -o x -g
--debug` emits DWARF — with syntax highlighting for `.milo` sources:

![debugging a Milo program](docs/images/milo-source.png)

## Tests

```sh
scripts/build.sh        # dapweb binary + UI bundle
scripts/test.sh         # every suite against that build, each on its own server
scripts/test.sh agent   # one suite (substring match on the filename)
```

`scripts/test.sh` compiles the debuggees from the repo root on purpose: lldb binds
breakpoints on the full DWARF path, so a fixture built from anywhere else records
a path nothing references and every breakpoint silently fails to bind.

Architecture and roadmap: `docs/design.md`.
