import React from "react";
import { Panel } from "./Panel";
import { Val } from "./Val";

export type Watch = { expr: string; value: string | null };

export function WatchPanel({ watches, setWatches, stopped, evalWatch, onAddr }: {
  watches: Watch[]; setWatches: React.Dispatch<React.SetStateAction<Watch[]>>;
  stopped: boolean; evalWatch: (expr: string) => void; onAddr?: (a: string) => void;
}) {
  return (
    <Panel title="Watch" persist="dapweb.watchCollapsed" badge={watches.length || null} action={<button className="addbtn" onClick={() => {
      const expr = prompt("watch expression:");
      if (!expr) return;
      setWatches((w) => [...w, { expr, value: null }]);
      if (stopped) setTimeout(() => evalWatch(expr));
    }}>+</button>}>
      {watches.length
        ? watches.map((w, i) => (
            <div key={i} className="wrow">
              <span className="expr">{w.expr}</span>
              <span className="wval"><Val text={w.value ?? "—"} onAddr={onAddr} /></span>
              <span className="rm" onClick={() => setWatches((x) => x.filter((_, j) => j !== i))}>✕</span>
            </div>
          ))
        : <span className="hint">no expressions: + adds one, evaluated at every stop</span>}
    </Panel>
  );
}
