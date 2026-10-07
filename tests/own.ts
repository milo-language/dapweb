// Every process a suite starts dies with the suite, however the suite ends: a
// failed check's process.exit, an uncaught throw (a wait that timed out), or a
// SIGINT/SIGTERM from whoever runs it. A server left running is reparented to
// init and lives forever; scripts/test.sh's no-orphans gate fails the run on any
// that escape, so spawn through own() rather than remembering to kill.
//
// Servers get SIGTERM, not SIGKILL: their own shutdown ends what they launched.

type Killable = { pid: number; kill(sig?: number | NodeJS.Signals): void };

const owned = new Set<Killable>();

export function own<T extends Killable>(p: T): T {
  owned.add(p);
  return p;
}

// For a process known only by pid (a `dapweb start` server is not our child).
export function ownPid(pid: number): void {
  owned.add({ pid, kill: (sig) => process.kill(pid, sig ?? "SIGTERM") });
}

function killAll() {
  for (const p of owned) { try { p.kill("SIGTERM"); } catch {} }
  owned.clear();
}

process.on("exit", killAll);
for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) {
  process.on(sig, () => { killAll(); process.exit(128 + n); });
}
