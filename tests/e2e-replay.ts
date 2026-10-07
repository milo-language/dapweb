// E2E for reverse debugging: a Milo program recorded with MILO_RECORD, debugged
// in a replay session (MILO_REPLAY), stepped forward and back.
//
// What is checked, against the real lldb-dap and a real recording:
//   - the trace replays with its data file deleted (the recording answers it);
//   - step back lands on exactly the earlier stop: same line, same locals;
//   - reverse continue lands on the last breakpoint hit before the current stop,
//     including one passed while stepping and one before the failure;
//   - seek to a trace record lands in user code, at the call it answered;
//   - the refusals: nothing has run yet, the first stop has nothing before it.
//
// Self-spawns its server. Needs the milo compiler (MILO, as scripts/build.sh).
// Usage: bun tests/e2e-replay.ts [binary]

import { freePort } from "./freeport";
import { mkdirSync, copyFileSync, rmSync, readFileSync, existsSync } from "fs";

const bin = process.argv[2] ?? "./dapweb";
const root = (import.meta.dir + "/..").replace("/tests/..", "");
const tmp = `/tmp/dapweb_replay_test_${process.pid}`;
const SRC = `${root}/examples/replay-demo/orders.milo`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let srv: any = null;
function cleanup() {
  try { srv?.kill(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else {
    console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 800) : "");
    cleanup();
    process.exit(1);
  }
}
// The line numbers come from the source, so editing the demo cannot silently
// point the breakpoints somewhere else.
const srcLines = readFileSync(SRC, "utf-8").split("\n");
const lineOf = (needle: string) => srcLines.findIndex((l) => l.includes(needle)) + 1;
const ADD = lineOf("total = total + cents");
const READ = lineOf("readLines(path)");

type Stop = { line: number; path: string; reason: string; vars: Record<string, string>; frames: any[] };
const stopOf = (m: any): Stop => ({
  line: m.line, path: m.path, reason: m.reason, frames: m.frames || [],
  vars: Object.fromEntries((m.locals || []).map((v: any) => [v.name, v.value])),
});
const same = (a: Stop, b: Stop) => a.line === b.line && a.vars.total === b.vars.total && a.vars.count === b.vars.count && a.vars.cents === b.vars.cents;
const brief = (s: Stop) => ({ line: s.line, total: s.vars.total, count: s.vars.count, cents: s.vars.cents, reason: s.reason });

