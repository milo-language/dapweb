// E2E for `dapweb start` — the AI-starts-it, human-watches-it direction.
//
// Everything else in the CLI assumes a session already exists. This covers the
// one that makes one: it prints an identity an agent can drive with `api
// --session`, the session shows up in the registry every dashboard reads, and a
// port that is already taken is an honest failure rather than a success naming
// somebody else's session.
//
// Usage: bun tests/e2e-start.ts [binary]   (needs /tmp/dapweb_nested built)

const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_start_test_${process.pid}`;
const prog = "/tmp/dapweb_nested";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

const started: number[] = [];
async function run(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([bin, ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg },
  });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out: out.trim() };
}
const cleanup = () => { for (const pid of started) { try { process.kill(pid); } catch {} } };

// ── a session an agent made, that a human can open ──

const first = await run(["start", "--program", prog]);
ok(first.code === 0, "start exits 0", first);
let s1: any = null;
try { s1 = JSON.parse(first.out); } catch {}
ok(s1?.ok === true, "start prints one JSON line with ok:true", first.out);
ok(typeof s1?.sessionId === "string" && s1.sessionId.length > 0, "it carries a session id", s1);
ok(s1?.url === `http://localhost:${s1?.port}`, "and the url a human opens", s1);
ok(s1?.program === prog, "and the program it is on", s1);
if (s1?.pid) started.push(s1.pid);

// the server is actually up and is the one we were told about
const state = await (await fetch(`http://localhost:${s1.port}/api/state`)).json();
ok(state.sessionId === s1.sessionId, "the live server is the session start named", state);

// and it is in the registry every dashboard reads
const listed = await run(["api", "list"]);
ok(listed.out.includes(s1.sessionId), "it is listed among the live sessions", listed.out);

// ── the agent drives it; this is the whole point ──

const ran = await run(["api", "--session", s1.sessionId, "request", "--await", "stopped",
                       '{"cmd":"run","stopAtMain":true}']);
const stop = JSON.parse(ran.out);
ok(stop.type === "stopped" && stop.line === 14,
   "an agent drives the session it started, by id", { line: stop.line, path: stop.path });

// ── a taken port is a failure, not somebody else's session ──

const clash = await run(["start", "--port", String(s1.port), "--program", prog]);
ok(clash.code === 1, "start on a taken port exits non-zero", clash);
const cj = JSON.parse(clash.out);
ok(cj.ok === false && /already in use/.test(cj.error), "and says the port is taken", cj);
ok(!JSON.stringify(cj).includes(s1.sessionId),
   "it never reports the session that already held the port", cj);

// ── auto port-pick walks past what is taken ──

const second = await run(["start", "--program", prog]);
const s2 = JSON.parse(second.out);
ok(s2.ok === true && s2.port !== s1.port, "a second start picks a different port", { a: s1.port, b: s2.port });
ok(s2.sessionId !== s1.sessionId, "and is a distinct session", { a: s1.sessionId, b: s2.sessionId });
if (s2?.pid) started.push(s2.pid);

cleanup();
await Bun.$`rm -rf ${xdg}`.quiet();
console.log(`\ne2e-start: ${pass} assertions passed`);
process.exit(0);
