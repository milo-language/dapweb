// The header's transport controls: Run/Pause/Continue, stepping, restart/stop,
// and an overflow menu with the disassembly toggles and instruction steps.
import React, { useState } from "react";
import type { Phase } from "./primary";
import { primaryAction } from "./primary";
import { send } from "./rpc";

// VS Code codicon glyphs (font ships inside monaco; build.sh copies the ttf).
// Codepoints from monaco's codiconsLibrary.js — stable public API of the font.
// Only the transport controls are glyphs now: they are the buttons you press
// constantly and they have universally-understood shapes. Everything else in the
// header is a word (add/gear/info went with the three-glyph cluster they named).
const CI = {
  run: 0xead3, cont: 0xeacf, pause: 0xead1,
  stepOver: 0xead6, stepInto: 0xead4, stepOut: 0xead5,
  restart: 0xead2, stop: 0xead7, chip: 0xec19,
  stepBack: 0xeb8f, reverseCont: 0xeb8e, more: 0xea7c,
};

// The two backwards controls of a replay session. Passed only when the session
// is one: hello says so before anything runs, so the group never appears or
// vanishes under the user's cursor mid-session.
export type Reverse = {
  canStepBack: boolean; canReverse: boolean; rewinding: boolean;
  onStepBack: () => void; onReverse: () => void;
};
const Ico = ({ g, sub }: { g: number; sub?: string }) => (
  <>
    <span className="ci">{String.fromCodePoint(g)}</span>
    {sub && <span className="ci-sub">{sub}</span>}
  </>
);

export function Transport({ primary, phase, asm, inlineAsm, canInstrStep, canDisasm, onPrimary, resume, restart,
                            onDisasm, onInlineAsm, reverse }: {
  primary: ReturnType<typeof primaryAction>; phase: Phase; asm: boolean; inlineAsm: boolean;
  canInstrStep: boolean; canDisasm: boolean; onPrimary: () => void;
  resume: (cmd: string, granularity?: string) => void; restart: () => void;
  onDisasm: () => void; onInlineAsm: () => void; reverse?: Reverse;
}) {
  const stopped = phase === "stopped";
  const [more, setMore] = useState(false);
  // Instruction steps are pressed in runs, so they leave the menu open.
  const stepI = (cmd: string) => resume(cmd, "instruction");
  return (
    <>
      <span className="toolbar">
        <button className="primary" disabled={primary.disabled} data-tip={primary.tip} onClick={onPrimary}>
          <Ico g={primary.kind === "continue" ? CI.cont : primary.kind === "pause" ? CI.pause : CI.run} />
          <span className="primary-label">{primary.label}</span>
        </button>
      </span>
      {reverse && (
        <span className="toolbar reverse">
          <button disabled={!reverse.canReverse} data-tip="Reverse continue: back to the last time a breakpoint was hit (Alt+F5)"
                  onClick={reverse.onReverse}><Ico g={CI.reverseCont} /></button>
          <button disabled={!reverse.canStepBack} data-tip="Step back: to the previous stop, re-run from the recording (Alt+F10)"
                  onClick={reverse.onStepBack}><Ico g={CI.stepBack} /></button>
        </span>
      )}
      <span className="toolbar">
        <button disabled={!stopped} data-tip="Step over (F10)" onClick={() => resume("stepOver")}><Ico g={CI.stepOver} /></button>
        <button disabled={!stopped} data-tip="Step into (F11)" onClick={() => resume("stepIn")}><Ico g={CI.stepInto} /></button>
        <button disabled={!stopped} data-tip="Step out (Shift+F11)" onClick={() => resume("stepOut")}><Ico g={CI.stepOut} /></button>
      </span>
      <span className="toolbar">
        <button disabled={phase !== "running" && phase !== "stopped"}
                data-tip="Restart: same target, from the top, breakpoints persist (Ctrl+Shift+F5)" onClick={restart}><Ico g={CI.restart} /></button>
        <button disabled={phase !== "running" && phase !== "stopped"}
                data-tip="Stop: terminate the program (Shift+F5)" onClick={() => send({ cmd: "kill" })}><Ico g={CI.stop} /></button>
        {/* The machine-level controls live behind one button: the header has no
            width for four icons most sessions never press. Always present, so
            nothing moves; blue while either disassembly view is on. */}
        <span className="more-wrap">
          <button className={asm ? "asm-on" : ""} aria-label="more controls" aria-expanded={more}
                  data-tip={more ? undefined : "Disassembly and instruction steps"}
                  onClick={() => setMore((v) => !v)}><Ico g={CI.more} /></button>
          {more && (
            <>
              <div className="menu-backdrop" onClick={() => setMore(false)} />
              <div className="menu-pop more-pop">
                <button className="menu-item" disabled={!canDisasm} onClick={() => { setMore(false); onDisasm(); }}>
                  <span><span className="menu-check">{asm && !inlineAsm ? "✓" : ""}</span>Disassembly</span>
                  <span className="menu-hint">{canDisasm ? "beside the source" : "while stopped"}</span>
                </button>
                <button className="menu-item" disabled={!canDisasm} onClick={() => { setMore(false); onInlineAsm(); }}>
                  <span><span className="menu-check">{inlineAsm ? "✓" : ""}</span>Inline disassembly</span>
                  <span className="menu-hint">under each line</span>
                </button>
                <div className="menu-sep" />
                <button className="menu-item" disabled={!asm || !canInstrStep} onClick={() => stepI("stepOver")}>
                  <span><span className="menu-check" />Step instruction, over calls</span>
                  <span className="menu-hint">{asm ? "" : "disassembly first"}</span>
                </button>
                <button className="menu-item" disabled={!asm || !canInstrStep} onClick={() => stepI("stepIn")}>
                  <span><span className="menu-check" />Step instruction, into calls</span>
                  <span className="menu-hint">{asm ? "" : "disassembly first"}</span>
                </button>
              </div>
            </>
          )}
        </span>
      </span>
    </>
  );
}
