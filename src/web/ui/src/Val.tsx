import React from "react";

// Render a value with 0x… addresses clickable (memory viewer entry point).
// `cls` region-tints the address digits so a pointer reads the same color here
// as in the memory view (e.g. a stack pointer is green in both).
export function Val({ text, onAddr, cls }: { text: string; onAddr?: (a: string) => void; cls?: string }) {
  if (!onAddr) return <>{text}</>;
  const parts = text.split(/(0x[0-9a-fA-F]{4,})/g);
  return (
    <>
      {parts.map((p, i) => /^0x[0-9a-fA-F]{4,}$/.test(p)
        ? <span key={i} className={"addr" + (cls ? " " + cls : "")} title="view memory" onClick={(e) => { e.stopPropagation(); onAddr(p); }}>{p}</span>
        : p)}
    </>
  );
}
