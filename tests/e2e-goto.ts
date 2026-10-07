// E2E for run to cursor and set next statement, driven through the HTTP API the
// way an agent would (`dapweb api request --await stopped ...`).
// lldb-dap (as of LLVM 22) answers gotoTargets with "unknown request" and does
// not advertise it, so the goto chain is also driven against tests/stub-adapter.ts
// with STUB_GOTO=1, on servers this suite spawns itself.
// Needs dapweb web on [port] targeting /tmp/dapweb_nested. Usage: bun tests/e2e-goto.ts [port]

import { freePort } from "./freeport";
import { own } from "./own";
const port = process.argv[2] ?? "8092";
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
const bpLines = (s: any) => JSON.stringify(s.breakpoints.map((b: any) => [b.path, b.line, b.enabled]));

// A watching browser tab: a temporary breakpoint must never show up in its list.
const seen: any[] = [];
const ws = new WebSocket(`ws://localhost:${port}/ws`);
ws.onmessage = (ev) => seen.push(JSON.parse(String(ev.data)));
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const src = (await state()).sourcePath;
ok(src.endsWith("examples/nested/main.c"), "server targets examples/nested", src);

// Refused, not silently ignored, while nothing is stopped.
{
  const r = await cmd({ cmd: "runToCursor", line: 22 });
  ok(r.ok === false && /stopped/.test(r.error), "runToCursor with no stop is refused with a reason", r);
}

// The user's own breakpoint, after the loop: run to cursor must stop short of it.
await cmd({ cmd: "setBreakpoint", path: src, line: 26 }, "breakpoint");
const s0 = await cmd({ cmd: "run", stopAtMain: true });
ok(s0.type === "stopped" && s0.line === 14, "stopped at main", s0);
const before = bpLines(await state());

// ── run to cursor ──
seen.length = 0;
const s1 = await cmd({ cmd: "runToCursor", path: src, line: 22, tid: s0.tid });
ok(s1.type === "stopped" && s1.line === 22, `run to cursor stopped on line 22 (got ${s1.line})`, s1);
ok(bpLines(await state()) === before, "the breakpoint list is unchanged", (await state()).breakpoints);
ok(!seen.some((m) => m.type === "breakpoint" || m.type === "bpSync"),
   "no peer was sent a breakpoint for the temporary line", seen.filter((m) => /breakpoint|bpSync/.test(m.type)));

// ── set next statement ──
// A tab joining now is replayed the adapter's capabilities.
const caps = await new Promise<any>((res) => {
  const w2 = new WebSocket(`ws://localhost:${port}/ws`);
  w2.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "capabilities") { w2.close(); res(JSON.parse(m.raw).body ?? {}); }
  };
});
if (!caps.supportsGotoTargetsRequest) {
  console.log("  note: this lldb-dap does not advertise supportsGotoTargetsRequest; skipping the goto assertions");
  const r = await cmd({ cmd: "setNextStatement", path: src, line: 24 });
  ok(r.ok === false && /goto/.test(r.error), "setNextStatement is refused with a reason", r);
} else {
  // Line 24 (`total += p`) skips the printf on 23.
  const s2 = await cmd({ cmd: "setNextStatement", path: src, line: 24, tid: s1.tid });
  ok(s2.type === "stopped" && s2.line === 24, `set next statement moved the stop to line 24 (got ${s2.line})`, s2);
  ok(s2.reason === "goto", "the stop says it came from a goto", s2.reason);
  const bad = await cmd({ cmd: "setNextStatement", path: src, line: 9999 });
  ok(bad.ok === false && bad.error, "a line with no code is refused with the adapter's reason", bad);
}

// ── the temporary breakpoint is gone ──
// Line 22 runs again on the loop's second pass. Stopping there now would mean
// the run-to-cursor line outlived its stop.
const s3 = await cmd({ cmd: "continue", tid: s1.tid });
ok(s3.type === "stopped" && s3.line === 26, `continue runs past line 22 to the user's breakpoint (got ${s3.line})`, s3);
ok(bpLines(await state()) === before, "the breakpoint list is still unchanged");

await cmd({ cmd: "kill" }, "terminated");
ws.close();

// ── set next statement against an adapter that implements goto ──
async function stubServer(goto: boolean) {
  const p = await freePort();
  const log = `/tmp/dapweb_goto_stub_${process.pid}_${p}.jsonl`;
  await Bun.write(log, "");
  const srv = own(Bun.spawn([process.argv[3] ?? "./dapweb", "web", "--port", String(p), "--quiet"], {
    cwd: root, stdout: "ignore", stderr: "ignore",
    env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: `/tmp/dapweb_goto_xdg_${process.pid}`,
           STUB_LOG: log, ...(goto ? { STUB_GOTO: "1" } : {}) },
  }));
  const base = `http://localhost:${p}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/state`)).ok) break; } catch {}
    await sleep(100);
  }
  const st = await cmd({ cmd: "run", config: { type: "lldb", name: "goto stub", program: "/tmp/dapweb_nested",
                                               dapPath: `bun ${root}/tests/stub-adapter.ts` } }, "stopped", base);
  const sent = async () => (await Bun.file(log).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { srv, base, st, sent };
}
{
  const { srv, base, st, sent } = await stubServer(true);
  ok(st.type === "stopped", "stub adapter stopped", st);
  const s = await cmd({ cmd: "setNextStatement", path: "/tmp/stub_src.c", line: 7 }, "stopped", base);
  ok(s.type === "stopped" && s.line === 7 && s.reason === "goto", `goto stub: the stop moved to line 7 (got ${s.line})`, s);
  const reqs = await sent();
  const gt = reqs.find((r) => r.command === "gotoTargets");
  ok(gt?.arguments?.line === 7 && gt?.arguments?.source?.path === "/tmp/stub_src.c",
     "gotoTargets named the file and line", gt);
  const g = reqs.find((r) => r.command === "goto");
  ok(g?.arguments?.targetId === 70 && g?.arguments?.threadId === st.tid,
     "goto used the adapter's target id on the stopped thread", g);
  const bad = await cmd({ cmd: "setNextStatement", path: "/tmp/stub_src.c", line: 9999 }, "stopped", base);
  ok(bad.ok === false && /no code/.test(bad.error), "a line with no goto target is refused", bad);
  srv.kill();
}
{
  const { srv, base, sent } = await stubServer(false);
  const r = await cmd({ cmd: "setNextStatement", path: "/tmp/stub_src.c", line: 7 }, "stopped", base);
  ok(r.ok === false && /supportsGotoTargetsRequest/.test(r.error), "an adapter without goto is refused up front", r);
  ok(!(await sent()).some((q) => q.command === "gotoTargets"), "and is never sent gotoTargets");
  srv.kill();
}
console.log(`\n${pass} passed`);
process.exit(0);
