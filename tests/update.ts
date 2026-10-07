// Release updates: the "newer build" decision, the notice `dapweb web` prints
// and puts in hello, and `dapweb update` swapping a binary in place.
//
// Everything points at a local HTTP server through the test-only env overrides
// (DAPWEB_UPDATE_URL, DAPWEB_UPDATE_BASE, DAPWEB_UPDATE_TEST_SELF; see
// src/update.milo). `dapweb update` only ever runs on a temp copy of the binary.
//
// Usage: bun tests/update.ts [binary]

import { freePort } from "./freeport";
import { realpathSync } from "node:fs";
import { own } from "./own";
const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const tmp = `/tmp/dapweb_update_test_${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const live: { kill(): void }[] = [];
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); return; }
  console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : "");
  for (const p of live) { try { p.kill(); } catch {} }
  process.exit(1);
}

await Bun.$`rm -rf ${tmp} && mkdir -p ${tmp}`.quiet();

// ── the fake release server ──

let remote = { sha: "bbb2222", date: "2026-02-01" };
let tarball: Uint8Array = new Uint8Array();
let versionHits = 0;
const srv = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/version.json") { versionHits++; return Response.json(remote); }
    if (path.endsWith(".tar.gz")) return new Response(tarball);
    return new Response("nope", { status: 404 });
  },
});
const base = `http://127.0.0.1:${srv.port}`;
const self = (sha: string, date: string) => JSON.stringify({ sha, date });
const OLD = self("aaa1111", "2026-01-01");

function env(extra: Record<string, string>) {
  return { ...process.env, DAPWEB_NO_OPEN: "1", DAPWEB_NO_UPDATE_CHECK: "", DAPWEB_UPDATE_BASE: base, ...extra };
}
async function run(exe: string, args: string[], extra: Record<string, string> = {}) {
  const p = own(Bun.spawn([exe, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: env(extra) }));
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out.trim(), err: err.trim() };
}

// ── the decision, table-driven through `update --check` ──

const NOTICE = "dapweb 2026-02-01 is available (you have 2026-01-01): run `dapweb update`";
const table: [string, { sha: string; date: string }, string | undefined, boolean][] = [
  ["a newer release is announced", { sha: "bbb2222", date: "2026-02-01" }, OLD, true],
  ["the same sha is not", { sha: "aaa1111", date: "2026-01-01" }, OLD, false],
  ["a different sha built the same day is", { sha: "ccc3333", date: "2026-01-01" }, OLD, true],
  ["a release older than this build is not", { sha: "ddd4444", date: "2025-12-31" }, OLD, false],
  ["a dev build never is", { sha: "bbb2222", date: "2026-02-01" }, undefined, false],
];
for (const [label, r, me, want] of table) {
  remote = r;
  const extra: Record<string, string> = { DAPWEB_UPDATE_URL: `${base}/version.json` };
  if (me) extra.DAPWEB_UPDATE_TEST_SELF = me;
  const res = await run(bin, ["update", "--check"], extra);
  ok(res.code === 0 && /is available/.test(res.out) === want, label, res);
}
remote = { sha: "bbb2222", date: "2026-02-01" };
ok((await run(bin, ["update", "--check"], { DAPWEB_UPDATE_URL: `${base}/version.json`, DAPWEB_UPDATE_TEST_SELF: OLD })).out === NOTICE,
   "the notice names both dates and the command");

// ── the notice from `dapweb web`: stdout and hello ──

async function web(xdg: string, extra: Record<string, string>) {
  const port = await freePort();
  const p = own(Bun.spawn([bin, "web", "--port", String(port), "--no-browser", "--quiet"], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: env({ XDG_STATE_HOME: xdg, ...extra }),
  }));
  live.push(p);
  let out = "";
  (async () => { for await (const c of p.stdout) out += new TextDecoder().decode(c); })();
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://localhost:${port}/api/state`); break; } catch { await sleep(100); }
  }
  return { p, port, stdout: () => out };
}
async function hello(port: number): Promise<any> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const m = await new Promise<any>((res, rej) => {
    ws.onmessage = (e) => { const j = JSON.parse(String(e.data)); if (j.type === "hello") res(j); };
    ws.onerror = rej;
    setTimeout(() => rej(new Error("no hello")), 5000);
  });
  ws.close();
  return m;
}
async function waitFor(f: () => boolean, ms: number) {
  for (let t = 0; t < ms && !f(); t += 100) await sleep(100);
  return f();
}

