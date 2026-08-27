// Debug-target config drawer: ONE VS Code launch-configuration object, shown two
// ways. The JSON text is the single source of truth either way — App reads its
// live text on Run (no auto-apply, no staging, no autoformat), the server only
// overwrites it on initial load and history-entry click, and typing in the JSON
// tab is never reformatted or clobbered.
//
// Two tabs, not two editors. A launch.json is a schema nobody should have to
// learn to press Run, but it is also the thing that actually goes to the
// adapter, and hiding it behind a form teaches nothing and blocks every key the
// form does not know. So the Form tab writes into the same text the JSON tab
// shows: change a field, switch tabs, and the edit is sitting there. The fields
// come from the SAME schema that drives Monaco's autocomplete, so there is no
// second list of keys to drift.
//
// A template picker seeds a starter config; history is server-owned.
import React, { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// NB: this ESM build EXPORTS jsonDefaults — it does not attach languages.json,
// so `monaco.languages.json?.jsonDefaults` is silently undefined. Import it.
import { jsonDefaults } from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import {
  SCHEMA, stripJsonc, fieldsFor, unknownKeys, histTarget,
  linesOf, toLines, envOf, toEnv,
} from "./configSchema";
import type { DebugConfig, Field } from "./configSchema";
export type { DebugConfig } from "./configSchema";
export { stripJsonc } from "./configSchema";

// The config dialect is JSONC, exactly like VS Code's launch.json: comments and
// trailing commas are fine. Templates lean on that — optional keys ship
// commented out, uncomment what you need. stripJsonc() cleans the text before
// it's parsed/sent; the server is equally lenient (jsonParseJsonc).
jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: true,
  comments: "ignore",         // severity keys — allowComments alone still flags them
  trailingCommas: "ignore",
  schemas: [{ uri: "dapweb://launch-config", fileMatch: ["*"], schema: SCHEMA }],
});

// One template per debugger — minimal active keys, common options commented
// out. Uncomment a line instead of hunting a flat launch×attach×type menu.
const TEMPLATES: { label: string; text: string }[] = [
  {
    label: "C / C++ / Rust (lldb)",
    text: `{
  "type": "lldb",
  "program": "/path/to/program",
  "args": [],
  // "stopAtMain": true,
  // "env": { "KEY": "value" },
  // "cwd": "/working/dir",
  // attach to a running process instead:
  // "request": "attach",
  // "pid": 1234,
  // lldb hooks:
  // "initCommands": ["settings set target.x86-disassembly-flavor intel"],
}`,
  },
  {
    label: "Python (debugpy)",
    text: `{
  "type": "python",
  "program": "/path/to/script.py",
  "args": [],
  // "python": "/usr/bin/python3",
  // "justMyCode": false,
  // "env": { "KEY": "value" },
  // attach to a running process instead:
  // "request": "attach",
  // "processId": 1234,
}`,
  },
  {
    label: "Go (delve)",
    text: `{
  "type": "go",
  "program": "/path/to/main.go",
  "args": [],
  // "mode": "debug",           // debug | exec | test
  // attach to a running process instead:
  // "request": "attach",
  // "processId": 1234,
}`,
  },
  {
    label: "Connect over TCP",
    text: `{
  // connect to an already-running DAP adapter, e.g. \`dlv dap --listen=:4711\`
  "type": "go",
  "request": "attach",
  "host": "127.0.0.1",
  "port": 4711,
}`,
  },
];

type Field = { key: string; schema: any };

// Which keys make sense for launch vs attach. The schema branches on `type`
// only, because that is all a JSON validator can usefully say — "args is
// meaningless when attaching" is a UI judgement, not a validity one, and a
// config carrying both still passes and still runs.
const ATTACH_ONLY = new Set(["pid", "processId", "connect", "waitFor", "attachCommands"]);
const LAUNCH_ONLY = new Set(["args", "cwd", "console", "mode", "buildFlags", "module",
                             "runtimeExecutable", "runtimeArgs", "launchCommands", "stopOnEntry"]);

