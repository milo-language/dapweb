// Resize handles: the bottom panel's height and the aside's width.
import React from "react";

export function DragBar({ onResize }: { onResize: (h: number) => void }) {
  return (
    <div className="dragbar" onMouseDown={() => {
      const move = (e: MouseEvent) =>
        onResize(Math.max(80, Math.min(window.innerHeight - 140, window.innerHeight - e.clientY)));
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    }} />
  );
}

export function AsideDrag({ onResize }: { onResize: (w: number) => void }) {
  return (
    <div className="aside-drag" onMouseDown={() => {
      const move = (e: MouseEvent) =>
        onResize(Math.max(200, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX)));
      const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    }} />
  );
}
