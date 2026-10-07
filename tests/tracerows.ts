// The Timeline tab's folding of a replay trace into rows (traceRows.ts): pure,
// so tested without a server. Usage: bun tests/tracerows.ts

import { traceRows, rowOf, fmtBytes, TraceRec } from "../src/web/ui/src/traceRows";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}

const rec = (seq: number, kind: string, payloadLen = 3): TraceRec => ({ seq, kind, arg: kind === "fs.read" ? "5 110" : "", payloadLen, preview: "" });
// The replay demo's shape: file calls, a clock read, eight scheduler picks, a clock read.
const recs = [rec(1, "fs.open"), rec(2, "fs.read", 111), rec(3, "time.wall", 17),
  ...[4, 5, 6, 7, 8, 9, 10, 11].map((s) => rec(s, "sched.pick")), rec(12, "time.wall", 17),
  rec(13, "sched.idle"), rec(14, "fs.read")];

{
  const rows = traceRows(recs);
  ok(rows.length === 7, "eight consecutive scheduler records fold into one row", rows.map((r) => r.kind));
  const g = rows[3];
  ok(g.group && g.first === 4 && g.last === 11 && g.count === 8 && g.kind === "sched.pick" && g.bytes === 24,
     "the group row spans its records, names their kind and sums their payloads", g);
  ok(!rows[5].group && rows[5].kind === "sched.idle", "a lone scheduler record stays a plain row", rows[5]);
  ok(rows[1].arg === "5 110" && rows[1].bytes === 111, "a plain row carries its arg and payload size", rows[1]);
  ok(rowOf(rows, 7) === 3, "a record inside a folded group marks the group row");
  ok(rowOf(rows, 12) === 4 && rowOf(rows, 99) === -1, "a plain record marks its own row; an unloaded one none");
}
{
  const rows = traceRows(recs, new Set([4]));
  ok(rows.length === 15 && rows[3].group && rows[4].sub && rows[4].first === 4 && rows[11].first === 11,
     "an expanded group lists its records under it", rows.map((r) => `${r.first}${r.sub ? "s" : ""}`));
  ok(rowOf(rows, 7) === 7, "expanded, a record marks its own row, not the group");
}
{
  const mixed = traceRows([rec(1, "sched.pick"), rec(2, "sched.wake"), rec(3, "sched.pick")]);
  ok(mixed.length === 1 && mixed[0].kind === "scheduler" && mixed[0].count === 3, "mixed scheduler kinds fold as 'scheduler'", mixed);
}
ok(fmtBytes(17) === "17 B" && fmtBytes(2048) === "2.0 KB" && fmtBytes(3 * 1024 * 1024) === "3.0 MB", "payload sizes read as B, KB, MB");
console.log(`tracerows: ${pass} passed`);