// The handful worth seeing before anything else: what to debug, and how to
// name it. Everything else lands under Advanced, because a form that opens with
// thirty inputs is the sidebar we are trying to stop shipping.
const PRIMARY = ["type", "request", "program", "pid", "processId", "args", "source", "name", "stopAtMain"];

function branchProps(type: string | undefined): Record<string, any> {
  for (const b of SCHEMA.allOf as any[]) {
    if (b.if?.properties?.type?.const === type) return b.then?.properties ?? {};
  }
  return {};
}

function fieldsFor(cfg: DebugConfig): { primary: Field[]; advanced: Field[] } {
  const all: Record<string, any> = { ...COMMON, ...branchProps(cfg.type) };
  const attach = cfg.request === "attach";
  const keep = Object.keys(all).filter((k) => (attach ? !LAUNCH_ONLY.has(k) : !ATTACH_ONLY.has(k)));
  const primary: Field[] = [];
  for (const k of PRIMARY) if (keep.includes(k)) primary.push({ key: k, schema: all[k] });
  const seen = new Set(primary.map((f) => f.key));
  const advanced = keep.filter((k) => !seen.has(k)).sort().map((k) => ({ key: k, schema: all[k] }));
  return { primary, advanced };
}

// Keys the user wrote that the schema has never heard of. They are valid and go
// to the adapter verbatim (additionalProperties stays true), so the form has to
// admit they exist — silently not rendering them is how a form convinces someone
// their config is smaller than it is.
function unknownKeys(cfg: DebugConfig): string[] {
  const known = new Set([...Object.keys(COMMON), ...Object.keys(branchProps(cfg.type)), "lastRunAt"]);
  return Object.keys(cfg).filter((k) => !known.has(k));
}

// An array of strings edits as one entry per line: `args` is almost always a
// short list, and a line is the shape people already have in their shell history.
const linesOf = (v: any): string => Array.isArray(v) ? v.join("\n") : "";
const toLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
// env edits as KEY=value per line, for the same reason.
const envOf = (v: any): string =>
  v && typeof v === "object" ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n") : "";
const toEnv = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of toLines(s)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
};

