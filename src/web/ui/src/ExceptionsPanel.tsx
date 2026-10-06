import React, { useEffect, useState } from "react";
import { send } from "./rpc";
import { Panel } from "./Panel";

export function ExceptionsPanel({ caps }: { caps: Record<string, any> }) {
  const [excSel, setExcSel] = useState<Set<string>>(new Set());
  const [excInit, setExcInit] = useState(false);
  // Default exception filters on once when capabilities first arrive.
  useEffect(() => {
    const filters = caps.exceptionBreakpointFilters;
    if (!excInit && Array.isArray(filters) && filters.length) {
      const def = new Set<string>(filters.filter((f: any) => f.default).map((f: any) => f.filter));
      setExcSel(def);
      setExcInit(true);
      send({ cmd: "setExceptions", filters: [...def] });
    }
  }, [caps, excInit]);
  const excFilters: any[] = Array.isArray(caps.exceptionBreakpointFilters) ? caps.exceptionBreakpointFilters : [];
  if (!excFilters.length) return null;
  return (
      // lldb-dap offers C++ and Objective-C filters to every program, a C
      // one included, so the list starts folded down to its count.
      <Panel title="Exceptions" persist="dapweb.excCollapsed" defaultCollapsed
             badge={`${excFilters.filter((f: any) => excSel.has(f.filter)).length} on`}>
        {excFilters.map((f: any) => (
          <label key={f.filter} className="excrow">
            <input type="checkbox" checked={excSel.has(f.filter)} onChange={(e) => {
              const next = new Set(excSel);
              e.target.checked ? next.add(f.filter) : next.delete(f.filter);
              setExcSel(next);
              send({ cmd: "setExceptions", filters: [...next] });
            }} /> {f.label || f.filter}
          </label>
        ))}
      </Panel>
  );
}
