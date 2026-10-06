// The header's primary button: pure, so tested without a browser.
// Usage: bun tests/primary.ts

import { primaryAction, exitLabel } from "../src/web/ui/src/primary";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}

{
  const p = primaryAction({ phase: "idle", hasTarget: true });
  ok(p.kind === "run" && p.label === "Run" && !p.disabled, "idle with a target runs", p);
  ok(p.tip.includes("F5"), "and its tooltip names the shortcut", p);
}
{
  const p = primaryAction({ phase: "idle", hasTarget: false });
  ok(p.kind === "run" && p.disabled, "no target: Run is disabled, not hidden", p);
  ok(p.tip.includes("target bar"), "and its tooltip says what to set", p);
}
{
  const p = primaryAction({ phase: "running", hasTarget: true });
  ok(p.kind === "pause" && p.label === "Pause" && p.tip.includes("F6"), "running: Pause (F6)", p);
}
{
  const p = primaryAction({ phase: "stopped", hasTarget: true });
  ok(p.kind === "continue" && p.label === "Continue" && p.tip.includes("F5"), "stopped: Continue (F5)", p);
}

{
  const p = primaryAction({ phase: "done", hasTarget: true });
  ok(p.kind === "run" && p.label === "Run again" && !p.disabled, "after the program exits: Run again", p);
}
ok(exitLabel(0) === "exited 0" && exitLabel(1) === "exited 1", "the pill carries the exit code");
ok(exitLabel(undefined) === "ended", "no code: ended, not a claim of a clean exit");

console.log(`primary: ${pass} assertions passed`);