export default function ConfigDrawer({ config, sessionActive, error, history, onChange, onRun, onClose }: {
  config: DebugConfig; sessionActive: boolean; error: string;
  history: DebugConfig[];
  onChange: (text: string) => void;   // fires on every edit — App keeps the live text
  onRun: () => void;                  // ▶ Run (drawer mirrors the toolbar button)
  onClose: () => void;
}) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [parseErr, setParseErr] = useState("");
  const [tplOpen, setTplOpen] = useState(false);
  const [tab, setTab] = useState<"form" | "json">("form");
  // The text both tabs edit. Monaco owns the DOM for it, but Monaco is only
  // mounted on the JSON tab, so the form cannot read it out of the editor —
  // this mirror is what survives the tab switch in either direction.
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const textRef = useRef(text); textRef.current = text;
  // Set while we push a server-originated config into the editor, so the change
  // event doesn't echo it straight back to App as a "user edit".
  const syncingRef = useRef(false);
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  // One writer for the config text, whichever tab is showing. Monaco may not be
  // mounted (form tab), so the editor update is best-effort and the mirror is not.
  const setValue = (v: string) => {
    setText(v);
    textRef.current = v;
    validate(v);
    const ed = edRef.current;
    if (ed && ed.getValue() !== v) {
      syncingRef.current = true;
      ed.setValue(v);
      syncingRef.current = false;
    }
    onChangeRef.current(v);   // keep App's live text in sync
  };

  const validate = (text: string) => {
    try { JSON.parse(stripJsonc(text)); setParseErr(""); }
    catch (e: any) { setParseErr(`invalid JSON: ${e.message}`); }
  };

  // Re-created whenever the JSON tab comes back: Monaco cannot outlive the div
  // it was given, and the div only exists while that tab is showing.
  useEffect(() => {
    if (tab !== "json" || !elRef.current) return;
    const ed = monaco.editor.create(elRef.current!, {
      value: textRef.current,
      language: "json",
      theme: "vs-dark",
      minimap: { enabled: false },
      fontSize: 12,
      lineNumbers: "off",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      folding: false,
    });
    edRef.current = ed;
    (window as any).__dapwebConfigEditor = ed;  // test hook (browser_repro2)
    onChangeRef.current(ed.getValue());
    const sub = ed.onDidChangeModelContent(() => {
      const v = ed.getValue();
      validate(v);
      if (syncingRef.current) return;
      // A genuine user edit. Straight to the mirror, NOT through setValue: that
      // would call ed.setValue() on the editor being typed in and move the caret.
      setText(v);
      textRef.current = v;
      onChangeRef.current(v);
    });
    return () => { sub.dispose(); ed.dispose(); edRef.current = null; };
  }, [tab]);

  // Keep the editor in sync with the server's canonical config (initial load,
  // another peer changing the target) — but never while the user is typing in
  // it, and never when the editor already SAYS the same thing: the canonical
  // echo after your own Run must not eat your comments and formatting.
  const sortDeep = (o: any): any =>
    Array.isArray(o) ? o.map(sortDeep)
    : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]))
    : o;
  const canon = (o: any): string => JSON.stringify(sortDeep(o));
  const cfgJson = JSON.stringify(config, null, 2);
  useEffect(() => {
    const ed = edRef.current;
    if (ed && ed.hasTextFocus()) return;   // never while the user is typing in it
    if (textRef.current === cfgJson) return;
    try { if (canon(JSON.parse(stripJsonc(textRef.current))) === canon(config)) return; } catch {}
    setValue(cfgJson);
  }, [cfgJson]);

  // Load a history entry into the editor, dropping the server-only lastRunAt stamp.
  const load = (c: DebugConfig) => {
    const { lastRunAt, ...cfg } = c as any;
    setValue(JSON.stringify(cfg, null, 2));
  };

  return (
    <div className="drawer">
      <div className="drawer-head">
        <h2>Debug Target</h2>
        {/* codicon chevron-left — the ttf ships with monaco (see App.tsx CI table) */}
        <button className="drawer-hide" title="Hide panel" onClick={onClose}>
          <span className="ci">{String.fromCodePoint(0xeab5)}</span>
        </button>
      </div>
      <div className="drawer-actions">
        <div className="tpl">
          <button className="tpl-btn" onClick={() => setTplOpen((v) => !v)}>New config ▾</button>
          {tplOpen && (
            <div className="tpl-menu" onMouseLeave={() => setTplOpen(false)}>
              {TEMPLATES.map((t) => (
                <div key={t.label} className="tpl-item"
                     onClick={() => { setValue(t.text); setTplOpen(false); }}>{t.label}</div>
              ))}
            </div>
          )}
        </div>
        <button className="run-cfg" onClick={onRun} title="Run this config">▶ Run</button>
      </div>
      {/* Two views of one config. The point of showing both is the relationship:
          set a field, switch, and the JSON that goes to the adapter is right
          there with the change in it. */}
      <div className="cfg-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "form"} className={tab === "form" ? "on" : ""}
                onClick={() => setTab("form")}>Form</button>
        <button role="tab" aria-selected={tab === "json"} className={tab === "json" ? "on" : ""}
                onClick={() => setTab("json")}>JSON</button>
      </div>
      {tab === "json"
        ? <div className="drawer-editor" ref={elRef} />
        : <div className="drawer-editor drawer-form"><FormView text={text} setText={setValue} /></div>}
      {sessionActive
        ? <div className="cfg-note">a session is active — Run will ask to kill it and relaunch</div>
        : <div className="cfg-note">edit the config, then Run ▶ to launch</div>}
      {(parseErr || error) && <div className="cfg-err">{parseErr || error}</div>}
      <div className="drawer-hist">
        <h2>History</h2>
        {history.length
          ? history.map((h, i) => (
              <div key={i} className="hist-row" onClick={() => load(h)} title={h.dapPath || h.type || ""}>
                <span className="hist-prog">
                  {h.type && <span className={"hist-type dt-" + h.type}>{h.type}</span>}
                  {h.name ? <span className="hist-name">{h.name}</span> : null}
                  {histTarget(h)}
                </span>
                {h.source && <span className="hist-src">{h.source}</span>}
              </div>
            ))
          : <span className="hint">no previous targets</span>}
      </div>
    </div>
  );
}
