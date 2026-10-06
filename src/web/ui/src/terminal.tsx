import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send } from "./rpc";

// xterm paints on a canvas and needs concrete colours, so read the design tokens
// from :root instead of repeating their hex here.
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ── Merged terminal (program + debugger output in one xterm) ──
// VS Code interleaves the debuggee's tty and the debugger's own output in a
// single view; we do the same. Program bytes (pty / DAP category "stdout")
// render raw — they own their SGR. Everything from the debugger — DAP "console"
// output, REPL echo/results, adapter errors — gets a dim color and a per-line
// tag (the adapter id: lldb/debugpy/…) so the two streams never blur together.
let dbgTag = "debugger";  // set from hello: keeps the tag generic across adapters
export const setDbgTag = (t: string) => { dbgTag = t; };
export const SGR = {
  reset: "\x1b[0m",
  dbg: "\x1b[38;5;80m",    // debugger console — cyan
  err: "\x1b[38;5;203m",   // stderr / failures — red
  cmd: "\x1b[2;37m",       // REPL echo — dim
  agent: "\x1b[38;5;213m", // another peer (dapweb api / an AI agent) — magenta
};
// Per-stream begin-of-line flags so a message split across events (or a partial
// pty line) isn't re-tagged mid-line.
const atBol: Record<string, boolean> = {};
// Everything the terminal was handed, by stream, so a hidden stream is only
// hidden: toggling redraws from here and nothing is lost. Capped well past
// xterm's own scrollback, so a redraw never shows less than was on screen.
// "adapter" is the debugger's unprompted console output (lldb's banner chatter);
// "prog" the debuggee; "repl" what the user or a peer asked for.
export type TermKind = "prog" | "adapter" | "repl";
const termLog: { kind: TermKind; data: string }[] = [];
let termLogLen = 0;
const TERM_LOG_MAX = 2_000_000;
export const termHidden = new Set<TermKind>(["adapter"]);
export function termPut(term: Terminal | null, kind: TermKind, data: string) {
  if (!data) return;
  termLog.push({ kind, data });
  termLogLen += data.length;
  while (termLogLen > TERM_LOG_MAX && termLog.length > 1) termLogLen -= termLog.shift()!.data.length;
  if (term && !termHidden.has(kind)) term.write(data);
}
export function termRedraw(term: Terminal | null) {
  if (!term) return;
  term.reset();
  for (const e of termLog) if (!termHidden.has(e.kind)) term.write(e.data);
}
export function termClear(term: Terminal | null) {
  termLog.length = 0;
  termLogLen = 0;
  term?.clear();
}
// Write `text` to the terminal in `color`, prefixing each line-start with `tag`.
// DAP/REPL text uses bare "\n"; xterm needs CRLF, so we translate and drop the
// program's own "\r" for tagged streams.
export function writeTagged(term: Terminal | null, key: string, text: string, color: string, tag: string,
                     kind: TermKind = "repl") {
  if (!term || !text) return;
  if (atBol[key] === undefined) atBol[key] = true;
  let out = color;
  for (const ch of text) {
    if (ch === "\r") continue;                 // we emit our own CRLF
    if (atBol[key]) { out += tag; atBol[key] = false; }
    if (ch === "\n") { out += "\r\n"; atBol[key] = true; }
    else out += ch;
  }
  termPut(term, kind, out + SGR.reset);
}

export function XTermView({ termRef }: { termRef: React.MutableRefObject<Terminal | null> }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: token("--bg"), foreground: token("--fg"), cursor: token("--fg") },
      // No blink, and no cursor at all unless the terminal itself is focused —
      // REPL input lives in the console box, so a pulsing block here just distracts.
      cursorBlink: false,
      cursorInactiveStyle: "none",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(elRef.current!);
    fit.fit();
    term.onData((data) => send({ cmd: "stdin", data }));
    term.onResize(({ rows, cols }) => send({ cmd: "resize", rows, cols }));
    termRef.current = term;
    const onWinResize = () => fit.fit();
    window.addEventListener("resize", onWinResize);
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(elRef.current!);
    return () => { window.removeEventListener("resize", onWinResize); ro.disconnect(); term.dispose(); };
  }, []);
  return <div className="term" ref={elRef} />;
}

// An `output` event into the terminal. Program stdout/stderr render as program
// output; console/important is debugger chatter, so tagged. "telemetry" is
// DAP-internal (adapter handshake, e.g. debugpy's "ptvsd") and never meant for
// display.
export function writeOutput(term: Terminal | null, category: string, text: string) {
  const c = category || "";
  if (c === "telemetry") return;
  if (c === "stdout") writeTagged(term, "out", text, "", "", "prog");
  else if (c === "stderr") writeTagged(term, "err", text, SGR.err, "", "prog");
  // DAP "important" is the adapter asking to be seen, so the adapter toggle
  // does not get to hide it.
  else writeTagged(term, "adapter", text, SGR.dbg, dbgTag + "  ", c === "important" ? "repl" : "adapter");
}
