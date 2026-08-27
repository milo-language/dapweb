// E2E for what "stop at main" means on an attach. An attached process is
// already past main, so the function breakpoint that stops a launch there can
// never hit: left as-is, the adapter resumed at configurationDone and the user
// got no stop at all. On attach the same toggle has to ride in the attach body
// as stopOnEntry, which is what holds the process where it is.
//
// Driven against tests/stub-adapter.ts, not lldb-dap: stock Ubuntu's
// kernel.yama.ptrace_scope=1 forbids attaching to a process that is not our
// child, so a real attach cannot be a CI gate. The stub records every request
// dapweb sends, which is exactly what this is asserting about.
//
// Usage: bun tests/e2e-attach.ts [binary]

const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_attach_test_${process.pid}`;
const nested = "/tmp/dapweb_nested";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms));

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
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

let port = 8190;
async function spawnSrv(log: string): Promise<any> {
  const p = port++;
  const srv = Bun.spawn([bin, "web", "--port", String(p), "--quiet"], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg, STUB_LOG: log },
  });
  for (let i = 0; i < 60; i++) {
    try { const t = new Peer(); await t.connect(p); t.ws.close(); return { srv, port: p }; }
    catch { await sleep(100); }
  }
  throw new Error("server never came up");
}

// Every request dapweb sent to the adapter, in order.
async function reqs(log: string): Promise<any[]> {
  const text = await Bun.file(log).text().catch(() => "");
  return text.split("\n").filter(Boolean).map(l => JSON.parse(l));
}
const dapPath = `bun ${root}/tests/stub-adapter.ts`;

// ── attach: the toggle is stopOnEntry, and main is never breakpointed ──

{
  const log = `/tmp/dapweb_attach_log_${process.pid}_a.jsonl`;
  await Bun.write(log, "");
  const { srv, port: p } = await spawnSrv(log);
  const a = new Peer(); await a.connect(p);
  await a.wait(m => m.type === "hello");

  a.send({ cmd: "run", stopAtMain: true,
           config: { type: "lldb", name: "attach stub", request: "attach", pid: 4242, dapPath } });
  const stop = await a.wait(m => m.type === "stopped");
  ok(stop, "attach with stop-at-main produces a stop", stop?.reason);
  // The stub frames with a lower-case "content-length", which the base protocol
  // allows and dapweb's own framing used to reject. Reaching a stop at all is
  // the assertion: a case-sensitive reader never finds a header here.
  ok(stop, "a conformant lower-case Content-Length header is accepted", stop?.reason);

  const sent = await reqs(log);
  const attach = sent.find(r => r.command === "attach");
  ok(attach, "dapweb sent `attach`, not `launch`", sent.map(r => r.command));
  ok(attach?.arguments?.stopOnEntry === true,
     "the attach body carries stopOnEntry:true", attach?.arguments);
  ok(attach?.arguments?.pid === 4242, "the attach body carries the pid", attach?.arguments);
  ok(!sent.some(r => r.command === "setFunctionBreakpoints"),
     "no `main` function breakpoint on an attach (main already ran)",
     sent.filter(r => r.command === "setFunctionBreakpoints").map(r => r.arguments));

  a.send({ cmd: "kill" });
  await a.wait(m => m.type === "terminated").catch(() => null);
  srv.kill();
}

// ── launch: unchanged. main IS breakpointed, and stopOnEntry stays off ──

{
  const log = `/tmp/dapweb_attach_log_${process.pid}_l.jsonl`;
  await Bun.write(log, "");
  const { srv, port: p } = await spawnSrv(log);
  const a = new Peer(); await a.connect(p);
  await a.wait(m => m.type === "hello");

  a.send({ cmd: "run", stopAtMain: true,
           config: { type: "lldb", name: "launch stub", program: nested, dapPath } });
  await a.wait(m => m.type === "stopped");

  const sent = await reqs(log);
  const launch = sent.find(r => r.command === "launch");
  ok(launch, "dapweb sent `launch`", sent.map(r => r.command));
  ok(launch?.arguments?.stopOnEntry === false,
     "a launch still stops via the breakpoint, not stopOnEntry", launch?.arguments);
  const fb = sent.find(r => r.command === "setFunctionBreakpoints");
  ok(fb?.arguments?.breakpoints?.[0]?.name === "main",
     "a launch breakpoints `main`", fb?.arguments);

  a.send({ cmd: "kill" });
  await a.wait(m => m.type === "terminated").catch(() => null);
  srv.kill();
}

console.log(`\ne2e-attach: ${pass} assertions passed`);
