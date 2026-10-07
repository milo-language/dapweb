// The Timeline tab's view of a replay trace (/api/trace): records folded into
// display rows. Pure, so tested without a server (tests/tracerows.ts).

export type TraceRec = { seq: number; kind: string; arg: string; payloadLen: number; preview: string };
// One display row: a single record, or a run of consecutive scheduler records
// (`first`..`last`), which a green-task program writes by the hundred and which
// say nothing apart.
export type TraceRow = {
  first: number; last: number; count: number; kind: string;
  arg: string; bytes: number; preview: string; group: boolean;
  sub: boolean;   // one record of an expanded group, listed under it
};

export const TRACE_PAGE = 1000;
export const isSched = (kind: string) => kind.startsWith("sched.");

// `expanded` holds the first seq of each group shown record by record.
export function traceRows(recs: TraceRec[], expanded: Set<number> = new Set()): TraceRow[] {
  const out: TraceRow[] = [];
  const one = (r: TraceRec, sub = false): TraceRow => ({
    first: r.seq, last: r.seq, count: 1, kind: r.kind, arg: r.arg, bytes: r.payloadLen, preview: r.preview, group: false, sub,
  });
  let i = 0;
  while (i < recs.length) {
    let j = i;
    while (j < recs.length && isSched(recs[j].kind)) j++;
    if (j - i >= 2) {
      const run = recs.slice(i, j);
      const kinds = new Set(run.map((r) => r.kind));
      out.push({
        first: run[0].seq, last: run[run.length - 1].seq, count: run.length,
        kind: kinds.size === 1 ? run[0].kind : "scheduler", arg: "",
        bytes: run.reduce((n, r) => n + r.payloadLen, 0), preview: "", group: true, sub: false,
      });
      if (expanded.has(run[0].seq)) for (const r of run) out.push(one(r, true));
      i = j;
    } else {
      out.push(one(recs[i]));
      i++;
    }
  }
  return out;
}

// The row to mark for record `seq`: the record's own row when shown, else the
// group holding it. -1 when not loaded.
export function rowOf(rows: TraceRow[], seq: number): number {
  let hit = -1;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if (seq >= r.first && seq <= r.last) {
      hit = k;
      if (!r.group) break;
    }
  }
  return hit;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
