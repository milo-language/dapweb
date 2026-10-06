import React, { useEffect, useRef, useState } from "react";
import type { Var } from "./session";
import { expandRef } from "./rpc";
import { RegionType, REGION_HELP } from "./regions";
import { Val } from "./Val";
import { Panel } from "./Panel";
import { VarList, SetVarFn } from "./VarList";

// Control/frame registers pinned to the top, in this order, with a role label.
// The four that steer execution shouldn't have to be hunted for in x0..x30.
const REG_PIN: string[] = ["pc", "sp", "fp", "lr", "x29", "x30", "cpsr"];
const REG_ROLE: Record<string, string> = {
  pc: "program counter", sp: "stack ptr", fp: "frame · x29", lr: "return · x30",
  x29: "frame ptr", x30: "return addr", cpsr: "flags",
  x0: "arg0 · ret", x1: "arg1", x2: "arg2", x3: "arg3",
  x4: "arg4", x5: "arg5", x6: "arg6", x7: "arg7",
};

type RegRow = { v: Var; changed: boolean };

// A register is one number in whatever base you happen to think in: hex for an
// address, dec for a count, bin when you are reading flags a bit at a time.
type Base = 16 | 10 | 8 | 2;
const BASE_NAME: Record<Base, string> = { 16: "hex", 10: "dec", 8: "oct", 2: "bin" };
const BASE_PREFIX: Record<Base, string> = { 16: "0x", 10: "", 8: "0o", 2: "0b" };

function inBase(hex: string, base: Base): string {
  if (base === 16) return hex;
  try {
    return BASE_PREFIX[base] + BigInt(hex).toString(base);
  } catch {
    return hex;
  }
}

// lldb hands back one string: the number, then whatever it can say about it
// ("0x0000000100003f28 dapweb_nested`main + 368 at main.c:26:41"). The table
// wants those apart, and the module apart from the symbol again.
function splitRegValue(raw: string): { hex: string; mod: string; sym: string } {
  const m = raw.match(/^\s*(0x[0-9a-fA-F]+)\s*(.*)$/s);
  if (!m) return { hex: "", mod: "", sym: raw.trim() };
  let rest = m[2].trim();
  // A bare decimal tail is lldb restating the same number, and this table
  // already has a column for that.
  if (/^-?[0-9]+$/.test(rest)) rest = "";
  const tick = rest.indexOf("`");
  return tick > 0
    ? { hex: m[1], mod: rest.slice(0, tick), sym: rest.slice(tick + 1) }
    : { hex: m[1], mod: "", sym: rest };
}

