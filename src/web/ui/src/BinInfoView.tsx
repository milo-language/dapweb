import React from "react";

// Binary details for the current target: format, architecture, and above all
// whether it carries debug info. A binary built without -g (or stripped) is the
// most common reason a session runs but shows no source, and nothing else in the
// UI can tell you that.
export function BinInfoView({ info }: { info: any | null }) {
  const rows: [string, string][] = [];
  if (info && info.exists !== false && !info.error) {
    const fmt = [info.format, info.class, info.endian && info.endian + "-endian"].filter(Boolean).join(" · ");
    if (fmt) rows.push(["format", fmt]);
    if (info.arch) rows.push(["arch", info.arch]);
    if (info.fileType) rows.push(["type", info.fileType]);
    if (typeof info.size === "number") rows.push(["size", info.size.toLocaleString() + " bytes"]);
    rows.push(["symbols", info.stripped ? "stripped" : "present"]);
    if (info.dsym) rows.push(["dSYM", info.dsym]);
  }
  return (
    <div className="bininfo">
      {!info && <div className="hint">reading…</div>}
      {info?.error && <div className="cfg-err">{info.error}</div>}
      {info && info.exists === false && (
        <div className="cfg-err">{info.path} does not exist</div>
      )}
      {info && info.exists !== false && !info.error && (
        <>
          <div className="bin-path">{info.path}</div>
          <div className={"bin-dwarf " + (info.hasDebugInfo ? "ok" : "bad")}>
            {info.hasDebugInfo
              ? `debug info: ${info.debugInfo}`
              : "no debug info — you will get no source or locals. Rebuild with -g."}
          </div>
          {rows.map(([k, v]) => (
            <div key={k} className="info-line"><span className="info-k">{k}</span> {v}</div>
          ))}
          {(info.notes || []).map((n: string, i: number) => (
            <div key={i} className="bin-note">{n}</div>
          ))}
        </>
      )}
    </div>
  );
}
