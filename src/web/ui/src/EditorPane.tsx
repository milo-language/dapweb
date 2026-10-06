// The editor column: file tabs, the source, and the disassembly beside it, in
// place of it (a frame with no source), or inline under each line.
import React, { useEffect, useMemo, useRef, useState } from "react";
import SourceView, { langFor, BpMeta, HoverVar, LineActions } from "./SourceView";
import { tabLabels } from "./tabLabels";
import { base, hasSrc, Stop } from "./session";
import { inlineValues, nextChanged } from "./inlineValues";

const INLINE_KEY = "dapweb.inlineValues";
// Storage can throw (blocked site data, some private windows); the toggle then
// just is not remembered.
const loadInline = () => { try { return localStorage.getItem(INLINE_KEY) !== "0"; } catch { return true; } };
const saveInline = (on: boolean) => { try { localStorage.setItem(INLINE_KEY, on ? "1" : "0"); } catch {} };

export type Insn = { addr: string; text: string; sym: string; line: number };
export type Disasm = { lines: Insn[]; pc: string };

const EMPTY_BPS = new Map<number, any>();
const noop = () => {};

// Disassembly pane text: one line per instruction, pc line for the arrow.
// Addresses compare via BigInt — lldb pads instructionPointerReference wider
// than the per-instruction address strings.
function buildAsm(d: { lines: Insn[]; pc: string }): { text: string; pcLine: number } {
  const norm = (a: string) => { try { return BigInt(a).toString(16); } catch { return a; } };
  const pcN = norm(d.pc);
  let pcLine = 0;
  const text = d.lines.map((ins, i) => {
    if (norm(ins.addr) === pcN) pcLine = i + 1;
    return `${ins.addr}  ${ins.text}${ins.sym ? `    ; ${ins.sym}` : ""}`;
  }).join("\n");
  return { text, pcLine };
}

