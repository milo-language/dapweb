import React, { useEffect, useState } from "react";
import type { Var } from "./session";
import { request } from "./rpc";
import { Val } from "./Val";
import { CtxMenu } from "./CtxMenu";

// Python adapters (debugpy) return an object's dunder members behind synthetic
// group rows — "special variables", "function variables", "class variables" —
// and those rows come back FIRST, ahead of the attributes the object is actually
// about. Nobody hovering `self` is asking about __delattr__, so they sort last
// in a tree (where they are still one click away) and are dropped entirely from
// a hover (which has room for sixteen rows total).
export const isSpecialVar = (name: string) =>
  /^(special|function|class|protected|private|static) variables$/i.test(name) ||
  /^__.*__$/.test(name);

// Stable: real fields keep the adapter's order, and so do the special ones.
const realFirst = <T extends { name: string }>(vs: T[]): T[] =>
  vs.some((v) => isSpecialVar(v.name))
    ? [...vs.filter((v) => !isSpecialVar(v.name)), ...vs.filter((v) => isSpecialVar(v.name))]
    : vs;

// Lazily-expanded variable tree. Refs die on resume, so parents pass fresh
// vars on every stop and expansion state resets with them (key on stop).
// parentRef = the container's variablesReference — what setVariable addresses
// a member of (scope ref at the top level, the parent var's ref below).
export type SetVarFn = (parentRef: number, name: string, value: string) => Promise<any>;

// prevVals (registers only): name→prior-stop value, owned by RegistersPanel so
// it survives the leaf remount on resume. Its presence enables the highlight.
export type PrevVals = React.MutableRefObject<Map<string, string>>;

// onWatch: "break when value changes", addressed the way DAP's dataBreakpointInfo
// wants a variable: its container's variablesReference plus its name.
export type WatchFn = (parentRef: number, name: string) => void;

export function VarList({ vars, disabled, parentRef, onSetVar, onAddr, onWatch, prevVals, gen, empty = "—" }: {
  vars: Var[]; disabled: boolean; parentRef: number; onSetVar?: SetVarFn;
  onAddr?: (a: string) => void; onWatch?: WatchFn; prevVals?: PrevVals; gen?: number; empty?: string;
}) {
  if (!vars.length) return <span className="hint">{empty}</span>;
  return (
    <div className="vartree">
      {realFirst(vars).map((v, i) => <VarNode key={i} v={v} disabled={disabled} parentRef={parentRef} onSetVar={onSetVar} onAddr={onAddr} onWatch={onWatch} prevVals={prevVals} gen={gen} />)}
    </div>
  );
}

// gen (registers only): bumps each stop. Open expandable nodes refetch their
// kids on a gen change even when the ref is stable — else nested registers freeze.
function VarNode({ v, disabled, parentRef, onSetVar, onAddr, onWatch, prevVals, gen }: {
  v: Var; disabled: boolean; parentRef: number; onSetVar?: SetVarFn;
  onAddr?: (a: string) => void; onWatch?: WatchFn; prevVals?: PrevVals; gen?: number;
}) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<Var[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Adapter-formatted value after a successful edit; cleared when a stop
  // delivers a fresh value through props.
  const [shown, setShown] = useState<string | null>(null);
  // Changed-since-last-step highlight (registers only). Diff against the value
  // this register held at the prior stop; first appearance is never "changed".
  const [changed, setChanged] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    setShown(null);
    if (prevVals) {
      const p = prevVals.current.get(v.name);
      setChanged(p !== undefined && p !== v.value);
      prevVals.current.set(v.name, v.value);
    }
  }, [v.value]);
  // Refetch kids when the ref changes (locals: refs die on resume, so cached
  // kids via the old ref may be garbage reads) or on a new stop (registers: the
  // ref is stable across stops, so gen is the only signal the values moved).
  // Drop the cache either way; if open, re-read so the subtree stays current.
  useEffect(() => {
    setKids(null);
    if (v.ref <= 0) { setOpen(false); return; }
    if (open) {
      request({ cmd: "expand", ref: v.ref }, (m) => setKids(m.vars || []));
    }
  }, [v.ref, gen]);
  const expand = () => {
    if (disabled) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (kids) return;
    request({ cmd: "expand", ref: v.ref }, (m) => setKids(m.vars || []));
  };
  const startEdit = () => {
    if (disabled || !onSetVar) return;
    setDraft(shown ?? v.value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    onSetVar!(parentRef, v.name, draft).then((r: any) => {
      if (!r) return;
      setShown(r.value);
      // Container contents changed under us — collapse so the next expand refetches.
      if (v.ref > 0) { setKids(null); setOpen(false); }
    });
  };
  const val = shown ?? v.value;
  return (
    <div>
      <div className={"var" + (v.ref > 0 ? " expandable" : "") + (open ? " open" : "")}
           onClick={v.ref > 0 ? expand : undefined}
           onContextMenu={onWatch && !disabled
             ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }
             : undefined}>
        <span className="tw" />
        <span className="name">{v.name}</span>
        {/* Type chip is for locals only; on registers (prevVals set) the adapter's
            "unsigned long" / "<no-type>" is noise. */}
        {v.type && !prevVals && <span className="vtype" title={v.type}>{v.type}</span>}
        {/* An aggregate's "value" IS its type (int[3] → int[3]), so printing both
            rendered `labels int[3] int[3]`. The type chip already says it. */}
        {editing ? (
          <input className="varedit" autoFocus value={draft} spellCheck={false}
                 onChange={(e) => setDraft(e.target.value)}
                 onBlur={() => setEditing(false)}
                 onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setEditing(false); }} />
        ) : (
          <span className={"val" + (changed ? " changed" : "")} onDoubleClick={startEdit}
                onClick={(e) => e.stopPropagation()} title={val}>
            {val === v.type ? null : <Val text={val} onAddr={onAddr} />}
          </span>
        )}
        {onAddr && v.mref && (
          <span className="memlink" title={`view memory at ${v.mref}`}
                onClick={(e) => { e.stopPropagation(); onAddr(v.mref!); }}>⌗</span>
        )}
      </div>
      {menu && onWatch && (
        <CtxMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
                 items={[{ label: "Break when value changes", hint: v.name, onClick: () => onWatch(parentRef, v.name) }]} />
      )}
      {open && (
        <div className="kids">
          {kids
            ? <VarList vars={kids} disabled={disabled} parentRef={v.ref} onSetVar={onSetVar} onAddr={onAddr} onWatch={onWatch} prevVals={prevVals} gen={gen} />
            : <span className="hint">…</span>}
        </div>
      )}
    </div>
  );
}
