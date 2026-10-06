import React, { useMemo } from "react";
import type { BpMeta } from "./SourceView";
import { base, bpKey } from "./session";

// All breakpoints across files with their condition/hit/log meta.
// Hover a row → ✎ opens the same condition/hit/logpoint editor as the gutter.
export function BpList({ bps, files, onJump, onRemove, onToggle, onEdit }: {
  bps: Map<string, BpMeta>;
  files: Map<string, string>;
  onJump: (path: string, ln: number) => void;
  onRemove: (path: string, ln: number) => void;
  onToggle: (path: string, ln: number, meta: BpMeta) => void;
  onEdit: (path: string, ln: number, x: number, y: number) => void;
}) {
  const rows = [...bps.entries()].map(([k, m]) => {
    const i = k.indexOf("\n");
    return { path: k.slice(0, i), line: Number(k.slice(i + 1)), meta: m };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const lines = useMemo(() => new Map<string, string[]>(), [files]);
  const srcLine = (path: string, line: number) => {
    const text = files.get(path);
    if (text === undefined) return "";
    let ls = lines.get(path);
    if (!ls) { ls = text.split("\n"); lines.set(path, ls); }
    return (ls[line - 1] ?? "").trim();
  };
  if (!rows.length) return <span className="hint">none — click the gutter, or right-click / ✎ for conditions & logpoints</span>;
  return (
    <>
      {rows.map(({ path, line, meta }) => {
        const kind = meta.logMessage ? "log" : (meta.condition || meta.hitCondition) ? "cond" : "";
        const detail = meta.logMessage
          ? `log: ${meta.logMessage}`
          : [meta.condition, meta.hitCondition && `hits ${meta.hitCondition}`].filter(Boolean).join(" · ");
        return (
          <div key={bpKey(path, line)} className={"bprow" + (meta.enabled === false ? " off" : "")}
               title={path} onClick={() => onJump(path, line)}>
            <span className={"bpdot " + kind} title={meta.enabled === false ? "enable" : "disable"}
                  onClick={(e) => { e.stopPropagation(); onToggle(path, line, meta); }} />
            <span className="bpline">{base(path)}:{line}</span>
            {(() => { const t = srcLine(path, line); return t && <span className="bpsrc" title={t}>{t}</span>; })()}
            {detail && <span className="bpdetail" title={detail}>{detail}</span>}
            <span className="bpedit" title="edit condition / hit count / logpoint"
                  onClick={(e) => { e.stopPropagation(); onEdit(path, line, e.clientX, e.clientY); }}>✎</span>
            <span className="rm" title="remove"
                  onClick={(e) => { e.stopPropagation(); onRemove(path, line); }}>✕</span>
          </div>
        );
      })}
    </>
  );
}
