# dapweb

<p align="center">
  <img src="docs/images/debugging.png" alt="dapweb stopped at a breakpoint: source view, call stack, nested locals, and a terminal showing both the program's output and the agent's last command" width="900">
</p>

A browser front end for any DAP debugger, built so that you and an AI agent can
drive the same debuggee at the same time.

**[Download](https://github.com/milo-language/dapweb/releases/tag/latest)** ·
**[Docs](https://milo-language.github.io/milo/)** ·
built in [Milo](https://github.com/milo-language/milo)

## The debuggers

dapweb drives a debugger through its Debug Adapter Protocol front end, which by
now is nearly all of them. Five are known by name; the rest are the same thing
with the path spelled out:

| adapter | languages | how dapweb finds it |
| --- | --- | --- |
| **lldb-dap** | C, C++, Objective-C, Rust, Swift, Zig | `lldb-dap` on `PATH`, else `xcrun -f lldb-dap` |
| **debugpy** | Python | `python3 -m debugpy.adapter` |
| **Delve** | Go | `dlv dap` |
| **js-debug** | JavaScript, TypeScript | `js-debug-adapter` on `PATH`, else `~/.local/share/dapweb/js-debug` |
| **java-dap** | Java, and anything else on JDWP | `java-dap` on `PATH` |
| **any other DAP adapter** | everything else | `--dapPath "gdb -i dap"`, `--dapPath /path/to/adapter` |

That last row is not a footnote: CodeLLDB, `gdb -i dap` (gdb 14+), netcoredbg for
C#/.NET, rdbg for Ruby, Xdebug for PHP, earlybird for OCaml, probe-rs and
cortex-debug for embedded targets all arrive on the same protocol over the same
transport. The five above are the ones dapweb can find without being told where.

```sh
./dapweb web --dapPath /path/to/some-dap-adapter --program ./a.out
```

## An agent is a first-class user

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

```console
$ dapweb api step --pretty
{
  "type": "stopped",
  "line": 24,
  "path": "/src/examples/nested/main.c",
  "tid": 11751168,
  "frames": [
    { "id": 1572864, "name": "main", "line": 24, "path": "/src/examples/nested/main.c", "ipRef": "0x1026285AC" },
    { "id": 1572865, "name": "start", "line": 1797, "path": "/usr/lib/dyld`start", "ipRef": "0x189981D54" }
  ],
  "locals": [
    { "name": "shapes", "value": "Shape[2]", "type": "Shape[2]", "ref": 4, "mref": "0x16D7D6918" },
    { "name": "list", "value": "0x0000000102c0dcb0", "type": "Node *", "ref": 5, "mref": "0x16D7D6858" },
    { "name": "p", "value": "5.196152422706632", "type": "double", "ref": 0, "mref": "0x16D7D6838" }
  ]
}
```

Without `--pretty` it is one line per reply, which is what a pipe wants. A `ref`
is expandable (`dapweb api request '{"cmd":"expand","ref":4}'`), an `mref` is a
memory address the same session can read.

## What it does

Debugging:

- Every source file the stop walks through, in tabs, with syntax highlighting
  (including `.milo`).
- Click the gutter to set a breakpoint; conditions, hit counts and log points on
  any of them, enable/disable without deleting, and they persist per program
  between runs.
- Run, continue, pause, step over/in/out, restart, stop, stop-at-main, and
  single instruction stepping.
- Call stack with frame selection, thread list, locals as a tree that expands
  through nested structs and pointers, editable values, watch expressions, and
  exception filters.
- Evaluate anything in the frame you are stopped in, from the console or the
  watch panel, with tab completion.

Down at the machine:

- Disassembly, inline under each source line or in its own pane beside it.
- Registers, grouped and editable.
- A memory viewer with typed annotations on the bytes, pointer following, and a
  radix toggle; a stack pane that shows the current frame's slots.

Targets and sessions:

- Launch a program, or attach to a running one picked by name instead of pid.
- VS Code launch configurations, verbatim: `--launch launch.json --config name`,
  an editor for the config in the UI, and a history of the targets you have run.
- **info** reads the binary's headers and says whether it carries debug info at
  all, which is the usual reason a session runs but shows no source.
- Program output and adapter output in a real terminal, in one pane, tagged so
  the two streams never blur.
- Every live dapweb on the machine is listed at `/sessions`, each under a
  three-word name you can say out loud.

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