{
  const xdg = `${tmp}/xdg1`;
  versionHits = 0;
  const s = await web(xdg, { DAPWEB_UPDATE_URL: `${base}/version.json`, DAPWEB_UPDATE_TEST_SELF: OLD });
  ok(await waitFor(() => s.stdout().includes(NOTICE), 8000), "web prints the notice on stdout", s.stdout());
  const h = await hello(s.port);
  ok(h.update === NOTICE, "a tab that joins later gets it in hello", h.update);
  ok(h.version === "aaa1111 (2026-01-01)", "hello carries this build's version", h.version);
  s.p.kill();

  // Within a day the cached answer is used: no request, and still a notice even
  // with the release server unreachable.
  const before = versionHits;
  const s2 = await web(xdg, { DAPWEB_UPDATE_URL: "http://127.0.0.1:1/version.json", DAPWEB_UPDATE_TEST_SELF: OLD });
  ok(await waitFor(() => s2.stdout().includes(NOTICE), 8000), "a second start within the day uses the cached check", s2.stdout());
  ok(versionHits === before, "and does not fetch again", versionHits - before);
  s2.p.kill();
}
{
  versionHits = 0;
  const s = await web(`${tmp}/xdg2`, { DAPWEB_UPDATE_URL: `${base}/version.json`, DAPWEB_UPDATE_TEST_SELF: OLD, DAPWEB_NO_UPDATE_CHECK: "1" });
  await sleep(1500);
  const h = await hello(s.port);
  ok(versionHits === 0 && !s.stdout().includes("is available") && h.update === undefined,
     "DAPWEB_NO_UPDATE_CHECK=1 neither checks nor notifies", { versionHits, out: s.stdout(), u: h.update });
  s.p.kill();
}
{
  versionHits = 0;
  const s = await web(`${tmp}/xdg3`, { DAPWEB_UPDATE_URL: `${base}/version.json`, DAPWEB_UPDATE_TEST_SELF: self("bbb2222", "2026-02-01") });
  ok(await waitFor(() => versionHits > 0, 8000), "an up-to-date build still checks", versionHits);
  await sleep(500);
  const h = await hello(s.port);
  ok(!s.stdout().includes("is available") && h.update === undefined, "but announces nothing", { out: s.stdout(), u: h.update });
  s.p.kill();
}

// ── dapweb update on a temp copy ──

const plat = `${(await Bun.$`uname -s`.text()).trim().toLowerCase()}-${(await Bun.$`uname -m`.text()).trim().replace("x86_64", "x64").replace("aarch64", "arm64")}`;
await Bun.$`mkdir -p ${tmp}/pkg/dapweb-${plat}`.quiet();
await Bun.write(`${tmp}/pkg/dapweb-${plat}/dapweb`, `#!/bin/sh\necho "dapweb bbb2222 (2026-02-01)"\n`);
await Bun.$`chmod 755 ${tmp}/pkg/dapweb-${plat}/dapweb && tar czf ${tmp}/fake.tar.gz -C ${tmp}/pkg dapweb-${plat}`.quiet();
tarball = new Uint8Array(await Bun.file(`${tmp}/fake.tar.gz`).arrayBuffer());

const inst = `${tmp}/inst`;
const copy = `${inst}/dapweb`;
await Bun.$`mkdir -p ${inst} && cp ${bin} ${copy}`.quiet();
const origSize = Bun.file(copy).size;

// A corrupt download must leave the binary alone.
tarball = new Uint8Array([1, 2, 3, 4]);
let r = await run(copy, ["update"], { DAPWEB_UPDATE_TEST_SELF: OLD });
ok(r.code === 1 && Bun.file(copy).size === origSize, "a corrupt download fails and keeps the old binary", r);
ok((await run(copy, ["--version"], { DAPWEB_UPDATE_TEST_SELF: OLD })).out.startsWith("dapweb aaa1111"), "which still runs");
tarball = new Uint8Array(await Bun.file(`${tmp}/fake.tar.gz`).arrayBuffer());

// Same sha: nothing to do.
remote = { sha: "aaa1111", date: "2026-01-01" };
r = await run(copy, ["update"], { DAPWEB_UPDATE_TEST_SELF: OLD });
ok(r.code === 0 && /already up to date/.test(r.out) && Bun.file(copy).size === origSize, "same sha: already up to date, binary untouched", r);

// An unwritable install dir says what to run instead.
remote = { sha: "bbb2222", date: "2026-02-01" };
await Bun.$`chmod 555 ${inst}`.quiet();
r = await run(copy, ["update"], { DAPWEB_UPDATE_TEST_SELF: OLD });
await Bun.$`chmod 755 ${inst}`.quiet();
ok(r.code === 1 && r.err.includes(`sudo ${realpathSync(copy)} update`), "an unwritable dir names the command to run instead", r);

r = await run(copy, ["upgrade"], { DAPWEB_UPDATE_TEST_SELF: OLD });
ok(r.code === 0 && /updated /.test(r.out), "update (as upgrade) installs the newer release", r);
const after = await run(copy, ["--version"]);
ok(after.out === "dapweb bbb2222 (2026-02-01)", "the binary at the same path is now the new one", after);
// statSync, not the stat CLI: `stat -f` is a format flag on macOS but means
// "filesystem status" on Linux, which succeeded there and printed the wrong thing.
const mode = (require("node:fs").statSync(copy).mode & 0o777).toString(8);
ok(mode === "755", "and is executable", mode);
const left = (await Bun.$`ls -A ${inst}`.text()).trim();
ok(left === "dapweb", "no staging files are left behind", left);

srv.stop(true);
await Bun.$`rm -rf ${tmp}`.quiet();
console.log(`\nupdate: ${pass} assertions passed`);