export function EditorPane({ tabs, viewPath, openFile, files, bps, stopPath, stopLine, caps, jump, disasm, inlineAsm,
                             fetchDisasm, onToggleBp, onSetBpMeta, onHoverEval, emptyHint, stop, stopSeq,
                             onRunToLine, onGotoLine }: {
  tabs: string[]; viewPath: string; openFile: (path: string, line?: number) => void;
  files: Map<string, string>; bps: Map<string, BpMeta>;
  stopPath: string; stopLine: number; caps: Record<string, any>; jump: { line: number; n: number };
  disasm: Disasm | null; inlineAsm: boolean; fetchDisasm: (pc: string) => void;
  onToggleBp: (ln: number) => void; onSetBpMeta: (ln: number, meta: BpMeta) => void;
  onHoverEval: (expr: string) => Promise<{ value: string; children?: HoverVar[] } | null>;
  // What an editor with no source says; "none" means nothing is configured at all.
  emptyHint: string;
  // The current stop (null once the run ends) and its sequence number, for
  // inline values and their changed-since-last-stop marks.
  stop: Stop | null; stopSeq: number;
  onRunToLine: (path: string, line: number) => void;
  onGotoLine: (path: string, line: number) => void;
}) {
  const tabLabel = useMemo(() => tabLabels(tabs), [tabs]);
  const srcText = files.get(viewPath) ?? "";
  const [inlineOn, setInlineOn] = useState(loadInline);
  // Changed marks advance once per stop, keyed on stopSeq so a re-render (or
  // StrictMode's double render) does not advance them twice; a run that ends
  // forgets them, so the next run's first stop marks nothing.
  const chg = useRef({ seq: -1, prev: new Map<string, string>(), marks: new Set<string>() });
  if (!stop) chg.current = { seq: -1, prev: new Map(), marks: new Set() };
  else if (chg.current.seq !== stopSeq) {
    chg.current = { seq: stopSeq, ...nextChanged(chg.current.prev, chg.current.marks, stop.frames[0]?.name ?? "", stop.locals) };
  }
  const marks = chg.current.marks;
  // The top frame's locals, drawn only in its own file and only while stopped.
  const topPath = stop ? (stop.frames[0]?.path || stop.path) : "";
  const topLine = stop ? (stop.frames[0]?.line || stop.line) : 0;
  const showVals = inlineOn && stopLine > 0 && !!stop && topPath === viewPath;
  const inlineVals = useMemo(
    () => (showVals ? inlineValues(srcText.split("\n"), topLine, stop!.locals, langFor(viewPath), marks) : undefined),
    [showVals, srcText, topLine, stop, viewPath, marks]);
  const stopped = stopLine > 0 && !!stop;
  const lineActions: LineActions | undefined = useMemo(() => (hasSrc(viewPath) ? {
    runToLine: stopped ? (ln: number) => onRunToLine(viewPath, ln) : null,
    gotoLine: stopped && caps.supportsGotoTargetsRequest ? (ln: number) => onGotoLine(viewPath, ln) : null,
  } : undefined), [viewPath, stopped, caps, onRunToLine, onGotoLine]);
  const viewBps = useMemo(() => {
    const out = new Map<number, BpMeta>();
    bps.forEach((meta, k) => {
      const [p, ln] = [k.slice(0, k.indexOf("\n")), Number(k.slice(k.indexOf("\n") + 1))];
      if (p === viewPath) out.set(ln, meta);
    });
    return out;
  }, [bps, viewPath]);
  const asm = useMemo(() => (disasm ? buildAsm(disasm) : null), [disasm]);
  // Group the current disasm window's instructions by source line for the inline
  // view. Only statement-boundary instructions carry a line; the rest come back
  // as line 0, so carry the last line forward (objdump -S style) — otherwise the
  // add/str that finish a statement silently vanish.
  const asmByLine = useMemo(() => {
    const m = new Map<number, { addr: string; text: string }[]>();
    if (!disasm) return m;
    let cur = 0;
    for (const ins of disasm.lines) {
      if (ins.line > 0) cur = ins.line;
      if (cur > 0) (m.get(cur) ?? m.set(cur, []).get(cur)!).push({ addr: ins.addr, text: ins.text });
    }
    return m;
  }, [disasm]);
  // Which asm line to reveal, bumped to re-trigger. A fresh disasm window reveals
  // its pc; an in-window address click reveals the branch target instead.
  const [asmJump, setAsmJump] = useState({ line: 0, n: 0 });
  useEffect(() => { if (asm) setAsmJump((j) => ({ line: asm.pcLine, n: j.n + 1 })); }, [asm]);
  // Follow a clicked address: reveal it if it's in the current window, else
  // disassemble a fresh window around it (chase a branch/call target).
  const followAddr = (addr: string) => {
    const norm = (a: string) => { try { return BigInt(a).toString(16); } catch { return a; } };
    const t = norm(addr);
    const idx = disasm ? disasm.lines.findIndex((i) => norm(i.addr) === t) : -1;
    if (idx >= 0) { setAsmJump((j) => ({ line: idx + 1, n: j.n + 1 })); return; }
    // Out of window: only chase things that look like code addresses, not the
    // small immediates/stack offsets (#0x8, [sp, #0x40]) that share 0x… syntax.
    try { if (BigInt(addr) < 0x1000n) return; } catch { return; }
    fetchDisasm(addr);
  };

  return (
    <div className="editor-col">
      {/* One file still gets its tab: it names what you are looking at, and a
          bar that appears only on the second file makes the first stop look
          like a different app than every stop after it. */}
      {tabs.length > 0 && (
        <div className="filetabs">
          {tabs.map((p) => (
            <div key={p} className={"filetab" + (p === viewPath ? " active" : "")}
                 title={p} onClick={() => openFile(p)}>{tabLabel.get(p) ?? base(p)}</div>
          ))}
          <span className="edtools">
            <span className={"termchip" + (inlineOn ? " on" : "")} role="switch" aria-checked={inlineOn}
                  data-tip="Inline values: show each local's value at the end of the line that last uses it"
                  onClick={() => { setInlineOn(!inlineOn); saveInline(!inlineOn); }}>x = 1</span>
          </span>
        </div>
      )}
      <div className="source-wrap">
        {(() => {
          const asmPane = asm ? (
            <SourceView text={asm.text} lang="asm" bps={EMPTY_BPS} stopLine={asm.pcLine}
                        onToggle={noop} onSetMeta={noop} caps={caps}
                        jump={asmJump}
                        onLineClick={(ln, word) => {
                          // Hex address (branch/call target or the addr column) → follow it.
                          if (word && /^0x[0-9a-fA-F]+$/.test(word)) { followAddr(word); return; }
                          // Otherwise asm → source: jump to the instruction's source line.
                          const ins = disasm!.lines[ln - 1];
                          if (ins?.line && stopPath) openFile(stopPath, ins.line);
                        }} />
          ) : null;
          // No-debug-info frame (dyld/libc etc.): show the disassembly in place
          // of the source — not a placeholder telling the user to run a command.
          if (!hasSrc(viewPath)) {
            if (asmPane) return asmPane;
            // Nothing configured: a blank editor gives no clue what comes first.
            if (emptyHint === "none") return (
              <div className="src-empty">
                <div className="src-empty-title">Nothing to debug yet</div>
                <div>Type a program path in the target bar above and press Enter,</div>
                <div>or start dapweb with one: <code>dapweb /path/to/binary</code></div>
              </div>
            );
            return (
              <div className="src-hint">{emptyHint}</div>
            );
          }
          return (
            <>
              <SourceView text={srcText} lang={langFor(viewPath)} bps={viewBps}
                          stopLine={viewPath === stopPath ? stopLine : 0}
                          onToggle={onToggleBp} onSetMeta={onSetBpMeta} onHoverEval={onHoverEval}
                          caps={caps} jump={jump}
                          asmByLine={inlineAsm && viewPath === stopPath ? asmByLine : undefined}
                          asmPc={disasm?.pc} inlineVals={inlineVals} lineActions={lineActions} />
              {asm && !inlineAsm && asmPane}
            </>
          );
        })()}
      </div>
    </div>
  );
}
