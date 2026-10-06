import React from "react";

// A right-click menu at the pointer, in the session menu's own styles.
export type CtxItem = { label: string; hint?: string; onClick: () => void };

export function CtxMenu({ x, y, items, onClose }: {
  x: number; y: number; items: CtxItem[]; onClose: () => void;
}) {
  const left = Math.min(x, window.innerWidth - 280);
  const top = Math.min(y, window.innerHeight - 40 * items.length - 16);
  return (
    <>
      <div className="menu-backdrop" onMouseDown={onClose}
           onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="menu-pop ctxmenu" style={{ left, top }}>
        {items.map((it, i) => (
          <button key={i} className="menu-item" onClick={() => { onClose(); it.onClick(); }}>
            {it.label}{it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ))}
      </div>
    </>
  );
}
