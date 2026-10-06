// The UI's session reducer: pure, so tested without a browser or a server.
// The stream below is the shape a real stop-at-main run sends (hello, caps, bp
// echo, stop at main, threads, output, step, stop on a user breakpoint, exit),
// trimmed to the fields the reducer reads.
// Usage: bun tests/session-reducer.ts

import { sessionReducer, initialSession, stopStatus, bpKey, SessionState } from "../src/web/ui/src/session";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}
const fold = (s: SessionState, msgs: any[]) => msgs.reduce(sessionReducer, s);

const SRC = "/repo/examples/nested/main.c";
const hello = {
  type: "hello", program: "/tmp/dapweb_nested", sourcePath: SRC, adapterCmd: "/usr/bin/lldb-dap",
  adapterId: "lldb", sessionId: "quick-fox-runs", config: { type: "lldb", program: "/tmp/dapweb_nested" },
  history: [{ program: "/tmp/dapweb_nested" }],
};
const caps = { type: "capabilities", raw: JSON.stringify({ body: { supportsReadMemoryRequest: true, supportsSetVariable: true } }) };
const frameMain = { id: 1, name: "main", line: 14, path: SRC, ipRef: "0x10000048c" };
const stopMain = {
  type: "stopped", line: 14, path: SRC, tid: 7, reason: "breakpoint", description: "breakpoint 1.1",
  atMain: true, scopeRef: 1001, registersRef: 1003,
  frames: [frameMain], locals: [{ name: "list", value: "0x0", ref: 0, type: "Node *" }],
};
const threads = { type: "threads", current: 7, threads: [{ id: 7, name: "main" }] };
const regions = { type: "regions", regions: [{ s: "0x100000000", e: "0x100004000", p: "r-x", n: "__TEXT" }] };
const stopBp = {
  ...stopMain, line: 23, reason: "breakpoint", description: "breakpoint 2.1", atMain: false,
  frames: [{ ...frameMain, line: 23, ipRef: "0x10000053c" }, { id: 2, name: "start", line: 0, path: "dyld`start", ipRef: "0x18a1" }],
};

let s = fold(initialSession, [
  hello, caps,
  { type: "breakpoint", path: SRC, line: 23, set: true },
  { type: "bpSync", path: SRC, line: 26, condition: "total > 1", enabled: false },
  { type: "source", path: SRC, content: "int main() {}\n" },
]);
ok(s.sessionId === "quick-fox-runs" && s.program === "/tmp/dapweb_nested" && s.adapterId === "lldb", "hello fills the session identity", s);
ok(s.config.program === "/tmp/dapweb_nested" && s.history.length === 1, "hello carries config and history");
ok(s.caps.supportsReadMemoryRequest === true, "capabilities parse the raw initialize response", s.caps);
ok(s.bps.size === 2 && s.bps.has(bpKey(SRC, 23)), "breakpoint echo and bpSync both land", [...s.bps.keys()]);
ok(s.bps.get(bpKey(SRC, 26))?.condition === "total > 1" && s.bps.get(bpKey(SRC, 26))?.enabled === false,
   "bpSync keeps condition and disabled", s.bps.get(bpKey(SRC, 26)));
ok(s.files.get(SRC) === "int main() {}\n", "source push is kept by path");
ok(s.phase === "idle" && s.stop === null, "idle until the first stop", s.phase);

s = fold(s, [stopMain, threads, regions, { type: "output", category: "stdout", text: "hi\n" }]);
ok(s.phase === "stopped" && s.stopLine === 14 && s.stopPath === SRC, "stop at main sets phase and location", s);
ok(s.frames.length === 1 && s.locals.length === 1 && s.scopeRef === 1001, "frames, locals and scope ref come from the stop");
ok(s.stop?.registersRef === 1003 && s.hasRegisters, "the register scope is known");
ok(s.threads.length === 1 && s.curTid === 7, "threads arrive");
ok(s.regions.length === 1, "regions arrive");
ok(stopStatus(s.stop!).short === "paused at main · main.c:14",
   "the stop-at-main stop says paused at main, not paused on breakpoint", stopStatus(s.stop!));
