// The header's target bar: an editable projection of config.program + args (or,
// attaching, the pid), with history and a process picker under it.
import React, { useEffect, useRef, useState } from "react";
import type { DebugConfig } from "./configSchema";

// Split a target bar's text into argv the way a shell would for the cases that
// actually come up here: quoted paths and quoted arguments. Not a shell parser
// (no expansion, no escapes beyond the quote pair) and deliberately so, since
// anything more elaborate belongs in the launch config's own "args" array.
function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "", q = "";
  for (const ch of s.trim()) {
    if (q) { if (ch === q) q = ""; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === " " || ch === "\t") { if (cur) { out.push(cur); cur = ""; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function TargetBar({ cfg, history: cfgHist, adapterCmd, readCfg, writeCfg, onEnter }: {
  cfg: DebugConfig; history: DebugConfig[]; adapterCmd: string;
  readCfg: () => any; writeCfg: (c: any) => void; onEnter: () => void;
}) {
  const attachMode = cfg.request === "attach";
  const [targetText, setTargetText] = useState("");
  const [targetOpen, setTargetOpen] = useState(false);
  const targetFocused = useRef(false);
  const [procs, setProcs] = useState<{ pid: number; name: string; cmd: string }[] | null>(null);
  const [procErr, setProcErr] = useState("");
  // lldb spells it `pid`, debugpy and delve spell it `processId`. The UI writes
  // the dialect's own key rather than having the server translate, because the
  // config is meant to be a verbatim launch.json: what you read in the sheet has
  // to be exactly what goes to the adapter.
  const pidKeyFor = (t?: string) => (t === "python" || t === "go" || t === "node") ? "processId" : "pid";
  const targetLabel = attachMode
    ? String(cfg[pidKeyFor(cfg.type)] ?? cfg.program ?? "")
    : [cfg.program || "", ...((cfg.args as string[]) || [])].join(" ").trim();
  useEffect(() => { if (!targetFocused.current) setTargetText(targetLabel); }, [targetLabel]);

  const applyTarget = (text: string) => {
    const c = readCfg();
    if (attachMode) {
      const t = text.trim();
      if (!t) return;
      // Drop every spelling first: switching `type` must not leave a stale pid
      // key behind for the adapter to trip over.
      delete c.pid; delete c.processId;
      if (/^[0-9]+$/.test(t)) c[pidKeyFor(c.type)] = Number(t);
      else c.program = t;   // lldb attaches to a running process by name
      writeCfg(c);
      return;
    }
    const parts = shellSplit(text);
    if (!parts.length) return;
    c.program = parts[0];
    if (parts.length > 1) c.args = parts.slice(1); else delete c.args;
    writeCfg(c);
  };

  const setMode = (attach: boolean) => {
    const c = readCfg();
    if (attach) { c.request = "attach"; delete c.args; }
    else { delete c.request; delete c.pid; delete c.processId; }
    writeCfg(c);
    setTargetText("");
    // The chip preventDefaults mousedown so the input keeps focus, which means
    // focus never fires again and the picker would sit on its placeholder
    // forever. Kick the load from here instead of relying on onFocus.
    if (attach) { setProcs(null); loadProcs(); setTargetOpen(true); }
    else { setProcs(null); setProcErr(""); setTargetOpen(false); }
  };

  const loadProcs = () => {
    setProcErr("");
    fetch("/api/processes").then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404
        ? "this server cannot list processes (built before /api/processes) — type a pid"
        : `server returned ${r.status}`);
      return r.json();
    }).then((d) => setProcs(d.processes || []))
      .catch((e) => { setProcs([]); setProcErr(e.message || String(e)); });
  };

  return (
    <span className="targetbar">
      <select className={"mode-select" + (attachMode ? " attach" : "")} value={cfg.request || "launch"}
              data-tip={attachMode ? "Attaching to a process that is already running"
                                : "Launching a program from a path"}
              onChange={(e) => setMode(e.target.value === "attach")}>
        <option value="launch">launch</option>
        <option value="attach">attach</option>
      </select>
      <input className="target-input" value={targetText} spellCheck={false}
             placeholder={attachMode ? "pid, or a process name" : "path to a program, plus arguments"}
             data-tip={cfg.port ? `tcp: ${cfg.host || "127.0.0.1"}:${cfg.port}` : (adapterCmd ? `adapter: ${adapterCmd}` : "")}
             onChange={(e) => setTargetText(e.target.value)}
             onFocus={() => { targetFocused.current = true; setTargetOpen(true); if (attachMode) loadProcs(); }}
             onBlur={() => { targetFocused.current = false; setTimeout(() => setTargetOpen(false), 120); }}
             onKeyDown={(e) => {
               if (e.key === "Enter") {
                 applyTarget(targetText); setTargetOpen(false);
                 (e.target as HTMLInputElement).blur();
                 onEnter();
               } else if (e.key === "Escape") {
                 setTargetText(targetLabel); (e.target as HTMLInputElement).blur();
               }
             }} />
      {targetOpen && attachMode && (
        <div className="target-menu">
          {procErr && <div className="target-note">{procErr}</div>}
          {!procs && !procErr && <div className="target-note">reading process list…</div>}
          {(procs || [])
            .filter((pr) => !targetText.trim() ||
                            String(pr.pid).startsWith(targetText.trim()) ||
                            (pr.cmd || pr.name || "").toLowerCase().includes(targetText.trim().toLowerCase()))
            .slice(0, 200)
            .map((pr) => (
              <div key={pr.pid} className="target-item"
                   onMouseDown={(e) => { e.preventDefault(); setTargetText(String(pr.pid)); applyTarget(String(pr.pid)); setTargetOpen(false); }}>
                <span className="proc-pid">{pr.pid}</span>{pr.cmd || pr.name}
              </div>
            ))}
        </div>
      )}
      {targetOpen && !attachMode && cfgHist.length > 0 && (
        <div className="target-menu">
          {cfgHist.map((h, i) => {
            const label = [h.program || "", ...((h.args as string[]) || [])].join(" ").trim();
            return (
              <div key={i} className="target-item"
                   onMouseDown={(e) => { e.preventDefault(); setTargetText(label); applyTarget(label); setTargetOpen(false); }}>
                {h.type && <span className={"hist-type dt-" + h.type}>{h.type}</span>}{label}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
