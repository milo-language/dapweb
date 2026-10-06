// E2E for data breakpoints (watchpoints), driven through the HTTP API and
// `dapweb api watch` the way an agent would. lldb-dap reports a watchpoint stop
// after the writing instruction retires, so the stop line is the statement AFTER
// the write (examples/watch.c: `local += i` on 16 stops on 17, `g_total += i` on
// 17 stops on 18).
// An adapter without supportsDataBreakpoints (tests/stub-adapter.ts) must be
// refused up front; that part runs on a stub server this suite spawns.
// Needs dapweb web on [port] targeting /tmp/dapweb_watch. Usage: bun tests/e2e-watch.ts [port] [dapweb]

import { freePort } from "./freeport";
const port = process.argv[2] ?? "8092";
const bin = process.argv[3] ?? "./dapweb";
const root = import.meta.dir + "/..";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const http = `http://localhost:${port}`;
let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}
const state = async (base = http) => (await fetch(`${base}/api/state`)).json();
const cmd = (body: any, awaitType = "stopped", base = http) =>
  fetch(`${base}/api/cmd${awaitType ? `?await=${awaitType}&timeout=15000` : ""}`,
        { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

// Every message a tab would have seen, newest last.
function watcher() {
  const seen: any[] = [];
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));
  return { ws, seen, open: new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }) };
}
const live = watcher();
await live.open;

const src = (await state()).sourcePath;
ok(src.endsWith("examples/watch.c"), "server targets examples/watch.c", src);

{
  const r = await cmd({ cmd: "setDataBreakpoint", address: "0x1000", size: 4 }, "dataBreakpoints");
  ok(r.ok === false && /running program/.test(r.error), "a watch with nothing running is refused with a reason", r);
}

await cmd({ cmd: "setBreakpoint", path: src, line: 15 }, "breakpoint");
const s0 = await cmd({ cmd: "run" });
ok(s0.type === "stopped" && s0.line === 15, `stopped on the loop (line ${s0.line})`, s0);
await cmd({ cmd: "clearBreakpoint", path: src, line: 15 }, "breakpoint");

// ── a local, by variablesReference + name ──
const w1 = await cmd({ cmd: "setDataBreakpoint", ref: s0.scopeRef, name: "local" }, "dataBreakpoints");
ok(w1.type === "dataBreakpoints" && w1.list.length === 1, "the watch is in the list", w1);
const local = w1.list[0];
ok(local.label === "local" && local.accessType === "write" && local.verified === true && local.dataId,
   "it watches `local` for writes, verified by the adapter", local);
ok(w1.by === "agent", "and is attributed to the agent that set it", w1.by);

// A tab that joins now is replayed the set.
{
  const late = watcher();
  await late.open;
  for (let i = 0; i < 50 && !late.seen.some((m) => m.type === "dataBreakpoints"); i++) await sleep(50);
  const lm = late.seen.find((m) => m.type === "dataBreakpoints");
  ok(lm && JSON.stringify(lm.list) === JSON.stringify(w1.list), "a late-joining tab is sent the same watch list", lm);
  late.ws.close();
  const st = await state();
  ok(JSON.stringify(st.dataBreakpoints) === JSON.stringify(w1.list), "/api/state lists it too", st.dataBreakpoints);
}

const s1 = await cmd({ cmd: "continue" });
ok(s1.type === "stopped" && s1.reason === "data breakpoint", `continue stops on the watchpoint (${s1.reason})`, s1);
ok(s1.line === 17, `the stop is just past the write to local on line 16 (got ${s1.line})`, s1);

{
  const r = await cmd({ cmd: "clearDataBreakpoint", dataId: local.dataId }, "dataBreakpoints");
  ok(r.type === "dataBreakpoints" && r.list.length === 0, "clearDataBreakpoint empties the list", r);
  const again = await cmd({ cmd: "clearDataBreakpoint", dataId: local.dataId }, "dataBreakpoints");
  ok(again.ok === false && /no data breakpoint/.test(again.error), "clearing it twice is refused", again);
  const bad = await cmd({ cmd: "setDataBreakpoint", ref: s1.scopeRef, name: "local", accessType: "sometimes" }, "dataBreakpoints");
  ok(bad.ok === false && /accessType/.test(bad.error), "an unknown accessType is refused", bad);
}

