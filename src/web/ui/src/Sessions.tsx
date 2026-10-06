// The /sessions dashboard: every live `dapweb web` on this machine.
//
// One server process is one debug session on one port, so "my sessions" is a
// list of other servers, not a list of things this server owns. It is a page
// rather than a modal for the case that motivates it: you have lost track of
// which port a session is on, so the screen you need is the one you can reach
// without already being in a session.
import React, { useCallback, useEffect, useState } from "react";
import { Mark } from "./Mark";

type Row = {
  id: string; pid: number; port: number;
  program: string; adapter: string; startedAt: number; self: boolean;
};

const clock = (ms: number) =>
  ms > 0 ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

const ago = (ms: number) => {
  if (ms <= 0) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
};

const baseName = (p: string) => p.split("/").filter(Boolean).pop() || p;

// Same host, different port: a session reached over a tunnel or from another
// machine must stay on that hostname, so only the port is swapped.
const urlFor = (port: number) => `${location.protocol}//${location.hostname}:${port}/`;

export default function Sessions() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d) => { setRows(d.sessions || []); setErr(""); })
      .catch((e) => setErr(String(e)));
  }, []);

  // The registry is a directory of files, so nothing pushes at us. A slow poll
  // is enough for a screen whose contents change when a human starts a server.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // A session is a process, so this asks the server to spawn one. The tab is
  // opened here rather than by the new server, which may be on a machine with no
  // browser — and it is opened SYNCHRONOUSLY, before the await, because a
  // window.open that trails a fetch is what a popup blocker exists to stop.
  const newSession = () => {
    if (starting) return;
    setStarting(true);
    const tab = window.open("about:blank", "_blank");
    fetch("/api/spawn", { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) { tab?.close(); setErr(d.error || "could not start a session"); return; }
        if (tab) tab.location.href = urlFor(d.port);
        setTimeout(load, 400);   // it registers itself once it has bound the port
      })
      .catch((e) => { tab?.close(); setErr(String(e)); })
      .finally(() => setStarting(false));
  };

  const n = rows?.length ?? 0;
  return (
    <div className="sessions-page">
      <header>
        <div className="sessions-head">
          <a className="logo" href="/" title="Back to this session"><Mark /><span>dapweb</span></a>
        </div>
      </header>
      <div className="sessions-body">
        <div className="sessions-inner">
          <div className="sessions-top">
            <div>
              <h1 className="sessions-h1">Debug sessions</h1>
              <p className="sessions-sub">
                {rows === null
                  ? "Looking for running sessions…"
                  : n === 0
                    ? "Nothing is running on this machine."
                    : `${n} running on this machine. Each is its own debugger, on its own port.`}
              </p>
            </div>
            <button className="sessions-new" onClick={newSession} disabled={starting}>
              {starting ? "starting…" : <><span className="plus">+</span>New session</>}
            </button>
          </div>
          {err && <div className="sessions-empty">{err}</div>}
          {rows && n === 0 && !err && (
            <div className="sessions-empty">
              Start one with the button above, or from a terminal with <code>dapweb /path/to/binary</code>.
            </div>
          )}
          <div className="session-list">
            {(rows || []).map((r) => (
              <a key={r.id} className={"session-card" + (r.self ? " self" : "")}
                 href={r.self ? "/" : urlFor(r.port)}
                 target={r.self ? undefined : "_blank"} rel="noreferrer"
                 title={`pid ${r.pid}`}>
                <div className="session-line1">
                  <span className="session-dot" />
                  <span className="session-prog">{r.program ? baseName(r.program) : <em>no target yet</em>}</span>
                  {r.self
                    ? <span className="session-here">You're here</span>
                    : <span className="session-open">Open ↗</span>}
                </div>
                <div className="session-name">{r.id}</div>
                {r.program && <div className="session-path">{r.program}</div>}
                <div className="session-meta">
                  {r.adapter && <span className={"hist-type dt-" + r.adapter}>{r.adapter}</span>}
                  <span>port <span className="session-port">{r.port}</span></span>
                  {r.startedAt > 0 && <span>started {clock(r.startedAt)} ({ago(r.startedAt)})</span>}
                </div>
              </a>
            ))}
          </div>
          <div className="sessions-foot">
            The list updates on its own. From a terminal, <code>dapweb api list</code> shows the same sessions.
            {" · "}
            <a href="https://github.com/milo-language/dapweb" target="_blank" rel="noreferrer">
              github.com/milo-language/dapweb
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
