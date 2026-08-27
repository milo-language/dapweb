// E2E for the journal: `dapweb log` reads back what a live session was asked to
// do and what it answered, from disk, with the server gone.
// Usage: bun tests/journal.ts [binary]

const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_journal_test_${process.pid}`;
const src = "/tmp/dapweb_journal_demo.c";
const exe = "/tmp/dapweb_journal_demo";
// Small enough that a few hundred events blow past it, so the eviction path is
// exercised rather than assumed, and large enough that the WAL's own 512KB
// floor is not most of it.
const CAP = 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

await Bun.write(src, `#include <stdio.h>
int main(void) {
    int s = 0;
    for (int i = 0; i < 3; i++) {
        s += i;
        printf("%d\\n", s);
    }
    return 0;
}
`);
{
  const c = Bun.spawnSync(["clang", "-g", "-O0", src, "-o", exe]);
  if (c.exitCode !== 0) { console.error("clang failed:", c.stderr.toString()); process.exit(1); }
}

const env = { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg, DAPWEB_JOURNAL_MAX_BYTES: String(CAP) };
const port = 8900 + (process.pid % 90);
const srv = Bun.spawn([bin, "web", "--program", exe, "--source", src, "--port", String(port), "--quiet"], {
  cwd: root, env, stdout: "ignore", stderr: "ignore",
});
await sleep(2500);

const cmd = (body: any, awaitType?: string) =>
  fetch(`http://localhost:${port}/api/cmd${awaitType ? `?await=${awaitType}&timeout=8000` : ""}`,
        { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

// `dapweb log` in a separate process, reading the same journal file.
function log(args: string[]): any[] {
  const p = Bun.spawnSync([bin, "log", "--json", ...args], { cwd: root, env });
  const out = p.stdout.toString().trim();
  if (!out) return [];
  return out.split("\n").map((l) => JSON.parse(l));
}

try {
  await cmd({ cmd: "setBreakpoint", path: src, line: 5 }, "breakpoint");
  await cmd({ cmd: "run" }, "stopped");
  await cmd({ cmd: "stepOver" }, "stopped");
  const refused = await cmd({ cmd: "stepOvr" });   // a typo, on purpose
  ok(refused.ok === false, "the server still refuses an unknown command", refused);

  // ── what the journal recorded ──
  {
    const rows = log(["--dir", "in", "--limit", "50"]);
    const kinds = rows.map((r) => r.kind);
    ok(kinds.includes("setBreakpoint") && kinds.includes("run") && kinds.includes("stepOver"),
       "every command a peer sent is in the journal", kinds);
    const bad = rows.find((r) => r.kind === "stepOvr");
    ok(bad && bad.ok === false && /not a dapweb command/.test(bad.error),
       "a refused command is recorded WITH the refusal", bad);
    const bp = rows.find((r) => r.kind === "setBreakpoint");
    ok(bp?.path === src && bp?.line === 5, "the breakpoint's file and line are promoted to columns", bp);
    ok(rows.every((r) => r.seq > 0 && r.at > 0 && r.dir === "in"), "--dir in returns only inbound rows", rows[0]);
  }
  {
    const rows = log(["--dir", "out", "--limit", "200"]);
    ok(rows.some((r) => r.kind === "stopped"), "broadcasts are recorded too", rows.map((r) => r.kind));
    ok(!rows.some((r) => r.kind === "ptyData" || r.kind === "source"),
       "raw terminal bytes and whole source files are not", rows.map((r) => r.kind));
  }
  {
    const rows = log(["--kind", "run"]);
    ok(rows.length >= 1 && rows.every((r) => r.kind === "run"), "--kind filters", rows);
    const all = log(["--limit", "500"]);
    const mid = all[Math.floor(all.length / 2)].seq;
    const after = log(["--since", String(mid), "--limit", "500"]);
    ok(after.length > 0 && after.every((r) => r.seq > mid), "--since resumes where a reader left off", after[0]);
  }
  {
    const ses = log(["--sessions"]);
    ok(ses.length === 1 && ses[0].program === exe && ses[0].events > 0, "the session is described", ses);
  }
  {
    const bps = log(["--breakpoints"]);
    const row = bps.find((b) => b.line === 5);
    ok(row && row.sessionsSet === 1 && row.sessionsHit === 1,
       "a breakpoint that was set and then stopped on counts as both", bps);
  }

  // ── the cap actually evicts ──
  {
    const before = log(["--limit", "1"])[0].seq;
    // >256 inserts (the prune interval) of >4KB each, so the store must pass CAP.
    const filler = "x".repeat(5000);
    for (let i = 0; i < 400; i++) await cmd({ cmd: "evaluate", expr: `${filler}${i}` });
    const bytes = (p: string) => { try { return Bun.file(p).size; } catch { return 0; } };
    const db = `${xdg}/dapweb/journal.db`;
    // The WAL is a write buffer that lives above the cap until the next
    // checkpoint, so the store proper is what the cap binds.
    // The cap is enforced every 256KB written, not on every row, so the store
    // may sit that far above it between checks.
    ok(bytes(db) <= CAP + 512 * 1024, `the journal stays at its ${CAP} byte cap (was ${bytes(db)})`, bytes(db));
    const total = bytes(db) + bytes(db + "-wal");
    ok(total <= CAP + 1_500_000, `and the WAL above it stays bounded (total ${total})`, total);
    const after = log(["--limit", "1"])[0].seq;
    ok(after > before, "the oldest events were evicted, not the newest", { before, after });
    const still = log(["--limit", "5"]);
    ok(still.length > 0, "and the journal is still readable after eviction", still.length);
  }

  // ── --no-journal ──
  {
    const port2 = port + 1;
    const xdg2 = xdg + "_off";
    const s2 = Bun.spawn([bin, "web", "--program", exe, "--port", String(port2), "--quiet", "--no-journal"],
      { cwd: root, env: { ...env, XDG_STATE_HOME: xdg2 }, stdout: "ignore", stderr: "ignore" });
    await sleep(2000);
    await fetch(`http://localhost:${port2}/api/cmd`, { method: "POST", body: JSON.stringify({ cmd: "setBreakpoint", path: src, line: 5 }) });
    s2.kill();
    ok(!(await Bun.file(`${xdg2}/dapweb/journal.db`).exists()), "--no-journal writes no journal at all");
  }

  console.log(`\n  ${pass} checks passed`);
} finally {
  srv.kill();
  Bun.spawnSync(["rm", "-rf", xdg, xdg + "_off"]);
}