try {
  // ── record: build with debug info, run once with MILO_RECORD in a scratch cwd ──
  mkdirSync(`${tmp}/run/examples/replay-demo`, { recursive: true });
  const rec = Bun.spawnSync(["sh", "examples/replay-demo/record.sh"], { cwd: root, env: { ...process.env, OUT: `${tmp}/out` } });
  ok(rec.exitCode === 0 && existsSync(`${tmp}/out/orders`), "record.sh builds the demo with debug info", rec.stderr.toString().slice(-400));
  copyFileSync(`${root}/examples/replay-demo/orders.txt`, `${tmp}/run/examples/replay-demo/orders.txt`);
  const trace = `${tmp}/run/orders.mrr`;
  const live = Bun.spawnSync([`${tmp}/out/orders`], { cwd: `${tmp}/run`, env: { ...process.env, MILO_RECORD: trace } });
  ok(live.stdout.toString().includes("order 1008") && live.stderr.toString().includes("assertion failed"),
     "the recorded run processes every order and then fails its ledger check", live.stdout.toString());
  // From here on the program's input exists only in the trace.
  rmSync(`${tmp}/run/examples`, { recursive: true });
  const rep = Bun.spawnSync([`${tmp}/out/orders`], { cwd: `${tmp}/run`, env: { ...process.env, MILO_REPLAY: trace } });
  ok(rep.stdout.toString() === live.stdout.toString(), "a replay with the data file deleted prints the recording byte for byte");

  // ── a replay session ──
  const port = await freePort();
  srv = Bun.spawn([bin, "web", "--port", String(port), "--quiet", "--no-browser",
                   "--program", `${tmp}/out/orders`, "--source", "examples/replay-demo/orders.milo", "--replay", trace], {
    cwd: root, env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: `${tmp}/xdg` }, stdout: "ignore", stderr: "inherit",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/state`)).ok) break; } catch {}
    await sleep(100);
  }
  const base = `http://localhost:${port}`;
  const cmd = (body: any, awaitType = "stopped") =>
    fetch(`${base}/api/cmd?agent=e2e${awaitType ? `&await=${awaitType}&timeout=30000` : ""}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  const state = () => fetch(`${base}/api/state`).then((r) => r.json());

  const st0 = await state();
  ok(st0.replay?.trace === trace, "the session says it is a replay, and of which trace", st0.replay);

  const nothing = await cmd({ cmd: "stepBack" });
  ok(nothing.ok === false && /Run first/.test(nothing.error), "step back before anything ran is refused", nothing);

  await cmd({ cmd: "setBreakpoint", path: SRC, line: ADD }, "breakpoint");
  const seen: Stop[] = [];
  const go = async (body: any) => {
    const m = await cmd(body);
    ok(m.type === "stopped", `${body.cmd} stops`, m);
    const s = stopOf(m);
    seen.push(s);
    return s;
  };
  // Stops 1-7: three passes of the breakpoint with steps in between, so the
  // timeline mixes breakpoint stops and steps.
  const s1 = await go({ cmd: "run", stopAtMain: false });
  ok(s1.line === ADD && s1.vars.total === "0" && s1.vars.cents === "1250", "the run stops at the first order's add", brief(s1));
  await go({ cmd: "stepOver" });
  await go({ cmd: "stepOver" });
  await go({ cmd: "continue" });
  await go({ cmd: "stepOver" });
  await go({ cmd: "continue" });
  const s7 = await go({ cmd: "stepOver" });
  ok(s7.vars.total === "4074" && s7.line === ADD + 1, "seven stops in, the third order has been added", brief(s7));

  // ── step back, three times: each lands on the stop before, same line, same locals ──
  const times: number[] = [];
  let back: Stop;
  for (const want of [seen[5], seen[4], seen[3]]) {
    const t0 = Date.now();
    back = stopOf(await cmd({ cmd: "stepBack" }));
    times.push(Date.now() - t0);
    ok(same(back, want), `step back lands on stop ${seen.indexOf(want) + 1}: line ${want.line}, total ${want.vars.total}`, { got: brief(back), want: brief(want) });
  }
  const st4 = await state();
  void back!;
  ok(st4.replay?.at === 4 && st4.replay?.prev === 3, "the replay position says stop 4, with stop 3 before it", st4.replay);
  console.log(`  (step back took ${times.join(", ")} ms)`);

  // Forward again from the earlier stop is the same program: stop 5 again.
  const again = stopOf(await cmd({ cmd: "stepOver" }));
  ok(same(again, seen[4]), "stepping forward again reaches the same stop 5", { got: brief(again), want: brief(seen[4]) });
  // The agent's CLI verb is the same command.
  const cli = Bun.spawnSync([bin, "api", "--port", String(port), "step-back"], { cwd: root });
  const cliStop = stopOf(JSON.parse(cli.stdout.toString()));
  ok(cli.exitCode === 0 && same(cliStop, seen[3]), "`dapweb api step-back` goes back too", { code: cli.exitCode, got: brief(cliStop) });
  await cmd({ cmd: "stepOver" });

  // ── reverse continue ──
  // From stop 5 (a step past the add), the last breakpoint hit is stop 4.
  let rc = stopOf(await cmd({ cmd: "reverseContinue" }));
  ok(same(rc, seen[3]), "reverse continue lands on the last breakpoint hit (stop 4)", { got: brief(rc), want: brief(seen[3]) });
  // A breakpoint set now, on a line the run only stepped over: reverse continue
  // finds the pass anyway (counted with logpoints) and lands on it.
  const PRINT = lineOf("print($\"order {order.id}");
  await cmd({ cmd: "setBreakpoint", path: SRC, line: PRINT }, "breakpoint");
  rc = stopOf(await cmd({ cmd: "reverseContinue" }));
  ok(rc.line === PRINT && rc.vars.count === "1" && rc.vars.total === "1250",
     "reverse continue lands on a breakpoint the run passed but never stopped at", brief(rc));
  await cmd({ cmd: "clearBreakpoint", path: SRC, line: PRINT }, "breakpoint");

  // From the failure: run to the abort with the breakpoint off, then go back to
  // the last add before it.
  await cmd({ cmd: "clearBreakpoint", path: SRC, line: ADD }, "breakpoint");
  const fail = stopOf(await cmd({ cmd: "run", stopAtMain: false, force: true }));
  ok(fail.reason === "exception" || fail.reason === "signal", "a fresh run goes straight to the failed assertion", brief(fail));
  await cmd({ cmd: "setBreakpoint", path: SRC, line: ADD }, "breakpoint");
  rc = stopOf(await cmd({ cmd: "reverseContinue" }));
  ok(rc.line === ADD && rc.vars.cents === "1540" && rc.vars.total === "7664",
     "reverse continue from the failure lands on the last order's add", brief(rc));
  rc = stopOf(await cmd({ cmd: "reverseContinue" }));
  ok(rc.line === ADD && rc.vars.cents === "475" && rc.vars.total === "7189",
     "and again, on the one before it", brief(rc));
  // Each landing so far was on the launch itself; a third used to re-count
  // without the landing's breakpoint and land on order 1007 forever.
  rc = stopOf(await cmd({ cmd: "reverseContinue" }));
  ok(rc.line === ADD && rc.vars.cents === "2100" && rc.vars.count === "5",
     "a third reverse continue keeps going back (order 1006)", brief(rc));
  await cmd({ cmd: "reverseContinue" });
  rc = stopOf(await cmd({ cmd: "reverseContinue" }));
  ok(rc.line === ADD && rc.vars.cents === "705" && rc.vars.count === "3",
     "five back from the failure is order 1004, whose 7.5 was read as 705 cents", brief(rc));

  // ── seek to a trace record ──
  const tr = await (await fetch(`${base}/api/trace`)).json();
  const readRec = tr.records.find((r: any) => r.kind === "fs.read");
  ok(tr.ok && tr.total > 10 && readRec, "the timeline lists the trace's records", { total: tr.total });
  const sk = stopOf(await cmd({ cmd: "seek", record: readRec.seq }));
  ok(sk.path === SRC && sk.line === READ && sk.frames[0]?.name === "main",
     "seek to the file read lands in user code, at the call that read it", { ...brief(sk), path: sk.path, f0: sk.frames[0]?.name });
  const st5 = await state();
  ok(st5.replay?.seekedTo === readRec.seq, "the replay position remembers the record", st5.replay);

  // ── refusals ──
  const firstStop = await cmd({ cmd: "stepBack" });
  ok(firstStop.ok === false && /first stop/.test(firstStop.error), "the first stop of a run has nothing before it", firstStop);

  console.log(`\ne2e-replay: ${pass} checks passed`);
  cleanup();
  process.exit(0);
} catch (e) {
  console.error("  FAIL e2e-replay:", e);
  cleanup();
  process.exit(1);
}
