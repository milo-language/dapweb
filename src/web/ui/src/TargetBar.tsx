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

  // The header holds only a chip; picking a target happens in a dialog wide enough
  // to show whole paths. In the header the field had to share a row with every
  // control and cut off the part of each path that tells entries apart.
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);   // highlighted list row, -1 = the typed text
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    setTargetText(targetLabel);
    setHi(-1);
    setOpen(true);
    if (attachMode) loadProcs();
    setTimeout(() => inputRef.current?.select(), 0);
  };
  const close = () => { setOpen(false); targetFocused.current = false; setTargetText(targetLabel); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPicker(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const q = targetText.trim().toLowerCase();
  const rows: { key: string; value: string; badge?: string; main: string; dim: string }[] = attachMode
    ? (procs || [])
        .filter((pr) => !q || String(pr.pid).startsWith(q) || (pr.cmd || pr.name || "").toLowerCase().includes(q))
        .slice(0, 200)
        .map((pr) => ({ key: "p" + pr.pid, value: String(pr.pid), main: String(pr.pid), dim: pr.cmd || pr.name }))
    : cfgHist
        .map((h) => [h.program || "", ...((h.args as string[]) || [])].join(" ").trim() + "\u0000" + (h.type || ""))
        .map((x) => { const [label, type] = x.split("\u0000"); return { label, type }; })
        .filter(({ label }) => !q || label.toLowerCase().includes(q) || label === targetLabel)
        .map(({ label, type }, i) => {
          const [prog, ...rest] = shellSplit(label);
          const slash = (prog || "").lastIndexOf("/");
          return { key: "h" + i, value: label, badge: type,
                   main: slash >= 0 ? prog.slice(slash + 1) : prog,
                   dim: [(slash >= 0 ? prog.slice(0, slash + 1) : ""), rest.join(" ")].filter(Boolean).join("  ") };
        });

  const pick = (value: string, run: boolean) => {
    applyTarget(value);
    setOpen(false);
    targetFocused.current = false;
    if (run) onEnter();
  };

  const prog = attachMode ? targetLabel : (cfg.program || "");
  const slash = prog.lastIndexOf("/");
  const chipMain = slash >= 0 ? prog.slice(slash + 1) : prog;
  const chipArgs = attachMode ? "" : ((cfg.args as string[]) || []).join(" ");

  return (
    <span className="targetbar">
      <button className={"target-chip" + (attachMode ? " attach" : "")} onClick={openPicker}
              data-tip={(prog ? prog + (chipArgs ? " " + chipArgs : "") + "  ·  " : "") + "change target (⌘K)"}>
        <span className="target-mode">{attachMode ? "attach" : "launch"}</span>
        <span className="target-main">{chipMain || <em>choose a program</em>}</span>
        {chipArgs && <span className="target-args">{chipArgs}</span>}
        <span className="target-caret">▾</span>
      </button>
      {open && (
        <div className="tm-backdrop" onMouseDown={close}>
          <div className="tm" role="dialog" aria-label="Debug target" onMouseDown={(e) => e.stopPropagation()}>
            <div className="tm-top">
              <div className="tm-seg">
                <button className={!attachMode ? "on" : ""} onClick={() => { setMode(false); inputRef.current?.focus(); }}>Launch</button>
                <button className={attachMode ? "on" : ""} onClick={() => { setMode(true); inputRef.current?.focus(); }}>Attach</button>
              </div>
              <span className="tm-adapter">
                {cfg.port ? `tcp ${cfg.host || "127.0.0.1"}:${cfg.port}` : adapterCmd ? `adapter: ${adapterCmd}` : ""}
              </span>
            </div>
            <input ref={inputRef} className="tm-input" value={targetText} spellCheck={false} autoFocus
                   placeholder={attachMode ? "pid, or a process name" : "path to a program, plus arguments"}
                   onFocus={() => { targetFocused.current = true; }}
                   onChange={(e) => { setTargetText(e.target.value); setHi(-1); }}
                   onKeyDown={(e) => {
                     if (e.key === "Escape") { e.preventDefault(); close(); }
                     else if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => Math.min(rows.length - 1, i + 1)); }
                     else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => Math.max(-1, i - 1)); }
                     else if (e.key === "Enter") {
                       e.preventDefault();
                       const v = hi >= 0 && rows[hi] ? rows[hi].value : targetText;
                       if (v.trim()) pick(v, true);
                     }
                   }} />
            <div className="tm-hint">
              <b>Enter</b> runs it · <b>↑↓</b> pick from the list · <b>Esc</b> closes
            </div>
            <div className="tm-list">
              {attachMode && procErr && <div className="tm-note">{procErr}</div>}
              {attachMode && !procs && !procErr && <div className="tm-note">reading the process list…</div>}
              {!attachMode && rows.length === 0 && <div className="tm-note">No recent targets yet. Type a path above.</div>}
              {rows.length > 0 && <div className="tm-section">{attachMode ? "Running processes" : "Recent targets"}</div>}
              {rows.map((r, i) => (
                <div key={r.key} className={"tm-row" + (i === hi ? " hi" : "")}
                     onMouseEnter={() => setHi(i)} onClick={() => pick(r.value, false)}
                     onDoubleClick={() => pick(r.value, true)}>
                  {r.badge && <span className={"hist-type dt-" + r.badge}>{r.badge}</span>}
                  <span className="tm-main">{r.main}</span>
                  <span className="tm-dim">{r.dim}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
