// The header's transport controls: Run/Pause/Continue, stepping, restart/stop,
// and the two disassembly toggles.
import React from "react";
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
};
const Ico = ({ g, sub }: { g: number; sub?: string }) => (
  <>
    <span className="ci">{String.fromCodePoint(g)}</span>
    {sub && <span className="ci-sub">{sub}</span>}
  </>
);

export function Transport({ primary, phase, asm, inlineAsm, canInstrStep, canDisasm, onPrimary, resume, restart,
                            onDisasm, onInlineAsm }: {
  primary: ReturnType<typeof primaryAction>; phase: Phase; asm: boolean; inlineAsm: boolean;
  canInstrStep: boolean; canDisasm: boolean; onPrimary: () => void;
  resume: (cmd: string, granularity?: string) => void; restart: () => void;
  onDisasm: () => void; onInlineAsm: () => void;
}) {
  const stopped = phase === "stopped";
  return (
    <>
      <span className="toolbar">
        <button className="primary" disabled={primary.disabled} data-tip={primary.tip} onClick={onPrimary}>
          <Ico g={primary.kind === "continue" ? CI.cont : primary.kind === "pause" ? CI.pause : CI.run} />
          {primary.label}
        </button>
      </span>
      <span className="toolbar">
        <button disabled={!stopped} data-tip="Step over (F10)" onClick={() => resume("stepOver")}><Ico g={CI.stepOver} /></button>
        <button disabled={!stopped} data-tip="Step into (F11)" onClick={() => resume("stepIn")}><Ico g={CI.stepInto} /></button>
        <button disabled={!stopped} data-tip="Step out (Shift+F11)" onClick={() => resume("stepOut")}><Ico g={CI.stepOut} /></button>
        {asm && <button disabled={!canInstrStep} data-tip="Step one instruction, over calls"
                        onClick={() => resume("stepOver", "instruction")}><Ico g={CI.stepOver} sub="i" /></button>}
        {asm && <button disabled={!canInstrStep} data-tip="Step one instruction, into calls"
                        onClick={() => resume("stepIn", "instruction")}><Ico g={CI.stepInto} sub="i" /></button>}
      </span>
      <span className="toolbar">
        <button disabled={phase !== "running" && phase !== "stopped"}
                data-tip="Restart: same target, from the top, breakpoints persist (Ctrl+Shift+F5)" onClick={restart}><Ico g={CI.restart} /></button>
        <button disabled={phase !== "running" && phase !== "stopped"}
                data-tip="Stop: terminate the program (Shift+F5)" onClick={() => send({ cmd: "kill" })}><Ico g={CI.stop} /></button>
        <button disabled={!canDisasm}
                className={asm && !inlineAsm ? "asm-on" : ""}
                data-tip={stopped ? "Disassembly: show machine code beside the source"
                               : "Disassembly (available while stopped, adapter must support it)"}
                onClick={onDisasm}><Ico g={CI.chip} /></button>
        <button disabled={!canDisasm}
                className={inlineAsm ? "asm-on" : ""}
                data-tip="Inline disassembly: show each source line's machine code under it"
                onClick={onInlineAsm}><Ico g={CI.chip} sub="s" /></button>
      </span>
    </>
  );
}