// ── a global, by address, through `dapweb api watch` ──
const ev = await cmd({ cmd: "evaluate", id: 7, expr: "&g_total", frameId: s1.frames[0].id, context: "watch" }, "evalResult");
const addr = String(ev.value).split(" ").pop()!;
ok(/^0x[0-9a-f]+$/i.test(addr), `&g_total evaluates to an address (${addr})`, ev);
{
  const p = Bun.spawn([bin, "api", "watch", "--port", String(port), "--address", addr, "--size", "4"],
                      { cwd: root, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const r = JSON.parse(out || "{}");
  ok(p.exitCode === 0 && r.type === "dataBreakpoints" && r.list.length === 1 && r.list[0].label === addr,
     "`dapweb api watch --address` arms a 4-byte watch", { code: p.exitCode, out, err: await new Response(p.stderr).text() });
}
// Stopped at the start of line 17 on the first pass, so the next write is g_total = 1.
const s2 = await cmd({ cmd: "continue" });
ok(s2.type === "stopped" && s2.reason === "data breakpoint" && s2.line === 18,
   `the address watch stops just past the write to g_total on line 17 (line ${s2.line}, ${s2.reason})`, s2);
const g = await cmd({ cmd: "evaluate", id: 8, expr: "g_total", frameId: s2.frames[0].id, context: "watch" }, "evalResult");
ok(g.value === "1", `and g_total holds the new value (${g.value})`, g);
{
  // `watch <name>` means a local of the current stop.
  const p = Bun.spawn([bin, "api", "watch", "local", "--port", String(port), "--access", "read"],
                      { cwd: root, stdout: "pipe", stderr: "pipe" });
  const r = JSON.parse((await new Response(p.stdout).text()) || "{}");
  await p.exited;
  const w = r.list?.find((d: any) => d.label === "local");
  ok(w && w.accessType === "read" && r.list.length === 2, "`dapweb api watch local --access read` adds a read watch on the local", r);
  await cmd({ cmd: "clearDataBreakpoint", dataId: w.dataId }, "dataBreakpoints");
}

// ── the run ends: lldb-dap dataIds are addresses in that process, so they go ──
live.seen.length = 0;
await cmd({ cmd: "kill" }, "terminated");
for (let i = 0; i < 40 && !live.seen.some((m) => m.type === "dataBreakpoints"); i++) await sleep(50);
const gone = live.seen.find((m) => m.type === "dataBreakpoints");
ok(gone && gone.list.length === 0 && gone.dropped === 1, "ending the run drops the watch and says how many", gone);
ok((await state()).dataBreakpoints.length === 0, "/api/state agrees");
live.ws.close();

// ── an adapter that does not support data breakpoints ──
{
  const p = await freePort();
  const log = `/tmp/dapweb_watch_stub_${process.pid}_${p}.jsonl`;
  await Bun.write(log, "");
  const srv = Bun.spawn([bin, "web", "--port", String(p), "--quiet"], {
    cwd: root, stdout: "ignore", stderr: "ignore",
    env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: `/tmp/dapweb_watch_xdg_${process.pid}`, STUB_LOG: log },
  });
  const base = `http://localhost:${p}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/state`)).ok) break; } catch {}
    await sleep(100);
  }
  const st = await cmd({ cmd: "run", config: { type: "lldb", name: "watch stub", program: "/tmp/dapweb_watch",
                                               dapPath: `bun ${root}/tests/stub-adapter.ts` } }, "stopped", base);
  ok(st.type === "stopped", "stub adapter stopped", st);
  const r = await cmd({ cmd: "setDataBreakpoint", ref: 1, name: "x" }, "dataBreakpoints", base);
  ok(r.ok === false && /supportsDataBreakpoints/.test(r.error), "an adapter without data breakpoints is refused up front", r);
  const sent = (await Bun.file(log).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  ok(!sent.some((q) => /DataBreakpoint/.test(q.command)), "and is never sent a data breakpoint request", sent.map((q) => q.command));
  srv.kill();
}

console.log(`\n${pass} passed`);
process.exit(0);
