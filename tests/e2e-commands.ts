// The command vocabulary, checked against the code that implements it.
//
// src/commands.milo is now the one list of `{"cmd":...}` names: the dispatcher
// rejects anything absent from it, the activity announcements phrase themselves
// from it, /api/commands serves it and `dapweb api spec` prints it. That only
// stays true if the table and the dispatcher's if-chain agree, so this compares
// them in BOTH directions — a table entry nothing dispatches is a documented
// command that does nothing, and a dispatched case with no entry is a command
// the dispatcher will now refuse.
//
// Usage: bun tests/e2e-commands.ts [binary]

const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_cmds_test_${process.pid}`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

// ── the dispatcher's own list, read out of the source ──

const server = await Bun.file(`${root}/src/web/server.milo`).text();
const from = server.indexOf("fn dispatchClientCmd(");
ok(from > 0, "found dispatchClientCmd in server.milo");
// The chain ends at the next top-level fn; everything between is its body.
const to = server.indexOf("\nfn ", from + 10);
const body = server.slice(from, to > 0 ? to : undefined);
const dispatched = new Set([...body.matchAll(/c == "([A-Za-z]+)"/g)].map((m) => m[1]));
ok(dispatched.size > 15, `the chain dispatches ${dispatched.size} commands`, [...dispatched]);

// ── the table, as the running server serves it ──

const port = 8770 + (process.pid % 40);
const srv = Bun.spawn([bin, "web", "--port", String(port), "--quiet", "--program", "/tmp/dapweb_nested"], {
  cwd: root, stdout: "pipe", stderr: "pipe",
  env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg },
});
let spec: any = null;
for (let i = 0; i < 60; i++) {
  try { spec = await (await fetch(`http://localhost:${port}/api/commands`)).json(); break; } catch { await sleep(100); }
}
ok(spec && Array.isArray(spec.commands), "/api/commands serves the table", spec);
const table = new Set(spec.commands.map((c: any) => c.cmd));

// ── they must agree, both ways ──

const undocumented = [...dispatched].filter((c) => !table.has(c));
ok(undocumented.length === 0,
   "every command the dispatcher handles is in the table (else it is refused)", undocumented);
const unimplemented = [...table].filter((c) => !dispatched.has(c));
ok(unimplemented.length === 0,
   "every command in the table is one the dispatcher handles", unimplemented);

// ── the table says enough to be useful ──

ok(spec.commands.every((c: any) => c.summary && c.summary.length > 5), "every entry has a summary",
   spec.commands.filter((c: any) => !c.summary).map((c: any) => c.cmd));
ok(typeof spec.dapSpec === "string" && spec.dapSpec.startsWith("https://"),
   "and the table points at the DAP spec", spec.dapSpec);
ok(spec.commands.find((c: any) => c.cmd === "run")?.awaits === "stopped",
   "an entry names the reply --await should block for");
ok(spec.commands.find((c: any) => c.cmd === "evaluate")?.dap === "evaluate",
   "and the DAP request it becomes, where there is one");
ok(spec.commands.find((c: any) => c.cmd === "stdin")?.dap === "",
   "commands dapweb serves itself say so by naming no DAP request");

// ── an unknown command is refused, not cheerfully accepted ──

async function post(bodyJson: string) {
  const r = await fetch(`http://localhost:${port}/api/cmd?agent=test&pid=1`, {
    method: "POST", headers: { "content-type": "application/json" }, body: bodyJson,
  });
  return r.json();
}
for (const [payload, what] of [
  ['{"cmd":"totalNonsense"}', "a nonsense command"],
  ['{}', "a payload with no cmd at all"],
  ['{"cmd":""}', "an empty cmd"],
  ['{"cmd":"Run"}', "the right command in the wrong case"],
] as [string, string][]) {
  const reply = await post(payload);
  ok(reply.ok === false, `${what} is refused`, reply);
  ok(/known commands:/.test(reply.error || ""), `${what} is told what it may say instead`, reply);
}
ok((await post('{"cmd":"run"}')).ok === true, "and a real command still succeeds");

// The CLI has to make it branchable, or a script cannot tell either.
const cli = async (args: string[]) => {
  const p = Bun.spawn([bin, ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, XDG_STATE_HOME: xdg } });
  return { code: await p.exited, out: (await new Response(p.stdout).text()).trim() };
};
const bad = await cli(["api", "--port", String(port), "request", '{"cmd":"nope"}']);
ok(bad.code !== 0, "`api request` exits non-zero on a refusal", bad);
const spec2 = await cli(["api", "spec"]);
ok(spec2.code === 0 && /dapweb command vocabulary/.test(spec2.out),
   "`api spec` prints the vocabulary without needing a session", spec2.out.slice(0, 80));
ok([...table].every((c) => spec2.out.includes(String(c))),
   "and lists every command the table has");

srv.kill();
await Bun.$`rm -rf ${xdg}`.quiet();
console.log(`\ne2e-commands: ${pass} assertions passed`);
process.exit(0);