// Registers: flat, control regs pinned on top with roles, changed-since-last-step
// in amber. The adapter nests the real registers under group nodes (General
// Purpose, FP, …); we walk scope → groups → leaves and hoist the GP leaves so
// they show without a click. Non-GP groups (vector/FP/…) stay collapsible below.
export function RegistersPanel({ regRef, stopSeq, disabled, classify, onFrame, onSetVar, onAddr, bare }: {
  regRef: number; stopSeq: number; disabled: boolean;
  classify: ((a: string) => RegionType | null) | null;
  onFrame?: (f: { sp: string; fp: string; lr: string }) => void;
  onSetVar?: (parentRef: number, name: string, value: string) => Promise<any>;
  onAddr?: (a: string) => void;
  bare?: boolean;   // render without the Panel chrome (for the dedicated tab)
}) {
  const [gp, setGp] = useState<{ rows: RegRow[]; ref: number }>({ rows: [], ref: 0 });
  const [base, setBase] = useState<Base>(16);
  const [otherGroups, setOtherGroups] = useState<Var[]>([]);
  // Last committed value per register, and a sticky "changed" flag. Both live
  // here so they survive the per-stop refetch (register names are unique in the
  // scope). The flag updates ONLY on a real value transition and persists across
  // identical re-reads — a single step can emit two `stopped` events, and a
  // recompute-every-run design would clear the highlight on the duplicate.
  const prevVals = useRef<Map<string, string>>(new Map());
  const changedFlag = useRef<Map<string, boolean>>(new Map());

  // Re-read on regRef change AND every stop (stopSeq): lldb-dap keeps the
  // scope/group refs stable within a session, so a ref-only key would freeze.
  useEffect(() => {
    if (!regRef) {
      setGp({ rows: [], ref: 0 }); setOtherGroups([]);
      prevVals.current.clear(); changedFlag.current.clear(); return;
    }
    let live = true;
    (async () => {
      const groups = await expandRef(regRef);
      const withLeaves = await Promise.all(groups.map(async (g) =>
        ({ g, leaves: g.ref > 0 ? await expandRef(g.ref) : [g] })));
      if (!live) return;
      // GP = the group holding pc/x0. Flatten it; leave the rest collapsible.
      const gi = withLeaves.findIndex(({ leaves }) =>
        leaves.some((l) => l.name === "pc" || l.name === "x0"));
      const gpEntry = gi >= 0 ? withLeaves[gi] : null;
      const leaves = gpEntry?.leaves ?? [];
      const pinned = REG_PIN.map((n) => leaves.find((l) => l.name === n)).filter(Boolean) as Var[];
      const pinnedNames = new Set(pinned.map((l) => l.name));
      const rest = leaves.filter((l) => !pinnedNames.has(l.name));
      const ordered = [...pinned, ...rest];
      // Highlight exactly the regs the *latest* step moved. A single step can
      // emit a duplicate `stopped` with identical values; recomputing on that
      // would wrongly clear the marks. So: recompute only when at least one reg
      // differs from the last committed snapshot (pc always moves on a real
      // step) — a duplicate is a no-op that preserves the marks; the next real
      // step clears the stale ones and lights the newly-moved.
      const prev = prevVals.current, flag = changedFlag.current;
      const first = prev.size === 0;
      const anyDiff = ordered.some((v) => prev.get(v.name) !== v.value);
      if (first || anyDiff) {
        for (const v of ordered) {
          const p = prev.get(v.name);
          flag.set(v.name, !first && p !== undefined && p !== v.value);
          prev.set(v.name, v.value);
        }
      }
      const rows: RegRow[] = ordered.map((v) => ({ v, changed: flag.get(v.name) ?? false }));
      // Report sp/fp/lr up: sp builds the stack-aware classifier shared with
      // Memory; fp/lr let the memory view label saved-frame / return slots.
      // Values look like "0x16b6cb418" (or with a trailing symbol) — take the hex.
      const hexOf = (n: string) =>
        (ordered.find((v) => v.name === n)?.value.match(/0x[0-9a-fA-F]+/) || [])[0] ?? "";
      onFrame?.({ sp: hexOf("sp"), fp: hexOf("fp") || hexOf("x29"), lr: hexOf("lr") || hexOf("x30") });
      setGp({ rows, ref: gpEntry?.g.ref ?? 0 });
      setOtherGroups(withLeaves.filter((_, i) => i !== gi).map(({ g }) => g));
    })();
    return () => { live = false; };
  }, [regRef, stopSeq]);

  // Region-color each register by what its value points into (classify comes
  // from App; null until a `regions` message arrives — python/go send none).
  const content = gp.rows.length === 0 && otherGroups.length === 0
    ? <span className="hint">{disabled ? "stop the program to read the registers" : "no registers"}</span>
    : <>
        <div className="regctl">
          {([16, 10, 8, 2] as const).map((r) => (
            <button key={r} className={base === r ? "radix-on" : ""}
                    title={"show register values in " + BASE_NAME[r]}
                    onClick={() => setBase(r)}>{BASE_NAME[r]}</button>
          ))}
        </div>
        {/* One grid with one width per column, so a value lines up with the
            value above it. Binary needs four times the room, so that width is a
            variable the base sets rather than a guess that fits nothing. */}
        <div className="regtable"
             style={{ ["--valw" as any]: base === 2 ? "72ch" : base === 8 ? "28ch" : base === 10 ? "24ch" : "23ch" }}>
          <div className="regrow reghead">
            <span className="rmark" title="changed since the last stop">&#916;</span>
            <span className="rname">reg</span>
            <span className="rrole">role</span>
            <span className="rval">{BASE_NAME[base]}</span>
            <span className="rdec">{base === 10 ? "hex" : "dec"}</span>
            <span className="rmod">module</span>
            <span className="rsym">points at</span>
            <span />
          </div>
          {gp.rows.map(({ v, changed }) => {
            const addr = (v.value.match(/0x[0-9a-fA-F]+/) || [])[0] || "";
            const region = classify && addr ? classify(addr) : null;
            return (
              <RegRowView key={v.name} v={v} changed={changed} role={REG_ROLE[v.name]}
                          region={region} disabled={disabled} parentRef={gp.ref}
                          base={base} onSetVar={onSetVar} onAddr={onAddr} />
            );
          })}
        </div>
        {/* vector / FP / exception groups: rarely needed, kept collapsible */}
        {otherGroups.length > 0 &&
          <VarList vars={otherGroups} disabled={disabled} parentRef={regRef}
                   onSetVar={onSetVar} onAddr={onAddr} prevVals={prevVals} gen={stopSeq} />}
      </>;
  if (bare) return <div className="regview">{content}</div>;
  return <Panel title="Registers">{content}</Panel>;
}

