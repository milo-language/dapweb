// E2E for the agent-facing surface: breakpoint identity and persistence, the
// activity announcements a browser needs in order to explain a stop it did not
// cause, and the two inspection endpoints the target bar reads.
//
// Self-spawns servers on a throwaway $XDG_STATE_HOME, so the developer's real
// breakpoint store and session registry are never touched.
// Usage: bun tests/e2e-agent.ts [binary]   (needs /tmp/dapweb_nested built)

const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_agent_test_${process.pid}`;
const prog = "/tmp/dapweb_nested";
// Deliberately spelled with a ".." segment: the server must normalise it to the
// same key as the plain relative spelling, or one line becomes two breakpoints.
const SRC_DOTTED = `${root}/examples/nested/main.c`;
const SRC = SRC_DOTTED.replace("/tests/..", "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else {
    console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : "");
    process.exit(1);
  }
}

let port = 8750 + (process.pid % 120);
const servers: any[] = [];
async function serve(extra: string[] = []) {
  port += 1;
  const p = port;
  const srv = Bun.spawn([bin, "web", "--program", prog, "--port", String(p), "--quiet", ...extra], {
    cwd: root, env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg },
    stdout: "pipe", stderr: "ignore",
  });
  servers.push(srv);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${p}/api/state`)).ok) break; } catch {}
    await sleep(100);
  }
  return { srv, port: p };
}
const state = async (p: number) => (await fetch(`http://localhost:${p}/api/state`)).json();
const cmd = (p: number, body: any, q = "") =>
  fetch(`http://localhost:${p}/api/cmd${q}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

try {
  // ── breakpoint identity: one line is one breakpoint, whatever the spelling ──
  {
    const { port: p } = await serve();
    // The UI keys on --source/hello before the first stop and on the frame's
    // DWARF path after it. Both must land on the same breakpoint.
    await cmd(p, { cmd: "setBreakpoint", path: "examples/nested/main.c", line: 23 });
    await cmd(p, { cmd: "setBreakpoint", path: SRC_DOTTED, line: 23 });
    const s = await state(p);
    const at23 = s.breakpoints.filter((b: any) => b.line === 23);
    ok(at23.length === 1, "two spellings of one file collapse to one breakpoint", s.breakpoints);
    ok(at23[0].path === SRC, "the surviving path is absolute (what lldb matches on)", at23[0]);

    // A clear sent with the *other* spelling must still remove it.
    await cmd(p, { cmd: "clearBreakpoint", path: "examples/nested/main.c", line: 23 });
    ok((await state(p)).breakpoints.filter((b: any) => b.line === 23).length === 0,
       "clearing via the relative spelling removes the absolute breakpoint");
  }

  // ── persistence across a server restart ──
  {
    const a = await serve();
    await cmd(a.port, { cmd: "setBreakpoint", path: SRC, line: 18 });
    await cmd(a.port, { cmd: "setBreakpoint", path: SRC, line: 23, condition: "i == 1" });
    a.srv.kill(); await sleep(400);

    const b = await serve();
    const s = await state(b.port);
    const lines = s.breakpoints.map((x: any) => x.line).sort((x: number, y: number) => x - y);
    ok(JSON.stringify(lines) === "[18,23]", "breakpoints survive a server restart", s.breakpoints);
    ok(s.breakpoints.find((x: any) => x.line === 23)?.condition === "i == 1",
       "conditions survive too", s.breakpoints);

    // A different program must not inherit them: the store is keyed by program.
    const other = Bun.spawn([bin, "web", "--program", "/tmp/dapweb_inter", "--port", String(port + 40),
                             "--quiet"], {
      cwd: root, env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg },
      stdout: "ignore", stderr: "ignore",
    });
    servers.push(other);
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://localhost:${port + 40}/api/state`)).ok) break; } catch {}
      await sleep(100);
    }
    ok((await state(port + 40)).breakpoints.length === 0,
       "a different program starts with its own (empty) breakpoint set");
  }

  // ── activity: a browser peer is told what another peer is about to do ──
  {
    const { port: p } = await serve();
    const ws = new WebSocket(`ws://localhost:${p}/ws`);
    const acts: any[] = [];
    const bpMsgs: any[] = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "activity") acts.push(m);
      if (m.type === "breakpoint") bpMsgs.push(m);
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    await sleep(300);

    await cmd(p, { cmd: "setBreakpoint", path: SRC, line: 23 }, "?agent=testbot&pid=4242");
    await sleep(400);
    ok(acts.length === 1, "one activity announcement per api command", acts);
    ok(acts[0].who === "testbot (pid 4242)", "the announcement names the agent and its pid", acts[0]);
    ok(acts[0].cmd === "setBreakpoint", "it carries the raw command", acts[0]);
    ok(/attempting to set a breakpoint at line 23/.test(acts[0].text),
       "and a human-readable sentence naming the line", acts[0]);

    // An already-open tab must be able to render the agent's breakpoint. The ack
    // is keyed by path+line, so without a path it cannot be applied and the
    // breakpoint stays invisible until the tab is reloaded.
    ok(bpMsgs.length === 1, "the breakpoint change is broadcast to the browser peer", bpMsgs);
    ok(bpMsgs[0].path === SRC && bpMsgs[0].line === 23 && bpMsgs[0].set === true,
       "the ack carries the canonical path, the line and the set flag", bpMsgs[0]);

    // A browser's own commands are self-evident; announcing them would be noise.
    ws.send(JSON.stringify({ cmd: "setBreakpoint", path: SRC, line: 18 }));
    await sleep(400);
    ok(acts.length === 1, "a browser peer's own commands are not announced", acts);
    ws.close();
  }

  // ── a re-hello carries the breakpoint set it invalidates ──
  {
    const { port: p } = await serve();
    const ws = new WebSocket(`ws://localhost:${p}/ws`);
    const seen: any[] = [];
    ws.onmessage = (e) => seen.push(JSON.parse(String(e.data)));
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    await sleep(300);
    ws.send(JSON.stringify({ cmd: "setBreakpoint", path: SRC, line: 23 }));
    await sleep(400);
    seen.length = 0;

    // Run carries its config inline, so it re-applies the target and re-hellos.
    // A hello is a full resync — the browser empties its breakpoint map on one —
    // so the set has to arrive behind it, or the panel reads "none" and the
    // gutter dot vanishes while the server still holds the breakpoint.
    ws.send(JSON.stringify({ cmd: "run", stopAtMain: true,
                             config: { type: "lldb", program: prog, source: SRC } }));
    for (let i = 0; i < 60 && !seen.some((m) => m.type === "hello"); i++) await sleep(100);
    await sleep(500);
    const hi = seen.findIndex((m) => m.type === "hello");
    ok(hi >= 0, "run with an inline config re-hellos", seen.map((m) => m.type));
    // The store is keyed by program and the earlier blocks used this one, so the
    // replay is the whole persisted set, not just the line set above.
    const syncs = seen.slice(hi).filter((m) => m.type === "bpSync");
    ok(syncs.some((m) => m.line === 23 && m.path === SRC),
       "the breakpoint set is replayed behind the hello that invalidates it", syncs);

    // Same again through the force path: a live session is killed and relaunched
    // from D's teardown, which applies the config there. applyConfig empties the
    // set, so that path needs its own reload — otherwise a second Run drops the
    // breakpoints server-side, not just in the browser.
    seen.length = 0;
    ws.send(JSON.stringify({ cmd: "run", stopAtMain: true, force: true,
                             config: { type: "lldb", program: prog, source: SRC } }));
    for (let i = 0; i < 80 && !seen.some((m) => m.type === "hello"); i++) await sleep(100);
    await sleep(500);
    const fi = seen.findIndex((m) => m.type === "hello");
    const fsyncs = seen.slice(fi).filter((m) => m.type === "bpSync");
    ok(fi >= 0 && fsyncs.some((m) => m.line === 23), "a forced relaunch replays them too", fsyncs);
    ok((await state(p)).breakpoints.some((b: any) => b.line === 23),
       "and the server still holds them after the relaunch", (await state(p)).breakpoints);
    ws.send(JSON.stringify({ cmd: "kill" }));
    await sleep(400);
    ws.close();
  }

  // ── an await returns the refusal instead of sitting out its timeout ──
  {
    const { port: p } = await serve();
    const t0 = Date.now();
    // No program can be launched twice; the second run is refused with a
    // configError, which never becomes the awaited "stopped".
    await cmd(p, { cmd: "run" }, "?await=stopped&timeout=20000");
    const r = await cmd(p, { cmd: "run" }, "?await=stopped&timeout=20000");
    const dt = Date.now() - t0;
    ok(r.ok === false && /already active/.test(r.error || ""),
       "a rejected command answers with its refusal", r);
    ok(dt < 18000, `and does not burn the full timeout (${dt}ms)`, dt);
    await cmd(p, { cmd: "kill" });
  }

  // ── inspection endpoints the target bar reads ──
  {
    const { port: p } = await serve();
    const b = await (await fetch(`http://localhost:${p}/api/binfo`)).json();
    ok(b.exists === true && b.path === prog, "binfo reports the configured target", b);
    ok(b.format === "Mach-O" || b.format === "ELF", `binfo identifies the format (${b.format})`, b);
    ok(b.hasDebugInfo === true, "a -g build is reported as carrying debug info", b);
    ok(b.stripped === false, "and as not stripped", b);

    const procs = await (await fetch(`http://localhost:${p}/api/processes`)).json();
    ok(Array.isArray(procs.processes) && procs.processes.length > 1,
       `processes lists the machine's processes (${procs.processes?.length})`);
    const self = procs.processes.find((x: any) => x.pid === procs.processes[0].pid);
    ok(typeof self.pid === "number" && typeof self.name === "string" && typeof self.cmd === "string",
       "each row carries pid, name and cmd", self);
    // ps truncates its comm column to 16 chars; the name must come from argv[0].
    ok(procs.processes.every((x: any) => !x.name.includes("/")),
       "name is a basename, not a path");
  }

  console.log(`\ne2e-agent: ${pass}/${pass} passed`);
} finally {
  for (const s of servers) { try { s.kill(); } catch {} }
  await Bun.spawn(["rm", "-rf", xdg]).exited;
}
