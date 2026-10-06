// The Timeline tab: this session's recorded stops, newest first, read back from
// the journal. Read-only replay: a past stop's frames and locals are what was
// broadcast at the time; nothing here talks to the debugger.
import React, { useEffect, useRef, useState } from "react";
import { base, hasSrc } from "./session";
import { RecordedStop, parseStopRows, mergeStops, timelineQuery } from "./recordedStops";

const hhmmss = (ms: number) => new Date(ms).toTimeString().slice(0, 8);
const where = (s: { path: string; line: number }) => (hasSrc(s.path) ? `${base(s.path)}:${s.line}` : s.path || "?");

export function Timeline({ sessionId, stopSeq, openFile }: {
  sessionId: string;
  stopSeq: number;  // bumped per live stop: the cue to fetch what was just recorded
  openFile: (path: string, line?: number) => void;
}) {
  const [stops, setStops] = useState<RecordedStop[]>([]);
  const [sel, setSel] = useState<number | null>(null);  // seq
  const [err, setErr] = useState("");
  const lastSeq = useRef(0);
  const sidRef = useRef("");

  // One fetch path for both the first load and each live stop: everything after
  // the newest row held. The journal row is written before the broadcast goes
  // out, so by the time this tab has seen a stop its row is there.
  useEffect(() => {
    if (!sessionId) return;
    if (sidRef.current !== sessionId) {
      sidRef.current = sessionId;
      lastSeq.current = 0;
      setStops([]); setSel(null);
    }
    let live = true;
    fetch(timelineQuery(lastSeq.current))
      .then((r) => r.json())
      .then((j) => {
        if (!live || sidRef.current !== sessionId) return;
        const fresh = parseStopRows(j.rows || []);
        if (fresh.length) lastSeq.current = Math.max(lastSeq.current, fresh[0].seq);
        setStops((held) => mergeStops(held, fresh));
        setErr("");
      })
      .catch(() => live && setErr("could not read the journal from the server"));
    return () => { live = false; };
  }, [sessionId, stopSeq]);

  const cur = stops.find((s) => s.seq === sel) ?? null;
  return (
    <div className="timeline">
      <div className="tl-list">
        {err && <div className="tl-note">{err}</div>}
        {!err && stops.length === 0 && (
          <div className="tl-note">No stops recorded in this session yet. Each stop is read back from the journal (off with --no-journal).</div>
        )}
        {stops.map((s) => (
          <div key={s.seq} className={"tl-row" + (s.by === "agent" ? " agent" : "") + (s.seq === sel ? " sel" : "")}
               onClick={() => setSel(s.seq)} data-tip={s.who ? `caused by ${s.who}` : undefined}>
            <span className="tl-time">{hhmmss(s.at)}</span>
            <span className="tl-reason">{s.atMain ? "main" : s.reason || "stop"}</span>
            <span className="tl-where">{where(s)}</span>
            <span className="tl-who">{s.by === "agent" ? `◆ ${s.who || "agent"}` : "you"}</span>
          </div>
        ))}
      </div>
      <div className="tl-detail">
        {!cur && stops.length > 0 && <div className="tl-note">Click a stop to see its recorded frames and locals.</div>}
        {cur && (
          <>
            <div className="tl-head">
              {hhmmss(cur.at)} · {cur.atMain ? "stop at main" : cur.reason || "stop"} ·{" "}
              <span className="tl-link" onClick={() => hasSrc(cur.path) && openFile(cur.path, cur.line)}>{where(cur)}</span>
              {" "}· <span className={cur.by === "agent" ? "tl-by-agent" : ""}>{cur.by === "agent" ? `by ${cur.who || "an agent"}` : "by you"}</span>
              <span className="tl-ro">recorded, read-only</span>
            </div>
            {cur.frames === null ? (
              <div className="tl-note">This stop's frames and locals were not recorded whole (the journal row was cut at its size cap), so there is nothing to replay.</div>
            ) : (
              <>
                <div className="tl-sec">Frames</div>
                {cur.frames.map((f, i) => (
                  <div key={i} className="tl-frame">
                    <span className="tl-fname">{f.name}</span>
                    <span className="tl-floc">{hasSrc(f.path) ? `${base(f.path)}:${f.line}` : ""}</span>
                  </div>
                ))}
                <div className="tl-sec">Locals (top frame)</div>
                {cur.locals === null
                  ? <div className="tl-note">Locals were not recorded for this stop: frames only.</div>
                  : cur.locals.length === 0
                    ? <div className="tl-note">none</div>
                    : cur.locals.map((v, i) => (
                      <div key={i} className="tl-var">
                        <span className="tl-vname">{v.name}</span> = <span className="tl-vval">{v.value}</span>
                      </div>
                    ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
