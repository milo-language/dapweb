// The Timeline tab's parse of journal rows (/api/log?kind=stopped): pure, so
// tested without a server. Usage: bun tests/recordedstops.ts

import { parseStopRow, parseStopRows, mergeStops, timelineQuery, TIMELINE_LIMIT } from "../src/web/ui/src/recordedStops";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}

const payload = (o: any) => JSON.stringify({
  type: "stopped", line: 22, path: "/src/main.c", tid: 7, reason: "step", description: "", atMain: false,
  by: "agent", who: "bot", scopeRef: 1000, registersRef: 0,
  frames: [{ id: 1, name: "main", line: 22, path: "/src/main.c", ipRef: "0x1" }],
  locals: [{ name: "i", value: "3", ref: 0 }], ...o,
});
const row = (seq: number, o: any = {}, extra: any = {}) => ({
  seq, session: "s", at: 1000 * seq, dir: "out", kind: "stopped", path: "/src/main.c", line: 22, tid: 7,
  peer: "agent", who: "bot", payload: payload(o), ...extra,
});

{
  const s = parseStopRow(row(5));
  ok(s.seq === 5 && s.at === 5000 && s.reason === "step" && s.line === 22, "scalars come from the row", s);
  ok(s.by === "agent" && s.who === "bot", "attribution from the promoted columns", s);
  ok(s.frames?.[0].name === "main" && s.locals?.[0].name === "i", "frames and locals from the payload", s);
}
{
  // A row from before the columns were promoted: the payload still says who.
  const s = parseStopRow(row(1, { by: "user", who: "browser" }, { peer: undefined, who: undefined }));
  ok(s.by === "user" && s.who === "browser", "attribution falls back to the payload", s);
}
{
  // Anything that is not "agent" is the user: an unattributed stop must never
  // be painted as an agent's.
  const s = parseStopRow(row(1, { by: undefined, who: undefined }, { peer: undefined, who: undefined }));
  ok(s.by === "user", "an unattributed stop is not an agent's", s);
}
{
  // A truncated row is a prefix: no frames or locals, but the scalars before
  // them (and the promoted columns) survive.
  const full = payload({});
  const s = parseStopRow(row(2, {}, { payload: full.slice(0, full.indexOf('"frames"') + 12), truncatedFrom: full.length }));
  ok(s.frames === null && s.locals === null, "a truncated stop has no frames or locals", s);
  ok(s.reason === "step" && s.by === "agent" && s.line === 22, "but keeps what was before them", s);
}
{
  const s = parseStopRow(row(3, { locals: undefined }));
  ok(s.frames !== null && s.locals === null, "a stored stop without locals is frames only", s);
}
{
  const at = parseStopRow(row(4, { atMain: true, reason: "breakpoint" }));
  ok(at.atMain === true, "the stop-at-main flag is kept", at);
}

const asc = [row(10), row(11, { by: "user" }, { peer: "user" }), row(12)];
const tl = parseStopRows(asc);
ok(tl.map((s) => s.seq).join(",") === "12,11,10", "newest first (the log answers oldest first)", tl.map((s) => s.seq));
ok(tl[1].by === "user", "order keeps each row's attribution", tl.map((s) => s.by));

const merged = mergeStops(tl, parseStopRows([row(12), row(13)]));
ok(merged.map((s) => s.seq).join(",") === "13,12,11,10", "a live fetch goes on top and overlaps are not doubled", merged.map((s) => s.seq));
const many = parseStopRows(Array.from({ length: TIMELINE_LIMIT + 5 }, (_, i) => row(i + 1)));
ok(mergeStops([], many).length === TIMELINE_LIMIT && mergeStops([], many)[0].seq === TIMELINE_LIMIT + 5,
   "bounded, keeping the newest", mergeStops([], many).length);

ok(timelineQuery() === `/api/log?kind=stopped&dir=out&limit=${TIMELINE_LIMIT}`, "the query", timelineQuery());
ok(timelineQuery(42).endsWith("&since=42"), "an incremental query resumes after a seq", timelineQuery(42));

console.log(`\nrecordedstops: ${pass} checks passed`);
