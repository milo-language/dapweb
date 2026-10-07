// The Timeline tab of a replay session: the recorded run's trace, one row per
// call the program made to the outside world, each one a place to seek to.
// Traces run to millions of records, so it loads a page at a time as the list
// scrolls and renders only the rows in view.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { TraceRec, TRACE_PAGE, traceRows, rowOf, fmtBytes } from "./traceRows";

const ROW_H = 22;
const OVERSCAN = 12;

export function TraceView({ seekedTo, rewinding, onSeek }: {
  seekedTo: number;   // the record the last seek landed on, 0 = none
  rewinding: boolean;
  onSeek: (record: number) => void;
}) {
  const [recs, setRecs] = useState<TraceRec[]>([]);
  const [total, setTotal] = useState(-1);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(200);
  const loading = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const loadMore = () => {
    if (loading.current || (total >= 0 && recs.length >= total)) return;
    loading.current = true;
    fetch(`/api/trace?offset=${recs.length}&limit=${TRACE_PAGE}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) { setErr(j.error || "cannot read the trace"); return; }
        setTotal(j.total);
        setRecs((held) => (j.offset === held.length ? held.concat(j.records) : held));
        setErr("");
      })
      .catch(() => setErr("could not read the trace from the server"))
      .finally(() => { loading.current = false; });
  };
  useEffect(loadMore, []);

  const rows = useMemo(() => traceRows(recs, expanded), [recs, expanded]);
  const here = seekedTo > 0 ? rowOf(rows, seekedTo) : -1;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Near the end of what is loaded: fetch the next page. Also runs after each
  // page arrives, so a tall panel fills itself.
  useEffect(() => {
    if ((scrollTop + viewH) / ROW_H > rows.length - OVERSCAN * 4) loadMore();
  }, [scrollTop, viewH, rows.length]);
  // A seek past what is loaded (from an agent, or `dapweb api seek`) pages on
  // until its record is in the list.
  useEffect(() => {
    if (seekedTo > (recs.length ? recs[recs.length - 1].seq : 0)) loadMore();
  }, [seekedTo, recs.length]);
  // A seek's record comes into view once, when the seek lands.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || here < 0) return;
    const y = here * ROW_H;
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = Math.max(0, y - el.clientHeight / 3);
  }, [seekedTo, here >= 0]);

  const from = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const to = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const toggle = (first: number) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(first)) n.delete(first); else n.add(first);
    return n;
  });

  return (
    <div className="trace">
      <div className="trace-head">
        <span>{total < 0 ? "reading the trace…" : `${total.toLocaleString()} records`}</span>
        <span className="trace-help">
          every call the recorded run made to the outside world, in order. Jump here re-runs the recording up to that record
          {seekedTo > 0 ? `  ·  last seek: record ${seekedTo}` : ""}
        </span>
      </div>
      {err && <div className="tl-note">{err}</div>}
      <div className="trace-list" ref={boxRef} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(from, to).map((r, k) => {
            const i = from + k;
            return (
              <div key={(r.group ? "g" : "r") + r.first} style={{ top: i * ROW_H, height: ROW_H }}
                   className={"trace-row" + (i === here ? " here" : "") + (r.group ? " group" : "") + (r.sub ? " sub" : "")}>
                <span className="trace-seq">{r.group ? `${r.first}–${r.last}` : r.first}</span>
                <span className="trace-kind">
                  {r.group
                    ? <span className="trace-fold" onClick={() => toggle(r.first)}>
                        {expanded.has(r.first) ? "▾" : "▸"} {r.kind} ×{r.count}
                      </span>
                    : r.kind}
                </span>
                <span className="trace-arg" title={r.arg}>{r.arg}</span>
                <span className="trace-size">{fmtBytes(r.bytes)}</span>
                <span className="trace-preview" title={r.preview}>{r.preview}</span>
                <span className="trace-act">
                  {i === here && <span className="trace-here">◀ last seek</span>}
                  <button disabled={rewinding} onClick={() => onSeek(r.first)}
                          data-tip={`Re-run the recording and stop where record ${r.first} is replayed`}>jump here</button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

