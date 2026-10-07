// The header's target bar: an editable projection of config.program + args (or,
// attaching, the pid), with history and a process picker under it, the debugger
// that will run it, and a one-line summary of the binary.
import React, { useEffect, useRef, useState } from "react";
import type { DebugConfig } from "./configSchema";
import { binSummary, binWarnings, debuggerChoice, dedupeRecent, pidKeyFor } from "./targetInfo";

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

type Adapter = { kind: string; label: string; command: string; installed: boolean; installHint: string };
type Proc = { pid: number; name: string; cmd: string; runtime?: string; type?: string };
type Infer = { program: string; type: string; hostArch: string; binfo: any };

// Move whichever pid spelling the config has to the one `type` reads.
function retype(c: any, type: string | undefined) {
  const pid = c.pid ?? c.processId;
  if (type) c.type = type; else delete c.type;
  if (c.request !== "attach" || pid === undefined) return;
  delete c.pid; delete c.processId;
  c[pidKeyFor(type)] = type === "node" ? String(pid) : Number(pid);
}

export function TargetBar({ cfg, history: cfgHist, readCfg, writeCfg, onEnter }: {
  cfg: DebugConfig; history: DebugConfig[];
  readCfg: () => any; writeCfg: (c: any) => void; onEnter: () => void;
}) {
  const attachMode = cfg.request === "attach";
  const [targetText, setTargetText] = useState("");
  const targetFocused = useRef(false);
  const [procs, setProcs] = useState<Proc[] | null>(null);
  const [procErr, setProcErr] = useState("");
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [inf, setInf] = useState<Infer | null>(null);
  // Auto is a mode of the dialog, not a config value: the server writes the
  // resolved type back into every config, so "no type" never survives a round
  // trip. It starts on unless the config's type disagrees with inference.
  const [auto, setAuto] = useState(true);
  const autoSettled = useRef(false);
  const [customCmd, setCustomCmd] = useState("");
  const targetLabel = attachMode
    ? String(cfg[pidKeyFor(cfg.type)] ?? cfg.pid ?? cfg.processId ?? cfg.program ?? "")
    : [cfg.program || "", ...((cfg.args as string[]) || [])].join(" ").trim();
  useEffect(() => { if (!targetFocused.current) setTargetText(targetLabel); }, [targetLabel]);

  const loadProcs = () => {
    setProcErr("");
    fetch("/api/processes").then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404
        ? "this server cannot list processes (built before /api/processes): type a pid"
        : `server returned ${r.status}`);
      return r.json();
    }).then((d) => setProcs(d.processes || []))
      .catch((e) => { setProcs([]); setProcErr(e.message || String(e)); });
  };

  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);   // highlighted list row, -1 = the typed text
  const inputRef = useRef<HTMLInputElement>(null);

  const recent = dedupeRecent(cfgHist);
  const q = targetText.trim().toLowerCase();
  const rows: { key: string; value: string; badge?: string; main: string; dim: string; type?: string; program?: string }[] = attachMode
    ? (procs || [])
        .filter((pr) => !q || String(pr.pid).startsWith(q) || (pr.cmd || pr.name || "").toLowerCase().includes(q))
        .slice(0, 200)
        .map((pr) => ({ key: "p" + pr.pid, value: String(pr.pid), main: String(pr.pid), dim: pr.cmd || pr.name,
                        badge: pr.runtime && pr.runtime !== "native" ? pr.runtime : undefined, type: pr.type || "lldb" }))
    : recent
        .map((h) => ({ label: [h.program || "", ...((h.args as string[]) || [])].join(" ").trim(), type: h.type || "" }))
        .filter(({ label }) => !q || label.toLowerCase().includes(q) || label === targetLabel)
        .map(({ label, type }, i) => {
          const [prog, ...rest] = shellSplit(label);
          const slash = (prog || "").lastIndexOf("/");
          return { key: "h" + i, value: label, badge: type || undefined, program: prog,
                   main: slash >= 0 ? prog.slice(slash + 1) : prog,
                   dim: [(slash >= 0 ? prog.slice(0, slash + 1) : ""), rest.join(" ")].filter(Boolean).join("  ") };
        });

  // The program inference and the summary are about: the highlighted recent
  // row while moving through the list, else the typed path.
  const probePath = attachMode ? "" : (hi >= 0 && rows[hi]?.program) || shellSplit(targetText)[0] || "";
  useEffect(() => {
    if (!open || attachMode) return;
    if (!probePath) { setInf(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/infer?program=${encodeURIComponent(probePath)}`)
        .then((r) => r.ok ? r.json() : null)
        .then((d: Infer | null) => {
          if (!live || !d) return;
          setInf(d);
          // First answer for the config's own program decides whether its
          // type is an explicit override (Auto off) or just the inference.
          if (!autoSettled.current && d.program === cfg.program) {
            autoSettled.current = true;
            setAuto(debuggerChoice(cfg, d.type) === "auto");
          }
        }).catch(() => {});
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [probePath, open, attachMode]);

  // Attaching, Auto is the runtime of the process being pointed at.
  const pointedProc = attachMode
    ? (hi >= 0 && rows[hi] ? (procs || []).find((p) => String(p.pid) === rows[hi].value)
                           : (procs || []).find((p) => String(p.pid) === targetText.trim()))
    : undefined;
  const inferred = attachMode ? (pointedProc?.type || "lldb") : (inf?.type || "lldb");
  const choice = cfg.dapPath ? "custom" : auto ? "auto" : (cfg.type || "auto");
  const effKind = choice === "auto" ? inferred : choice === "custom" ? (cfg.type || inferred) : choice;
  const effAdapter = adapters.find((a) => a.kind === effKind);

  const openPicker = () => {
    setTargetText(targetLabel);
    setHi(-1);
    setInf(null);
    setCustomCmd(cfg.dapPath || "");
    autoSettled.current = !!cfg.dapPath;
    setAuto(!cfg.dapPath);
    setOpen(true);
    if (attachMode) loadProcs();
    fetch("/api/adapters").then((r) => r.ok ? r.json() : { adapters: [] })
      .then((d) => setAdapters(d.adapters || [])).catch(() => setAdapters([]));
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

  // `rowType` is the runtime of a picked process row, which in Auto decides
  // the debugger for an attach.
  const applyTarget = (text: string, rowType?: string) => {
    const c = readCfg();
    if (attachMode) {
      const t = text.trim();
      if (!t) return;
      delete c.pid; delete c.processId;
      if (/^[0-9]+$/.test(t)) {
        const type = auto && !c.dapPath
          ? (rowType || (procs || []).find((p) => String(p.pid) === t)?.type || "lldb")
          : c.type;
        c.pid = Number(t);
        retype(c, type);
      } else {
        c.program = t;   // lldb attaches to a running process by name
      }
      writeCfg(c);
      return;
    }
    const parts = shellSplit(text);
    if (!parts.length) return;
    c.program = parts[0];
    if (parts.length > 1) c.args = parts.slice(1); else delete c.args;
    // Auto: leave the type to the server, which runs the same inference
    // /api/infer reported, so what the dialog showed is what runs.
    if (auto && !c.dapPath) delete c.type;
    writeCfg(c);
  };

  const setMode = (attach: boolean) => {
    const c = readCfg();
    if (attach) { c.request = "attach"; delete c.args; }
    else { delete c.request; delete c.pid; delete c.processId; }
    // An Auto type was the inference for the other mode's target (a python
    // process, say) and says nothing about this one.
    if (auto && !c.dapPath) delete c.type;
    writeCfg(c);
    setTargetText("");
    setHi(-1);
    if (attach) { setProcs(null); loadProcs(); }
    else { setProcs(null); setProcErr(""); }
  };

  const chooseDebugger = (v: string) => {
    const c = readCfg();
    if (v === "custom") {
      setAuto(false);
      if (customCmd.trim()) { c.dapPath = customCmd.trim(); writeCfg(c); }
      else { setCustomCmd(c.dapPath || ""); }
      return;
    }
    delete c.dapPath;
    setCustomCmd("");
    if (v === "auto") {
      setAuto(true);
      retype(c, attachMode ? inferred : undefined);
    } else {
      setAuto(false);
      retype(c, v);
    }
    writeCfg(c);
  };

  const pick = (i: number, run: boolean) => {
    const r = rows[i];
    if (!r) return;
    applyTarget(r.value, attachMode ? r.type : undefined);
    setOpen(false);
    targetFocused.current = false;
    if (run) onEnter();
  };

  const prog = attachMode ? targetLabel : (cfg.program || "");
  const slash = prog.lastIndexOf("/");
  const chipMain = slash >= 0 ? prog.slice(slash + 1) : prog;
  const chipArgs = attachMode ? "" : ((cfg.args as string[]) || []).join(" ");
  const replay = attachMode ? "" : ((cfg as any).replay as string) || "";

  const summary = attachMode ? "" : binSummary(inf?.binfo);
  const warns = attachMode || !inf || !probePath ? [] : binWarnings(inf.binfo, inf.hostArch, effKind);
  const kindLabel = (k: string) => adapters.find((a) => a.kind === k)?.label || k;

  return (
    <span className="targetbar">
      {/* A replay session says so where the mode is named: it is a mode of the
          launch (the program runs on a recording), and the header has no width
          to spare for a chip of its own. */}
      <button className={"target-chip" + (attachMode ? " attach" : "") + (replay ? " replay" : "")} onClick={openPicker}
              data-tip={(replay ? `replaying the recording ${replay}: every run is the same run, so you can step backwards  ·  ` : "")
                + (prog ? prog + (chipArgs ? " " + chipArgs : "") + "  ·  " : "") + "change target (⌘K)"}>
        <span className="target-mode">{attachMode ? "attach" : replay ? "replay" : "launch"}</span>
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
              {cfg.port
                ? <span className="tm-adapter">tcp {cfg.host || "127.0.0.1"}:{cfg.port}</span>
                : (
                <label className="tm-dbg">
                  <span>Debugger</span>
                  <select value={choice} onChange={(e) => chooseDebugger(e.target.value)} aria-label="Debugger">
                    <option value="auto">Auto ({inferred})</option>
                    {adapters.map((a) => (
                      <option key={a.kind} value={a.kind}>{a.label}{a.installed ? "" : ", not installed"}</option>
                    ))}
                    <option value="custom">Custom command…</option>
                  </select>
                </label>
              )}
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
                       if (hi >= 0 && rows[hi]) pick(hi, true);
                       else if (targetText.trim()) {
                         applyTarget(targetText);
                         setOpen(false); targetFocused.current = false; onEnter();
                       }
                     }
                   }} />
            {choice === "custom" && (
              <input className="tm-input tm-custom" value={customCmd} spellCheck={false}
                     placeholder="adapter command, e.g. /opt/llvm/bin/lldb-dap"
                     onChange={(e) => setCustomCmd(e.target.value)}
                     onBlur={() => { const c = readCfg(); if (customCmd.trim() && c.dapPath !== customCmd.trim()) { c.dapPath = customCmd.trim(); writeCfg(c); } }}
                     onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
            )}
            {(summary || warns.length > 0 || (choice !== "custom" && effAdapter && !effAdapter.installed)) && (
              <div className="tm-bin">
                {summary && <div className="tm-sum">{summary}{choice === "auto" ? "" : ` · debugger: ${kindLabel(effKind)}`}</div>}
                {choice !== "custom" && effAdapter && !effAdapter.installed && (
                  <div className="tm-warn">{effAdapter.label} is not installed: {effAdapter.installHint}</div>
                )}
                {warns.map((w, i) => <div key={i} className={w.level === "warn" ? "tm-warn" : "tm-info"}>{w.text}</div>)}
              </div>
            )}
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
                     onMouseEnter={() => setHi(i)} onClick={() => pick(i, false)}
                     onDoubleClick={() => pick(i, true)}>
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
