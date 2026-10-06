// E2E for the late-join snapshot: a tab that connects mid-stop must end up
// holding exactly the state a tab that watched the whole session live holds
// (source, capabilities, breakpoints, data breakpoints, stop, threads, memory regions,
// terminal output),
// and /api/state must agree with both.
// Needs dapweb web on [port] targeting /tmp/dapweb_nested. Usage: bun tests/e2e-latejoin.ts [port]

const port = process.argv[2] ?? "8092";
const timeout = (ms: number) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Every message is kept in `log` (for folding into state) as well as offered to
// waiters, so the fold sees exactly what a browser would have applied.
class Peer {
  ws!: WebSocket;
  log: any[] = [];
  queue: any[] = [];
  waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  lastAt = Date.now();
  async connect() {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      this.log.push(m);
      this.lastAt = Date.now();
      const i = this.waiters.findIndex(w => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.queue.push(m);
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(obj: any) { this.ws.send(JSON.stringify(obj)); }
  wait(pred: (m: any) => boolean, ms = 20000): Promise<any> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return Promise.race([
      new Promise<any>(resolve => this.waiters.push({ pred, resolve })),
      timeout(ms),
    ]);
  }
  // Until nothing has arrived for `quietMs`: the thread re-polls after a stop
  // keep pushing for ~1s, and a comparison taken mid-burst is a race, not a test.
  async settle(quietMs = 1500) {
    while (Date.now() - this.lastAt < quietMs) await sleep(100);
  }
}

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

// What a client holds after applying `msgs` in order, the way the UI applies
// them: hello is a full resync of breakpoints, a breakpoint ack upserts or
// drops one, and newer stop/threads/regions replace older ones.
function fold(msgs: any[]) {
  const st: any = { source: null, caps: null, bps: new Map<string, any>(), dataBps: [] as any[], stop: null, threads: null, regions: null, output: [] as string[] };
  for (const m of msgs) {
    const bpKey = `${m.path}:${m.line}`;
    const bpVal = () => ({ condition: m.condition, hitCondition: m.hitCondition, logMessage: m.logMessage, enabled: m.enabled });
    switch (m.type) {
      case "hello": st.bps.clear(); break;
      case "bpSync": st.bps.set(bpKey, bpVal()); break;
      case "dataBreakpoints": st.dataBps = m.list; break;
      case "breakpoint": if (m.set) st.bps.set(bpKey, bpVal()); else st.bps.delete(bpKey); break;
      case "source": st.source = { path: m.path, content: m.content }; break;
      case "capabilities": st.caps = m.raw; break;
      case "stopped": st.stop = m; break;
      case "threads": st.threads = m; break;
      case "regions": st.regions = m.regions; break;
      case "output": st.output.push(`${m.category}|${m.text}`); break;
      case "terminated": st.stop = st.threads = st.regions = st.caps = null; break;
    }
  }
  return { ...st, bps: [...st.bps.entries()].sort() };
}

const same = (x: any, y: any) => JSON.stringify(x) === JSON.stringify(y);

// ── the tab that watches everything live ──
const live = new Peer();
await live.connect();
const hello = await live.wait(m => m.type === "hello");
const src = hello.sourcePath;
live.send({ cmd: "setBreakpoint", path: src, line: 23 });
await live.wait(m => m.type === "breakpoint" && m.line === 23);
live.send({ cmd: "setBreakpoint", path: src, line: 24, condition: "i == 1" });
await live.wait(m => m.type === "breakpoint" && m.line === 24);
live.send({ cmd: "setBreakpoint", path: src, line: 26, enabled: false });
await live.wait(m => m.type === "breakpoint" && m.line === 26);
// set then clear: a bp the live tab saw come and go must not reappear in a replay
live.send({ cmd: "setBreakpoint", path: src, line: 20 });
await live.wait(m => m.type === "breakpoint" && m.line === 20 && m.set);
live.send({ cmd: "clearBreakpoint", path: src, line: 20 });
await live.wait(m => m.type === "breakpoint" && m.line === 20 && !m.set);

live.send({ cmd: "run", stopAtMain: true });
await live.wait(m => m.type === "capabilities");
const s0 = await live.wait(m => m.type === "stopped");
ok(s0.line === 14 && s0.atMain === true, `stopped at main, flagged atMain (line ${s0.line}, atMain ${s0.atMain})`);
// A console command puts known text in the output log.
live.send({ cmd: "evaluate", id: 1, expr: "script print('latejoin-marker')", context: "repl" });
await live.wait(m => m.type === "evalResult" && m.id === 1);
live.send({ cmd: "continue", tid: s0.tid });
const s1 = await live.wait(m => m.type === "stopped");
ok(s1.line === 23 && s1.reason === "breakpoint" && s1.atMain === false, `continued to a user breakpoint, not atMain (line ${s1.line}, ${s1.reason}, atMain ${s1.atMain})`);
await live.wait(m => m.type === "threads");
await live.wait(m => m.type === "regions");
// A watchpoint: the list is session state a late tab must be replayed.
live.send({ cmd: "setDataBreakpoint", ref: s1.scopeRef, name: "total" });
await live.wait(m => m.type === "dataBreakpoints" && m.list.length === 1);
await live.settle();

// ── the tab that joins now, mid-stop ──
const late = new Peer();
await late.connect();
await late.wait(m => m.type === "stopped");
await late.settle(800);

const L = fold(live.log);
const J = fold(late.log);

ok(L.source && same(J.source, L.source), "source (path, content) matches", { live: L.source?.path, late: J.source?.path });
ok(L.stop && J.stop, "both tabs hold a stop");
for (const f of ["line", "path", "reason", "tid", "description", "frames", "locals", "scopeRef", "registersRef"]) {
  ok(same(J.stop[f], L.stop[f]), `stop.${f} matches`, { live: L.stop[f], late: J.stop[f] });
}
ok(J.threads && same(J.threads, L.threads), "threads match", { live: L.threads, late: J.threads });
ok(Array.isArray(L.regions) && L.regions.length > 0, "live tab saw memory regions", L.regions);
ok(same(J.regions, L.regions), "regions match");
ok(L.caps && same(J.caps, L.caps), "capabilities match");
ok(L.bps.length === 3, "live tab holds the three breakpoints", L.bps);
ok(same(J.bps, L.bps), "breakpoints match (path, line, condition, enabled)", { live: L.bps, late: J.bps });
ok(L.dataBps.length === 1 && L.dataBps[0].label === "total", "live tab holds the watch on total", L.dataBps);
ok(same(J.dataBps, L.dataBps), "data breakpoints match", { live: L.dataBps, late: J.dataBps });
ok(L.output.some((o: string) => o.includes("latejoin-marker")), "live tab saw the console output", L.output);
ok(same(J.output, L.output), "output lines match", { live: L.output, late: J.output });
ok(late.log.filter(m => m.type === "output").every(m => m.replay === true), "replayed output is flagged replay");

// /api/state is the same snapshot seen from outside a tab.
const api = await (await fetch(`http://localhost:${port}/api/state`)).json();
ok(api.phase === "stopped", "api state says stopped", api.phase);
ok(same(api.stopped, J.stop), "api state stopped == snapshot stop", { api: api.stopped, late: J.stop });
ok(same(api.threads, J.threads), "api state threads == snapshot threads");
ok(same(api.breakpoints.map((b: any) => `${b.path}:${b.line}`).sort(), J.bps.map(([k]: any) => k).sort()),
   "api state breakpoints == snapshot breakpoints");
ok(same(api.dataBreakpoints, J.dataBps), "api state dataBreakpoints == snapshot data breakpoints", api.dataBreakpoints);

live.send({ cmd: "kill" });
await live.wait(m => m.type === "terminated");
live.ws.close();
late.ws.close();

console.log(`e2e-latejoin: ${pass}/${pass} passed`);
process.exit(0);
