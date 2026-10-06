// Follow the agent: the pure "should this push move the editor" decision.
// Usage: bun tests/follow.ts

import { followTarget } from "../src/web/ui/src/follow";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

const F = "/src/main.c";
const stop = (by: string | undefined, extra: any = {}) => ({
  type: "stopped", by, line: 22, path: F, tid: 1, frames: [{ id: 1, name: "main", line: 22, path: F, ipRef: "" }], ...extra,
});

ok(eq(followTarget(stop("agent"), true), { path: F, line: 22, flash: true }), "an agent's stop is followed and flashed");
ok(followTarget(stop("user"), true) === null, "the user's own stop is not");
ok(followTarget(stop(undefined), true) === null, "a stop with no attribution is not");
ok(followTarget(stop("agent"), false) === null, "nothing is followed with follow off");

// The top frame wins over the stop's own path: it is the line the editor shows.
const inner = stop("agent", { frames: [{ id: 2, name: "perimeter", line: 9, path: "/src/shapes.c", ipRef: "" }] });
ok(eq(followTarget(inner, true), { path: "/src/shapes.c", line: 9, flash: true }), "a stop is followed to its top frame");
// A no-debug-info frame has a pseudo-path: nothing to show in a source editor.
const nosrc = stop("agent", { path: "", frames: [{ id: 3, name: "x", line: 0, path: "libc.dylib`write", ipRef: "0x1" }] });
ok(followTarget(nosrc, true) === null, "a stop in a frame with no source is not followed");

const bp = (by: string, set: boolean) => ({ type: "breakpoint", by, path: F, line: 18, set });
ok(eq(followTarget(bp("agent", true), true), { path: F, line: 18, flash: true }), "an agent's breakpoint set is followed");
ok(eq(followTarget(bp("agent", false), true), { path: F, line: 18, flash: true }), "and its clear");
ok(followTarget(bp("user", true), true) === null, "the user's breakpoint is not");

ok(eq(followTarget({ type: "source", by: "agent", path: F, content: "" }, true), { path: F, line: 0, flash: false }),
   "an agent's openSource shows the file without a flash");
ok(followTarget({ type: "source", path: F, content: "" }, true) === null, "a stop-driven source push is not a follow");
ok(followTarget({ type: "activity", by: "agent", text: "x" }, true) === null, "other messages are not followed");

console.log(`\nfollow: ${pass} checks passed`);
