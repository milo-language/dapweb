// The header's "session" menu, and the adapter/capabilities popover it opens.
import React, { useState } from "react";
import { send } from "./rpc";

export function SessionMenu({ caps, dbgLabel, adapterCmd, sessionId, live, onConfigure }: {
  caps: Record<string, any>; dbgLabel: string; adapterCmd: string; sessionId: string;
  live: boolean; onConfigure: () => void;
}) {
  const [showInfo, setShowInfo] = useState(false);    // adapter + capabilities popover
  const [showMenu, setShowMenu] = useState(false);
  return (
    <>
      <span className="menu-wrap">
        <button className="menu-btn" onClick={() => setShowMenu((v) => !v)}>
          session <span className="menu-caret">▾</span>
        </button>
        {showMenu && (
          <>
            <div className="menu-backdrop" onClick={() => setShowMenu(false)} />
            <div className="menu-pop">
              <button className="menu-item" onClick={() => { setShowMenu(false); onConfigure(); }}>
                Configure target… <span className="menu-hint">launch.json</span>
              </button>
              <button className="menu-item" onClick={() => { setShowMenu(false); setShowInfo(true); }}
                      disabled={Object.keys(caps).length === 0}>
                Session info <span className="menu-hint">{dbgLabel || "—"}</span>
              </button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => {
                setShowMenu(false);
                if (live && !confirm("End the current debug session and start a new one?")) return;
                send({ cmd: "newSession" });
              }}>New session <span className="menu-hint">keeps the target</span></button>
              <a className="menu-item" href="/sessions" onClick={() => setShowMenu(false)}>
                All sessions… <span className="menu-hint">every live server</span>
              </a>
            </div>
          </>
        )}
      </span>
      {showInfo && (
        <>
          <div className="menu-backdrop" onClick={() => setShowInfo(false)} />
          <div className="info-pop">
            <div className="info-line"><span className="info-k">adapter</span> {dbgLabel}{adapterCmd ? ` — ${adapterCmd}` : ""}</div>
            <div className="info-line"><span className="info-k">session</span> {sessionId || "—"}</div>
            <details>
              <summary>capabilities</summary>
              <div className="caps-list">
                {Object.keys(caps).filter((k) => caps[k] === true).sort()
                  .map((k) => <span key={k} className="cap">{k.replace(/^supports/, "")}</span>)}
              </div>
            </details>
          </div>
        </>
      )}
    </>
  );
}
