// E2E for /api/infer: the target dialog's "Auto" debugger and binary summary
// for a typed path. Real clang builds of examples/nested at -O0 and -O2 must
// come back with the optimization level the binary records.
//
// Usage: bun tests/e2e-infer.ts [binary]

import { freePort } from "./freeport";
import { own } from "./own";
const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_infer_test_${process.pid}`;
const out = `/tmp/dapweb_infer_${process.pid}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let srv: any = null;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ""); srv?.kill(); process.exit(1); }
}

const port = await freePort();
srv = own(Bun.spawn([bin, "web", "--port", String(port), "--quiet"], {
  cwd: root, stdout: "pipe", stderr: "pipe",
  env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg },
}));
const base = `http://localhost:${port}`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${base}/api/state`)).ok) break; } catch {}
  await sleep(100);
}
const infer = async (p: string) => (await fetch(`${base}/api/infer?program=${encodeURIComponent(p)}`)).json();

// -grecord-command-line makes the -O switch part of the DWARF on both platforms
// (DW_AT_producer on Linux, DW_AT_APPLE_flags on Darwin), so the level is exact.
const srcs = [`${root}/examples/nested/main.c`, `${root}/examples/nested/shapes.c`];
const build = (name: string, flags: string[]) => {
  const r = Bun.spawnSync(["clang", "-g", ...flags, ...srcs, "-o", `${out}/${name}`, "-lm"]);
  ok(r.exitCode === 0, `clang ${flags.join(" ")} builds`, r.stderr.toString());
  return `${out}/${name}`;
};
Bun.spawnSync(["mkdir", "-p", out]);

{
  const d = await infer(build("o0", ["-O0", "-grecord-command-line"]));
  ok(d.type === "lldb", "a native binary infers lldb", d);
  ok(d.binfo?.opt === "-O0" && d.binfo?.optimized === false, "an -O0 build reports opt -O0, not optimized", d.binfo);
  ok(d.binfo?.hasDebugInfo === true, "and has debug info", d.binfo);
  ok(typeof d.hostArch === "string" && d.hostArch.length > 0, "the host architecture rides along", d);
  ok(d.binfo?.arch === d.hostArch, "a native build matches the host architecture", d);
}
{
  const d = await infer(build("o2", ["-O2", "-grecord-command-line"]));
  ok(d.binfo?.opt === "-O2" && d.binfo?.optimized === true, "an -O2 build reports opt -O2, optimized", d.binfo);
}
if (process.platform === "darwin") {
  // Without the recorded command line only clang's per-function flag is left.
  const d2 = await infer(build("o2plain", ["-O2"]));
  ok(d2.binfo?.opt === "optimized" && d2.binfo?.optSource === "DW_AT_APPLE_optimized",
     "a plain -O2 build is optimized by DW_AT_APPLE_optimized", d2.binfo);
  const d0 = await infer(build("o0plain", ["-O0"]));
  ok(d0.binfo?.optimized === false && d0.binfo?.opt === "not optimized",
     "a plain -O0 build is not optimized (no function carries the flag)", d0.binfo);
}
{
  // -g0 after build's -g turns debug info back off
  const d = await infer(build("nodebug", ["-g0", "-O0"]));
  ok(d.binfo?.hasDebugInfo === false && d.binfo?.opt === "unknown", "a build without -g has no debug info and no opt level", d.binfo);
}
{
  ok((await infer("/tmp/some/script.py")).type === "python", ".py infers python");
  ok((await infer("/tmp/app.mjs")).type === "node", ".mjs infers node");
  ok((await infer("/tmp/app.jar")).type === "java", ".jar infers java");
  const missing = await infer(`${out}/does-not-exist`);
  ok(missing.binfo?.exists === false, "a missing path reports exists:false", missing);
  const dev = await infer("/dev/tty");
  ok(dev.binfo?.exists === false && dev.binfo?.format === undefined, "device paths are never opened", dev);
  const spaced = `${out}/with space`;
  Bun.spawnSync(["cp", `${out}/o0`, spaced]);
  ok((await infer(spaced)).binfo?.exists === true, "a path with a space survives the query string");
}

srv.kill();
Bun.spawnSync(["rm", "-rf", out, xdg]);
console.log(`\ne2e-infer: ${pass} assertions passed`);
