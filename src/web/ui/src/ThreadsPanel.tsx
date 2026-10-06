import React from "react";
import type { Thread } from "./session";
import { threadLabel } from "./threadLabel";
import { Panel } from "./Panel";

export function ThreadsPanel({ threads, tlocs, curTid, onSelect, onAddr }: {
  threads: Thread[]; tlocs: Map<number, { label: string; pc: string }>; curTid: number;
  onSelect: (t: Thread) => void; onAddr?: (a: string) => void;
}) {
  if (!threads.length) return null;
  return (
      // One thread has nothing to choose between, so it starts folded to its
      // count; Panel reads the default only on mount, which is each new stop
      // after a run ends (threads empties on terminate).
      <Panel title="Threads" persist="dapweb.threadsCollapsed"
             defaultCollapsed={threads.length === 1} badge={threads.length}>
        {threads.map((t) => {
          const loc = tlocs.get(t.id);
          const tl = threadLabel(t.name, t.id);
          return (
            <div key={t.id} className={"frame" + (t.id === curTid ? " top" : "")}
                 title={tl.tip} onClick={() => onSelect(t)}>
              <span className="tname">{tl.label}</span>
              {loc && <span className="tloc">
                {loc.label}
                {loc.pc && onAddr && (
                  <span className="addr" title="view memory at pc"
                        onClick={(e) => { e.stopPropagation(); onAddr(loc.pc); }}> {loc.pc}</span>
                )}
              </span>}
            </div>
          );
        })}
      </Panel>
  );
}