const seq1 = s.stopSeq;
const sameOutput = fold(s, [{ type: "output", category: "stdout", text: "more\n" }]);
ok(sameOutput === s, "output is not session state");

s = fold(s, [{ type: "local/resumed" }]);
ok(s.phase === "running" && s.stopLine === 0, "continue: running, no current line");
ok(s.stop !== null && s.locals.length === 1, "while running the last stop stays on screen (greyed), as before");

s = fold(s, [stopBp, threads]);
ok(s.stopSeq === seq1 + 1, "each stop bumps stopSeq");
ok(stopStatus(s.stop!).short === "paused on breakpoint · main.c:23", "a user breakpoint says paused on breakpoint", stopStatus(s.stop!));

s = fold(s, [{ type: "local/selectFrame", i: 1 }]);
ok(s.selFrame === 1 && s.stopPath === "dyld`start", "selecting a frame moves the view, not the stop", s);
ok(s.stop?.line === 23, "the stop itself is unchanged by selection");

s = fold(s, [{ type: "terminated", exitCode: 0 }]);
ok(s.phase === "done" && s.exitCode === 0, "terminated: done, with its exit code");
ok(s.stop === null && s.frames.length === 0 && s.locals.length === 0 && s.threads.length === 0,
   "terminated drops the stop, frames, locals and threads", s);
ok((s.stop?.registersRef ?? 0) === 0 && s.regions.length === 0 && s.stopLine === 0 && s.stopPath === "" && s.scopeRef === 0,
   "terminated drops the registers ref and memory regions, so Registers no longer shows the last stop", s);
ok(s.hasRegisters, "the Registers tab stays offered after exit, now empty");
ok(s.bps.size === 2 && s.files.size === 1 && s.caps.supportsSetVariable, "breakpoints, files and caps survive the run");

// A same-session reconnect replays the snapshot; a new session wipes the old one.
s = fold(s, [stopMain]);
const rejoin = fold(s, [hello]);
ok(rejoin.stop !== null && rejoin.phase === "stopped", "same-session hello keeps the stop for the replay to refresh");
ok(rejoin.bps.size === 0 && rejoin.files.size === 0, "hello empties bps and files; bpSync/source re-send them");
const fresh = fold(s, [{ ...hello, sessionId: "other-session" }]);
ok(fresh.stop === null && fresh.phase === "idle" && !fresh.hasRegisters, "a new session drops the old stop", fresh);
const joinLive = fold(initialSession, [{ ...hello, phase: "running" }]);
ok(joinLive.phase === "running", "joining a live session starts running");

// ── data breakpoints: the server sends the whole list each time ──
{
  const w = { dataId: "100008000/4", label: "g_total", description: "4 bytes at 100008000 g_total",
              accessType: "write", condition: "", hitCondition: "", canPersist: false, verified: true, message: "" };
  let d = fold(initialSession, [hello, { type: "dataBreakpoints", list: [w] }]);
  ok(d.dataBps.length === 1 && d.dataBps[0].label === "g_total" && d.dataBpsDropped === 0, "a watch list replaces the set", d.dataBps);
  const st = sessionReducer(d, { ...stopBp, line: 18, reason: "data breakpoint", description: "data breakpoint 1",
                                 frames: [{ ...stopBp.frames[0], line: 18 }] });
  ok(stopStatus(st.stop!).short === "paused on watchpoint · main.c:18", "a data breakpoint stop says paused on watchpoint", stopStatus(st.stop!));
  d = fold(d, [{ type: "dataBreakpoints", list: [], dropped: 1 }]);
  ok(d.dataBps.length === 0 && d.dataBpsDropped === 1, "the end of a run empties it and remembers how many went", d);
  d = fold(d, [{ type: "dataBreakpoints", list: [w] }]);
  ok(d.dataBpsDropped === 0, "a later change clears the note");
}

console.log(`\n${pass} passed`);
