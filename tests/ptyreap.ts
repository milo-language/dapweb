// A reaped debuggee's pid must never be signalled again: by then it may belong to
// an unrelated process. dapweb used to wait on the pty child through a borrow,
// leave the handle in proc.pty, and SIGKILL the same pid at the next teardown.
// The fix is structural (src/web/ptychild.milo): the child is signalled and
// waited only by DebuggeePty.reap(), which consumes the handle. A runtime test
// cannot force a pid to be reused, so this asserts the compiler rejects every
// way back to a reaped child, next to a control that compiles, so a probe that
// fails for an unrelated reason is caught rather than counted.
//
// Usage: bun tests/ptyreap.ts   (MILO=/path/to/milo/src/main.ts or a milo binary)

const root = (import.meta.dir + "/..").replace(/\/tests\/\.\.$/, "");
const milo = process.env.MILO ?? `${root}/../milo/src/main.ts`;
const miloCmd = milo.endsWith(".ts") ? ["bun", "run", milo] : [milo];
// Inside src/web so the probe imports ptychild the way dapweb's own files do.
const probe = `${root}/src/web/_ptyreap_probe_${process.pid}.milo`;

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail ?? ""); cleanup(); process.exit(1); }
}
function cleanup() { Bun.spawnSync(["rm", "-f", probe, probe.replace(/\.milo$/, "")]); }

function check(body: string): { ok: boolean; out: string } {
  const src = `from "./ptychild" import {\n    DebuggeePty\n}\n\nvar gSlot: Option<DebuggeePty> = Option.None\n\nfn main(): i32 {\n${body}\n    return 0\n}\n`;
  Bun.write(probe, src);
  const r = Bun.spawnSync([...miloCmd, "check", probe], { cwd: root });
  const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
  return { ok: r.exitCode === 0, out };
}

const spawn = `    let args: Vec<string> = []\n    let Result.Ok(p) = DebuggeePty.spawn("/usr/bin/true", args, 0, 0) else {\n        return 1\n    }\n`;

const control = check(spawn + "    p.reap()");
ok(control.ok, "control: spawn then reap compiles", control.out);

const twice = check(spawn + "    p.reap()\n    p.reap()");
ok(!twice.ok && /mov/i.test(twice.out), "reaping the same child twice is a compile error", twice.out);

const after = check(spawn + "    p.reap()\n    let _x = p.pid()");
ok(!after.ok && /mov/i.test(after.out), "using a handle after reap is a compile error", after.out);

const borrowed = check(spawn + "    gSlot = Option.Some(p)\n    if let Option.Some(q) = gSlot {\n        q.reap()\n    }");
ok(!borrowed.ok && /cannot move out/.test(borrowed.out), "reaping through a borrow of the slot (leaving the handle behind) is a compile error", borrowed.out);

const raw = check(spawn + "    p._pty.kill()\n    p.reap()");
ok(!raw.ok && /private/i.test(raw.out), "the raw std Pty inside is out of reach (private field)", raw.out);

// The guarantee holds only if nothing else in dapweb holds a raw std Pty.
const users: string[] = [];
for (const f of new Bun.Glob("src/**/*.milo").scanSync({ cwd: root })) {
  if (/from "std\/pty" import \{[^}]*\bPty\b/.test(await Bun.file(`${root}/${f}`).text())) users.push(f);
}
ok(users.length === 1 && users[0] === "src/web/ptychild.milo",
   "src/web/ptychild.milo is the only file importing std/pty's Pty", users);

cleanup();
console.log(`\nptyreap: ${pass} checks passed`);
