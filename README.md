# dapweb

<p align="center">
  <img src="docs/images/debugging.png" alt="dapweb stopped at a breakpoint: source view, call stack, locals, and an lldb terminal" width="900">
</p>

A browser front end for any DAP debugger, built so that you and an AI agent can
drive the same debuggee at the same time.

**[Download](https://github.com/milo-language/dapweb/releases/tag/latest)** ·
**[Docs](https://milo-language.github.io/milo/)** ·
built in [Milo](https://github.com/milo-language/milo)

## The debuggers

Every debugger worth using now ships a Debug Adapter Protocol front end, so
dapweb talks to that instead of to any one debugger's own API. Four of them it
finds by itself:

| adapter | languages | how dapweb finds it |
| --- | --- | --- |
| **lldb-dap** | C, C++, Objective-C, Rust, Swift, Zig | `lldb-dap` on `PATH`, else `xcrun -f lldb-dap` |
| **debugpy** | Python | `python3 -m debugpy.adapter` |
| **Delve** | Go | `dlv dap` |
| **java-dap** | Java, and anything else on JDWP | `java-dap` on `PATH` |

Those four it probes for by name; the test suite itself runs on lldb-dap. Every
other DAP adapter speaks the same protocol over the same stdio transport, so it
is one flag away: CodeLLDB, `gdb --interpreter=dap` (gdb 14+), netcoredbg for
C#/.NET, rdbg for Ruby, Xdebug for PHP, earlybird for OCaml, probe-rs and
cortex-debug for embedded targets.

```sh
./dapweb web --dapPath /path/to/some-dap-adapter --program ./a.out
```

(`js-debug` for Node/TypeScript is recognised as a launch `type` but refuses to
start: that slot is still empty.)

## AI-first

The browser tab is a client of the session, not the session. Every action in the
UI is a `{"cmd": ...}` message, and `dapweb api` sends those same messages from a
shell, so an agent needs no separate protocol, no headless mode, and no second
copy of the program under test.

![dapweb api stepping the session, and the browser tab showing the same stop](docs/images/api-and-browser.png)

One session, two views: the agent's `step` moved the program, and the tab that
was already open is on the new line with the new locals. It goes the other way
too: the agent announces each command before it runs and its breakpoints appear
in your gutter, so a program that moves on its own is never unexplained.

![an agent driving the session](docs/images/agent-activity.gif)

## Install

```sh
P=$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
curl -fsSL https://github.com/milo-language/dapweb/releases/download/latest/dapweb-$P.tar.gz | tar xz
cd dapweb-$P && ./dapweb /path/to/your-binary
```

Use `curl`, not a browser download: macOS quarantines the archive and kills the
unsigned binary on first run. Re-run the command to update.

## Using it

Point it at a program, click a line to break on it, press Run. That is the whole
loop:

![a dapweb session, start to finish](docs/images/session.gif)

Click **LAUNCH** to flip the bar to **ATTACH** and pick a running process by name
instead of hunting for its pid:

![the target bar in attach mode](docs/images/attach.gif)

Also there: **info** on the target bar reads the binary's headers and tells you
whether it carries debug info at all (the usual reason a session runs but shows
no source); disassembly inline under each source line or in a pane beside it;
syntax highlighting for `.milo` sources; and ⚙ for the launch configuration
itself, a verbatim VS Code launch config.

## CLI

```sh
./dapweb /tmp/demo alpha --beta   # a path implies `web`; trailing tokens are argv
./dapweb web --port 8080          # boot idle, set the target in the browser
./dapweb web --launch .vscode/launch.json --config "debug tests"
```

`dapweb api` drives a running session with the same `{"cmd":...}` JSON the
browser sends, so an agent or a shell script needs no separate protocol:

```sh
./dapweb api list                 # live sessions
./dapweb api break --line 12
./dapweb api run                  # blocks until the first stop
./dapweb api step --pretty        # step, and indent the reply for a human
./dapweb api eval 'x + 1'
./dapweb api request --await stopped '{"cmd":"continue"}'
```

With one live session `api` finds it; otherwise pass `--session <id>` or
`--port <n>`. `dapweb <command> --help` lists the rest.

> Unauthenticated, and `eval` reaches the debugger — an exposed port is remote
> code execution. Keep it on localhost.

## Develop

```sh
scripts/build.sh        # UI bundle, then the binary that embeds it
scripts/test.sh         # every suite against that build, each on its own server
scripts/test.sh agent   # one suite (substring match)
```

The README images are generated, not hand-cropped: `docs/shots/` holds the raw
screenshots and `docs/*.json` the callouts drawn over them.

```sh
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install Pillow
/tmp/venv/bin/python scripts/annotate-shots.py docs/session-story.json
/tmp/venv/bin/python scripts/annotate-shots.py docs/pair.json
```
