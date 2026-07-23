// E2E for `dapweb api`: the CLI drives a live `dapweb web` session over HTTP with
// the same {"cmd":...} vocabulary the browser uses. Spawns a server on a throwaway
// $XDG_STATE_HOME (so its session registry can't collide with a real one), then
// shells out to `dapweb api` exactly as an agent would.
// Usage: bun tests/api.ts [binary]   (needs a debuggable /tmp/dapweb_api_demo)

const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_api_test_${process.pid}`;
const src = "/tmp/dapweb_api_demo.c";
const exe = "/tmp/dapweb_api_demo";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}

// A small multi-line debuggee with a loop, so `run`/`step`/`continue` have
// distinct lines to stop on.
await Bun.write(src, `#include <stdio.h>
int main(void) {
    int s = 0;
    for (int i = 0; i < 3; i++) {
        s += i;
        printf("%d\\n", s);
    }
    return 0;
}
`);
{
  const c = Bun.spawnSync(["clang", "-g", "-O0", src, "-o", exe]);
  if (c.exitCode !== 0) { console.error("clang failed:", c.stderr.toString()); process.exit(1); }
}

const port = 8700 + (process.pid % 200);
const srv = Bun.spawn([bin, "web", "--program", exe, "--port", String(port), "--quiet"], {
  cwd: root,
  env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg },
  stdout: "ignore", stderr: "ignore",
});
await sleep(2500);

// Run `dapweb api <args>` and parse the last stdout line as JSON (typed commands
// print one JSON object; `list` prints a table, handled separately).
async function api(args: string[]): Promise<{ code: number; out: string; json: any }> {
  const p = Bun.spawn([bin, "api", "--port", String(port), ...args], {
    cwd: root, env: { ...process.env, XDG_STATE_HOME: xdg }, stdout: "pipe", stderr: "pipe",
  });
  const out = (await new Response(p.stdout).text()).trim();
  const code = await p.exited;
  let json: any = null;
  try { json = JSON.parse(out.split("\n").pop()!); } catch {}
  return { code, out, json };
}

try {
  // list finds the session by reading the registry (no --port needed)
  {
    const p = Bun.spawn([bin, "api", "list"], { cwd: root, env: { ...process.env, XDG_STATE_HOME: xdg }, stdout: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    await p.exited;
    ok(out.includes(String(port)) && out.includes("dapweb_api_demo"), "list shows the live session", out);
  }

  // state before running: idle
  {
    const r = await api(["state"]);
    ok(r.json?.phase === "idle", "state is idle before run", r.json);
  }

  // set a breakpoint inside the loop body, then run — blocks until the stop
  {
    const b = await api(["break", "--line", "5", "--path", src]);
    ok(b.json?.ok === true, "break acks", b.json);
    const run = await api(["run"]);
    ok(run.json?.type === "stopped" && run.json?.line === 5, "run blocks and stops at line 5", run.json);
  }

  // eval auto-fills the frame from the stop, so a constant expression resolves
  {
    const e = await api(["eval", "6 * 7"]);
    ok(typeof e.json?.value === "string" && e.json.value.includes("42"), "eval resolves in the stopped frame", e.json);
  }

  // step over advances a line (needs the real thread id, which the CLI fills in)
  {
    const s = await api(["step", "--timeout", "8000"]);
    ok(s.json?.type === "stopped" && s.json?.line === 6, "step over advances to line 6", s.json);
  }

  // raw passthrough: an arbitrary DAP-shaped command with an explicit await type
  {
    const r = await api(["request", "--await", "stopped", JSON.stringify({ cmd: "continue" })]);
    ok(r.json?.type === "stopped" && r.json?.line === 5, "raw continue loops back to the breakpoint", r.json);
  }

  // await timeout is a distinct non-zero exit code, so scripts can branch on it
  {
    const r = await api(["request", "--await", "nonexistent-type", "--timeout", "800", JSON.stringify({ cmd: "state" })]);
    ok(r.code === 2 && r.json?.error === "timeout", "await timeout exits 2 with a timeout reply", { code: r.code, json: r.json });
  }

  console.log(`\n${pass} checks passed`);
} finally {
  srv.kill();
  await Bun.spawn(["rm", "-rf", xdg]).exited;
}
