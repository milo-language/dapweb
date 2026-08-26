# dapweb

<p align="center">
  <img src="docs/images/debugging.png" alt="dapweb stopped at a breakpoint: source view, call stack, locals, and an lldb terminal" width="900">
</p>

A browser front end for any DAP debugger — lldb, debugpy, delve. One session,
shared: your tab and an AI agent drive the same debuggee at the same time.

**[Download](https://github.com/milo-language/dapweb/releases/tag/latest)** ·
**[Docs](https://milo-language.github.io/milo/)** ·
built in [Milo](https://github.com/milo-language/milo)

## Install

```sh
P=$(uname -s | tr A-Z a-z)-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
curl -fsSL https://github.com/milo-language/dapweb/releases/download/latest/dapweb-$P.tar.gz | tar xz
cd dapweb-$P && ./dapweb /path/to/your-binary
```

Use `curl`, not a browser download: macOS quarantines the archive and kills the
unsigned binary on first run. Re-run the command to update.

## Using it

Type a path and press Enter; arguments go on the same line, shell-split.

![the target bar in launch mode](docs/images/launch-args.gif)

Click **LAUNCH** to flip to **ATTACH** and pick a running process by name.

![the target bar in attach mode](docs/images/attach.gif)

Click **info** to find out whether the binary carries debug info at all — the
usual reason a session runs but shows no source.

| carries DWARF | built without `-g` |
|---|---|
| ![binary with debug info](docs/images/binary-info.png) | ![binary without debug info](docs/images/binary-info-nodebug.png) |

An agent announces each command before it runs, and its breakpoints appear in
your gutter as it sets them.

![an agent driving the session](docs/images/agent-activity.gif)

Disassembly inline under each source line, or in a pane beside it.

![inline disassembly](docs/images/asm-inline.png)

Milo sources get syntax highlighting; `milo build x.milo -o x -g --debug` emits
the DWARF.

![debugging a Milo program](docs/images/milo-source.png)

⚙ opens the launch configuration itself — a verbatim VS Code launch config, so
anything from your `.vscode/launch.json` works unchanged.

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

Nothing is fetched at runtime; `tests/hermetic.ts` enforces that. `test.sh`
compiles its debuggees from the repo root on purpose, because lldb binds
breakpoints on the full DWARF path and a fixture built elsewhere records a path
nothing references.

Architecture and roadmap: `docs/design.md`.