// One row of the register table. Every column is one fact: did it move, what it
// is called, what it steers, the number, the same number in decimal, and what
// the address lands in. Value editable via setVariable, addresses clickable.
function RegRowView({ v, changed, role, region, disabled, parentRef, base, onSetVar, onAddr }: {
  v: Var; changed: boolean; role?: string; region?: RegionType | null;
  disabled: boolean; parentRef: number; base: Base;
  onSetVar?: SetVarFn; onAddr?: (a: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => { setShown(null); }, [v.value]);
  const val = shown ?? v.value;
  const { hex, mod, sym } = splitRegValue(val);
  const startEdit = () => { if (!disabled && onSetVar) { setDraft(hex || val); setEditing(true); } };
  const commit = () => {
    setEditing(false);
    onSetVar!(parentRef, v.name, draft).then((r: any) => { if (r) setShown(r.value); });
  };
  // The second number column: decimal, unless decimal is already the first one.
  let alt = "";
  if (hex) {
    try { alt = base === 10 ? hex : BigInt(hex).toString(); } catch { alt = ""; }
  }
  const shownVal = hex ? inBase(hex, base) : val;
  return (
    <div className={"regrow" + (changed ? " changed" : "")}>
      <span className="rmark" title={changed ? "changed since the last stop" : ""}>{changed ? "\u25b2" : ""}</span>
      <span className="rname">{v.name}</span>
      <span className="rrole">{role ?? ""}</span>
      {editing ? (
        <input className="varedit" autoFocus value={draft} spellCheck={false}
               onChange={(e) => setDraft(e.target.value)}
               onBlur={() => setEditing(false)}
               onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setEditing(false); }} />
      ) : (
        <span className="rval" onDoubleClick={startEdit} title={region ? `${val}\n${REGION_HELP[region]}` : val}>
          {region && <span className={"rdot b-" + region} title={REGION_HELP[region]} />}
          {/* Only hex carries the 0x… shape the memory viewer opens on, so the
              other bases print plain and the ⌗ at the end of the row is the way
              in. */}
          {base === 16
            ? <Val text={shownVal} onAddr={onAddr} cls={region ? "t-" + region : undefined} />
            : <span className={region ? "t-" + region : undefined}>{shownVal}</span>}
        </span>
      )}
      <span className="rdec" title={base === 10 ? "hex" : "decimal"}>{alt}</span>
      <span className="rmod" title={mod}>{mod}</span>
      <span className="rsym" title={sym || (region ?? "")}>
        {sym || (region ? <i className={"t-" + region}>{region}</i> : "")}
      </span>
      <span className="rlink">
        {onAddr && (v.mref || hex) &&
          <span className="memlink" title={`view memory at ${v.mref || hex}`}
                onClick={() => onAddr(v.mref || hex)}>&#8983;</span>}
      </span>
    </div>
  );
}
