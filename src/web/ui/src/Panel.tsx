import React, { useState } from "react";

// `persist` names a localStorage key that remembers the collapsed state across
// reloads; `badge` is a summary shown only while collapsed.
export function Panel({ title, action, children, persist, defaultCollapsed = false, badge }: any) {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    if (!persist) return defaultCollapsed;
    try {
      const v = localStorage.getItem(persist);
      return v === null ? defaultCollapsed : v === "1";
    } catch { return defaultCollapsed; }
  });
  const setCollapsed = (f: (c: boolean) => boolean) => setCollapsedState((c) => {
    const n = f(c);
    if (persist) try { localStorage.setItem(persist, n ? "1" : "0"); } catch {}
    return n;
  });
  return (
    <div className={"panel" + (collapsed ? " collapsed" : "")}>
      {/* The whole heading toggles. A 10px chevron as the only hit target is a
          thing you aim at; the row is a thing you click. */}
      <h2 onClick={() => setCollapsed((c) => !c)} title={collapsed ? "expand" : "collapse"}>
        <span className="panel-toggle">{title}{collapsed && badge != null && <span className="panel-badge">{badge}</span>}</span>
        {action && <span className="panel-act" onClick={(e) => e.stopPropagation()}>{action}</span>}
      </h2>
      {!collapsed && <div className="body">{children}</div>}
    </div>
  );
}
