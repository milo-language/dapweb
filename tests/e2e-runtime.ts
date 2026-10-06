// E2E for attaching to interpreted processes with the right debugger: a real
// node and a real python3 process show up in /api/processes with their runtime,
// and attaching to each through the API (setConfig + run, then pause) stops in
// a JS / Python frame, not in the interpreter's C code.
//
// Each attach needs its adapter: js-debug for node, debugpy for python. One that
// is not installed here is skipped with a note (the detection checks still run).
// DAPWEB_TEST_DEBUGPY_PYTHON=/path/to/venv/python supplies debugpy without
// installing it into the system python3; DAPWEB_TEST_DLV=/path/to/dlv adds a Go
// attach the same way.
//
// Usage: bun tests/e2e-runtime.ts [binary]

import { freePort } from "./freeport";
const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_runtime_test_${process.pid}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ""); cleanup(); process.exit(1); }
}

const kids: { kill: () => void }[] = [];
function cleanup() { for (const k of kids) { try { k.kill(); } catch {} } }

const port = await freePort();
const srv = Bun.spawn([bin, "web", "--port", String(port), "--quiet"], {
  cwd: root, stdout: "pipe", stderr: "pipe",
  env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg },
});
kids.push(srv);
const base = `http://localhost:${port}`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${base}/api/state`)).ok) break; } catch {}
  await sleep(100);
}
const get = async (p: string) => (await fetch(base + p)).json();
const cmd = async (body: any, await_ = "", timeout = 20000) =>
  (await fetch(`${base}/api/cmd?await=${await_}&timeout=${timeout}`, { method: "POST", body: JSON.stringify(body) })).json();

const adapters: any[] = (await get("/api/adapters")).adapters;
ok(adapters.map((a) => a.kind).join(",") === "lldb,python,node,go,java", "/api/adapters lists the registry", adapters);
ok(adapters.every((a) => typeof a.installed === "boolean" && a.installHint && a.label), "every entry has installed, label and hint", adapters);
const installed = (k: string) => !!adapters.find((a) => a.kind === k)?.installed;

const node = Bun.spawn(["node", "-e", "let n = 0; setInterval(function tick() { n++; }, 200)"], { stdout: "ignore", stderr: "ignore" });
const py = Bun.spawn(["python3", "-c", "import time\nwhile True:\n    time.sleep(0.2)"], { stdout: "ignore", stderr: "ignore" });
kids.push(node, py);
await sleep(400);

const procs: any[] = (await get("/api/processes")).processes;
const row = (pid: number) => procs.find((p) => p.pid === pid);
ok(row(node.pid)?.runtime === "node" && row(node.pid)?.type === "node", "a node process is listed as runtime node", row(node.pid));
ok(row(py.pid)?.runtime === "python" && row(py.pid)?.type === "python", "a python3 process is listed as runtime python", row(py.pid));
ok(procs.some((p) => p.runtime === "native"), "everything else is native", procs.length);

// Attach to `pid` with `config`, pause, and return the stop.
async function attachAndPause(config: any): Promise<any> {
  const set = await cmd({ cmd: "setConfig", ...config });
  ok(set.ok !== false, `setConfig accepted for ${config.type}`, set);
  const run = await cmd({ cmd: "run" }, "capabilities", 30000);
  if (run.ok === false) return run;
  // An attach is live once the adapter answers; give it a beat to finish the
  // handshake (js-debug hands the target to a child session first).
  let stop: any = null;
  for (let i = 0; i < 10 && !(stop && stop.type === "stopped"); i++) {
    stop = await cmd({ cmd: "pause" }, "stopped", 3000);
  }
  return stop;
}

async function detach() {
  await cmd({ cmd: "kill" }, "terminated", 10000).catch(() => null);
  await sleep(300);
}

const frameText = (s: any) => JSON.stringify(s?.frames || []);

if (installed("node")) {
  const s = await attachAndPause({ type: "node", request: "attach", processId: String(node.pid) });
  ok(s?.type === "stopped", "attaching js-debug to the node process and pausing stops it", s);
  ok(/tick|\[eval\]|<anonymous>/.test(frameText(s)), "the stop is in a JS frame", s?.frames);
  await detach();
  ok(node.exitCode === null, "detaching leaves the node process running", node.exitCode);
} else {
  console.log("  note: js-debug not installed, node attach skipped");
}

const debugpyPython = process.env.DAPWEB_TEST_DEBUGPY_PYTHON
  || (Bun.spawnSync(["python3", "-c", "import debugpy"]).exitCode === 0 ? "python3" : "");
if (debugpyPython) {
  const s = await attachAndPause({ type: "python", request: "attach", processId: py.pid,
                                   dapPath: `${debugpyPython} -m debugpy.adapter` });
  ok(s?.type === "stopped", "attaching debugpy to the python process and pausing stops it", s);
  ok(/<module>|<string>/.test(frameText(s)), "the stop is in a Python frame", s?.frames);
  await detach();
} else {
  console.log("  note: debugpy not importable by python3 (set DAPWEB_TEST_DEBUGPY_PYTHON), python attach skipped");
}

const dlv = process.env.DAPWEB_TEST_DLV || (Bun.which("dlv") ?? "");
if (dlv) {
  const dir = `/tmp/dapweb_runtime_go_${process.pid}`;
  await Bun.write(`${dir}/go.mod`, "module spin\n\ngo 1.21\n");
  await Bun.write(`${dir}/main.go`, "package main\n\nimport \"time\"\n\nfunc spin(i int) int { return i + 1 }\n\nfunc main() {\n\tfor i := 0; ; i = spin(i) {\n\t\ttime.Sleep(200 * time.Millisecond)\n\t}\n}\n");
  const b = Bun.spawnSync(["go", "build", "-gcflags=all=-N -l", "-o", "spin", "."], { cwd: dir });
  ok(b.exitCode === 0, "go test program builds", b.stderr.toString());
  const g = Bun.spawn([`${dir}/spin`], { stdout: "ignore", stderr: "ignore" });
  kids.push(g);
  await sleep(300);
  const gp = ((await get("/api/processes")).processes as any[]).find((p) => p.pid === g.pid);
  ok(gp?.runtime === "go", "a Go binary is listed as runtime go", gp);
  const inf = await get(`/api/infer?program=${encodeURIComponent(dir + "/spin")}`);
  ok(inf.type === "go" && inf.binfo?.opt === "-N -l", "/api/infer picks delve and reads -N -l from the build info", inf);
  const s = await attachAndPause({ type: "go", request: "attach", mode: "local", processId: g.pid, dapPath: `${dlv} dap` });
  ok(s?.type === "stopped", "attaching delve to the Go process and pausing stops it", s);
  ok(/main\.|runtime\./.test(frameText(s)), "the stop is in a Go frame", s?.frames);
  await detach();
} else {
  console.log("  note: dlv not found (set DAPWEB_TEST_DLV), Go attach skipped");
}

cleanup();
console.log(`\ne2e-runtime: ${pass} assertions passed`);
