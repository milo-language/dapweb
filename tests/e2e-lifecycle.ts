// E2E for what outlives the server. A launched debuggee stopped under lldb-dap
// used to survive its server's death forever (state T, parent 1): SIGTERM had no
// handler and SIGKILL runs none, and the pty hangup's SIGHUP is swallowed by the
// tracer, which then exits leaving the process stopped. Now SIGTERM ends the run
// before exiting and the reaper (src/web/reaper.milo) covers SIGKILL. An ATTACHED
// process was running before us: it must survive both, detached and running.
//
// Usage: bun tests/e2e-lifecycle.ts [binary]

import { freePort } from "./freeport";
const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const tag = `/tmp/dapweb_lifecycle_${process.pid}`;
const xdg = `${tag}_state`;
// Its own copy, so the pid search below cannot pick up another suite's debuggee.
const nested = `${tag}_nested`;
const spin = `${tag}_spin`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms));

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); cleanup(); process.exit(1); }
}

class Peer {
  ws!: WebSocket; queue: any[] = []; waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  async connect(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      const i = this.waiters.findIndex(w => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m); else this.queue.push(m);
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(o: any) { this.ws.send(JSON.stringify(o)); }
  wait(pred: (m: any) => boolean, ms = 20000): Promise<any> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return Promise.race([new Promise<any>(r => this.waiters.push({ pred, resolve: r })), timeout(ms)]);
  }
}

type Row = { pid: number; ppid: number; stat: string; args: string };
function ps(): Row[] {
  const out = new TextDecoder().decode(Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,stat=,args="]).stdout);
  return out.split("\n").map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: +m![1], ppid: +m![2], stat: m![3], args: m![4] }));
}
const row = (pid: number) => ps().find(r => r.pid === pid);
// Gone, or a zombie its new parent has not collected yet: either way not running.
const gone = (pid: number) => { const r = row(pid); return !r || r.stat.startsWith("Z"); };
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 100) { if (pred()) return true; await sleep(100); }
  return pred();
}

const spawned: number[] = [];
function cleanup() {
  for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch {} }
}

async function spawnSrv(extra: string[]): Promise<{ srv: any; port: number }> {
  const port = await freePort();
  const srv = Bun.spawn([bin, "web", "--port", String(port), "--quiet", ...extra], {
    cwd: root, stdout: "ignore", stderr: "ignore",
    env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg },
  });
  spawned.push(srv.pid);
  for (let i = 0; i < 60; i++) {
    try { const t = new Peer(); await t.connect(port); t.ws.close(); return { srv, port }; }
    catch { await sleep(100); }
  }
  throw new Error("server never came up");
}

function compile(args: string[]) {
  const r = Bun.spawnSync(["clang", "-g", "-O0", ...args], { cwd: root });
  if (r.exitCode !== 0) { console.error(new TextDecoder().decode(r.stderr)); process.exit(1); }
}
// From the repo root, so the DWARF path is examples/nested/main.c, which is what
// the breakpoint below names.
compile(["examples/nested/main.c", "examples/nested/shapes.c", "-o", nested, "-lm"]);

// ── a launched debuggee dies with its server ──

for (const sig of ["SIGTERM", "SIGKILL"] as const) {
  const { srv, port } = await spawnSrv(["--program", nested, "--source", "examples/nested/main.c"]);
  const a = new Peer(); await a.connect(port);
  const hello = await a.wait(m => m.type === "hello");
  a.send({ cmd: "setBreakpoint", path: hello.sourcePath, line: 23 });
  await a.wait(m => m.type === "breakpoint" && m.line === 23);
  a.send({ cmd: "run", stopAtMain: false });
  const st = await a.wait(m => m.type === "stopped");
  ok(st.line === 23, `${sig}: the nested demo stopped at its breakpoint (line ${st.line})`);

  const dbg = ps().find(r => r.args.split(" ")[0] === nested);
  ok(dbg, `${sig}: the debuggee is running under lldb-dap`, ps().filter(r => r.args.includes(tag)));
  const reaper = ps().find(r => r.ppid === srv.pid && r.args.includes("__reaper"));
  ok(reaper, `${sig}: the server started its reaper`);

  srv.kill(sig);
  await srv.exited;
  ok(await until(() => gone(dbg!.pid), 3000),
     `${sig}: the stopped debuggee is gone once its server is`, row(dbg!.pid));
  ok(await until(() => gone(reaper!.pid), 4000),
     `${sig}: the reaper exits too (it cannot outlive the server)`, row(reaper!.pid));
  a.ws.close();
}

// ── an attached process is detached, never killed ──

// Linux's yama ptrace_scope=1 (stock Ubuntu) refuses an attach to a process that is
// not the debugger's child, so there is nothing to observe there.
const scope = await Bun.file("/proc/sys/kernel/yama/ptrace_scope").text().catch(() => "0");
if (scope.trim() !== "0") {
  console.log(`  skip attach cases: ptrace_scope=${scope.trim()} forbids attaching to a non-child`);
} else {
  await Bun.write(`${spin}.c`, "#include <unistd.h>\nint main(void) { for (int i = 0; i < 600; i++) sleep(1); return 0; }\n");
  compile([`${spin}.c`, "-o", spin]);
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    const target = Bun.spawn([spin], { stdout: "ignore", stderr: "ignore" });
    spawned.push(target.pid);
    const { srv, port } = await spawnSrv([]);
    const a = new Peer(); await a.connect(port);
    await a.wait(m => m.type === "hello");
    a.send({ cmd: "run", stopAtMain: true,
             config: { type: "lldb", name: "attach spin", request: "attach", pid: target.pid } });
    await a.wait(m => m.type === "stopped");
    ok(/[tT]/.test(row(target.pid)?.stat ?? ""), `${sig}: the attached process is stopped under the debugger`, row(target.pid));

    srv.kill(sig);
    await srv.exited;
    ok(await until(() => !/[tT]/.test(row(target.pid)?.stat ?? ""), 4000) && !gone(target.pid),
       `${sig}: the attached process survives its server, running again`, row(target.pid));
    target.kill("SIGKILL");
    a.ws.close();
  }
}

cleanup();
for (const p of [nested, `${nested}.dSYM`, spin, `${spin}.dSYM`, `${spin}.c`, xdg]) {
  Bun.spawnSync(["rm", "-rf", p]);
}
console.log(`\ne2e-lifecycle: ${pass} assertions passed`);
