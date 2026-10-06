// The bottom panel: the merged terminal and the views that read the debuggee's
// memory (Memory, Registers, Stack), plus the binary report.
import React, { useMemo, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { Frame, Var, Region } from "./session";
import { buildRegionClassifier } from "./regions";
import { TermKind, termHidden, termRedraw, XTermView } from "./terminal";
import { DragBar } from "./Drag";
import { DebugConsole } from "./DebugConsole";
import { MemView } from "./MemView";
import { RegistersPanel } from "./RegistersPanel";
import { StackView } from "./StackView";
import { BinInfoView } from "./BinInfoView";
import type { SetVarFn } from "./VarList";

export type BottomTab = "term" | "mem" | "stack" | "regs" | "bin";

export function BottomPanel(p: {
  tab: BottomTab; setTab: (t: BottomTab) => void;
  memLinks: boolean; hasRegisters: boolean; binTab: boolean; binInfo: any | null; dbgLabel: string;
  termRef: React.MutableRefObject<Terminal | null>; consoleAppend: (t: string, c?: string) => void;
  frame0Ref: React.MutableRefObject<number>; caps: Record<string, any>; stopped: boolean;
  locals: Var[]; frames: Frame[]; stopSeq: number; registersRef: number; regions: Region[];
  setVar: SetVarFn; viewMemory: (a: string) => void;
  mem: { addr: string; bytes: Uint8Array } | null; memAddr: string; setMemAddr: (a: string) => void; memErr: string;
}) {
  const { tab, setTab, memLinks, binTab, binInfo, dbgLabel, termRef, caps, stopped, frames, stopSeq, viewMemory } = p;
  const [bottomH, setBottomH] = useState(240);
  const [termShown, setTermShown] = useState<Set<TermKind>>(() => new Set<TermKind>(["prog", "repl"]));
  const toggleTerm = (k: TermKind) => {
    if (termHidden.has(k)) termHidden.delete(k); else termHidden.add(k);
    termRedraw(termRef.current);
    setTermShown(new Set<TermKind>((["prog", "adapter", "repl"] as TermKind[]).filter((x) => !termHidden.has(x))));
  };
  const regions = p.regions;
  // Frame registers reported up from RegistersPanel — sp drives stack detection,
  // fp/lr let the memory view annotate saved-frame / return-address slots.
  const [regFrame, setRegFrame] = useState<{ sp: string; fp: string; lr: string }>({ sp: "", fp: "", lr: "" });
  const regSp = regFrame.sp;
  // Shared region classifier — one map+sp, used by both Registers and Memory so
  // a value's hue means the same thing in both. null until a map arrives.
  const classifyRegion = useMemo(
    () => (regions.length ? buildRegionClassifier(regions, regSp) : null),
    [regions, regSp]);
  return (
    <div className="bottom" style={{ height: bottomH }}>
      <DragBar onResize={(h) => setBottomH(h)} />
      <div className="tabs">
        <div className={"tab" + (tab === "term" ? " active" : "")} onClick={() => setTab("term")}>Terminal</div>
        {/* Both views are pure readMemory consumers — the hex window IS a
            readMemory, and the stack drawing walks the fp chain with one per
            frame. An adapter without it (debugpy, most language adapters)
            gave two tabs that could only ever say "unavailable", so they are
            offered where they work, the way Registers already is. */}
        {memLinks && (
          <div className={"tab" + (tab === "mem" ? " active" : "")} onClick={() => setTab("mem")}>Memory</div>
        )}
        {p.hasRegisters && (
          <div className={"tab" + (tab === "regs" ? " active" : "")} onClick={() => setTab("regs")}>Registers</div>
        )}
        {memLinks && (
          <div className={"tab" + (tab === "stack" ? " active" : "")} onClick={() => setTab("stack")}>Stack</div>
        )}
        {binTab && (
          <div className={"tab" + (tab === "bin" ? " active" : "")} onClick={() => setTab("bin")}>Binary</div>
        )}
        {tab === "term" && (
          <span className="termlegend">
            <span className={"termchip" + (termShown.has("prog") ? " on" : "")} onClick={() => toggleTerm("prog")}
                  data-tip="program output, plain. Click to show or hide">
              <span className="sw prog" /> program</span>
            <span className={"termchip" + (termShown.has("adapter") ? " on" : "")} onClick={() => toggleTerm("adapter")}
                  data-tip={`${dbgLabel}'s own console output, tagged. Hidden by default; click to show or hide`}>
              <span className="sw dbg" /> {dbgLabel}</span>
          </span>
        )}
      </div>
      {/* Merged terminal (VS Code-style): the debuggee's tty and the debugger's
          own output share one scrollback; the REPL input drives evaluate. */}
      <div className="tabpane termpane" style={{ display: tab === "term" ? "flex" : "none" }}>
        <XTermView termRef={termRef} />
        <DebugConsole append={p.consoleAppend} frame0Ref={p.frame0Ref}
                      canComplete={!!caps.supportsCompletionsRequest} />
      </div>
      <div className="tabpane" style={{ display: tab === "mem" && memLinks ? "flex" : "none" }}>
        <MemView mem={p.mem} addr={p.memAddr} setAddr={p.setMemAddr} err={p.memErr}
                 enabled={memLinks && stopped} onLoad={viewMemory} classify={classifyRegion}
                 locals={p.locals} frames={frames} regFrame={regFrame} />
      </div>
      {/* Always mounted (display-toggled): RegistersPanel reports sp/fp/lr up via
          onFrame, which the Memory and Stack views depend on regardless of tab. */}
      {p.hasRegisters && (
        <div className="tabpane regpane" style={{ display: tab === "regs" ? "flex" : "none" }}>
          <RegistersPanel regRef={p.registersRef} stopSeq={stopSeq} disabled={!stopped}
                          classify={classifyRegion} onFrame={setRegFrame}
                          onSetVar={caps.supportsSetVariable ? p.setVar : undefined}
                          onAddr={memLinks ? viewMemory : undefined} bare />
        </div>
      )}
      {/* Mounted only when visible: the drawing walks the fp chain with a
          readMemory round-trip per frame on every stop. */}
      {tab === "stack" && memLinks && (
        <div className="tabpane">
          <StackView enabled={memLinks && stopped} regFrame={regFrame} frames={frames}
                     stopSeq={stopSeq} onAddr={viewMemory} />
        </div>
      )}
      {/* Was a modal behind an unlabelled chip beside the target input, in a
          toolbar with no room to say what it was. It is a report about the
          thing being debugged, so it belongs where the other reports are —
          and here it has the width to print a path without wrapping. */}
      {tab === "bin" && binTab && (
        <div className="tabpane binpane">
          <BinInfoView info={binInfo} />
        </div>
      )}
    </div>
  );
}
