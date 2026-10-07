// Session state: the server's message stream folded into one value. Pure, so the
// fold is tested without a browser (tests/session-reducer.ts). The shape mirrors
// the server's late-join replay, snapshot() in src/web/state.milo: hello, source,
// caps, breakpoints, stop, threads, regions. Live pushes are the same messages.
//
// RPC replies (evalResult, children, memory, ...) and terminal output are not
// state and pass through untouched; App routes those. `local/*` actions are the
// user moving around inside a stop (another frame, another thread), which the
// server never hears about.
import type { BpMeta } from "./SourceView";
import type { DebugConfig } from "./configSchema";
import type { Phase } from "./primary";

export type Frame = { id: number; name: string; line: number; path: string; ipRef: string };
export type Thread = { id: number; name: string };
// One data breakpoint as the server sends it (DataBp in state.milo).
export type DataBp = {
  dataId: string; label: string; description: string; accessType: string;
  condition: string; hitCondition: string; canPersist: boolean; verified: boolean; message: string;
};
export type Var = { name: string; value: string; ref: number; mref?: string; type?: string };
// A memory-map region from lldb's `memory region --all` (server-parsed).
// s/e are hex address strings; p = perms "rw-"; n = segment name or "".
export type Region = { s: string; e: string; p: string; n: string };

// One stop exactly as the server sent it (StopInfo in state.milo).
export type Stop = {
  line: number; path: string; tid: number;
  reason: string; description: string;
  // The stop-at-main breakpoint, which DAP reports as a plain "breakpoint".
  atMain: boolean;
  scopeRef: number; registersRef: number;
  frames: Frame[]; locals: Var[];
};

// Where a replay session is on its timeline (replayStateMsg in state.milo).
// `prev` is the stop step back goes to (0 = none); `rewinding` names the command
// a rewind in progress serves.
export type ReplayPos = {
  at: number; stops: number; prev: number; seekedTo: number; lastMs: number;
  rewinding: string; target: number; mode: string;
};
export const noReplayPos: ReplayPos = { at: 0, stops: 0, prev: 0, seekedTo: 0, lastMs: 0, rewinding: "", target: 0, mode: "" };

export type SessionState = {
  sessionId: string;
  program: string;
  sourcePath: string;
  adapterCmd: string;
  adapterId: string;
  config: DebugConfig;       // hello.config, or the user's last committed edit
  history: DebugConfig[];
  configError: string;
  caps: Record<string, any>;
  // This run's adapter has shown a register scope. Outlives the stop so the
  // Registers tab stays put (and says why it is empty) after the run ends.
  hasRegisters: boolean;
  bps: Map<string, BpMeta>;  // bpKey → meta
  // Data breakpoints (watchpoints), the server's whole list as last sent.
  dataBps: DataBp[];
  // How many the end of the last run cleared, for the panel to say so; 0 once the list changes again.
  dataBpsDropped: number;
  files: Map<string, string>;  // path → content, from source pushes
  phase: Phase;
  exitCode: number | undefined;
  stop: Stop | null;         // null unless a stop is current (kept while running)
  stopSeq: number;           // bumped per stop; see RegistersPanel for why
  // The user's view into the stop: starts at the stop, moves with frame and
  // thread selection.
  curTid: number;
  frames: Frame[];
  selFrame: number;
  stopLine: number;          // 0 while running
  stopPath: string;
  locals: Var[];
  scopeRef: number;
  threads: Thread[];
  tlocs: Map<number, { label: string; pc: string }>;  // each thread's top frame
  regions: Region[];
  replay: string;            // the trace a replay session runs on, "" for a live one
  rr: ReplayPos;
};

export const initialSession: SessionState = {
  sessionId: "", program: "", sourcePath: "", adapterCmd: "", adapterId: "debugger",
  config: {}, history: [], configError: "", caps: {}, hasRegisters: false,
  bps: new Map(), dataBps: [], dataBpsDropped: 0, files: new Map(),
  phase: "idle", exitCode: undefined,
  stop: null, stopSeq: 0,
  curTid: -1, frames: [], selFrame: 0, stopLine: 0, stopPath: "",
  locals: [], scopeRef: 0, threads: [], tlocs: new Map(), regions: [],
  replay: "", rr: noReplayPos,
};

export type LocalAction =
  | { type: "local/resumed" }                       // run / restart / step / continue sent
  | { type: "local/config"; config: DebugConfig }
  | { type: "local/configError"; error: string }
  | { type: "local/selectFrame"; i: number }
  | { type: "local/frameLocals"; vars: Var[]; scopeRef: number }
  | { type: "local/selectThread"; tid: number }
  | { type: "local/threadFrames"; frames: Frame[] }
  | { type: "local/tloc"; tid: number; label: string; pc: string };
// Server messages are whatever JSON arrived; the reducer reads the fields it owns.
export type SessionAction = LocalAction | { type: string; [k: string]: any };

export const base = (p: string) => p.split("/").pop() || p;
// A frame has real source only with a readable file path. lldb hands back
// "module`symbol" pseudo-paths for no-debug-info frames (dyld/libc), which get
// the disassembly view, not a bogus source tab.
export const hasSrc = (p: string) => !!p && !p.includes("`");
// Breakpoints are keyed per file; newline can't appear in a path.
export const bpKey = (path: string, line: number) => `${path}\n${line}`;

function bpMetaOf(m: any): BpMeta {
  return {
    ...(m.condition ? { condition: m.condition } : {}),
    ...(m.hitCondition ? { hitCondition: m.hitCondition } : {}),
    ...(m.logMessage ? { logMessage: m.logMessage } : {}),
    ...(m.enabled === false ? { enabled: false } : {}),
  };
}

// Everything that describes one stop. A run that ends, or a new session, drops
// all of it: a Registers tab still showing the last stop after exit read as if
// the program were paused.
const NO_STOP = {
  stop: null, curTid: -1, frames: [], selFrame: 0, stopLine: 0, stopPath: "",
  locals: [], scopeRef: 0, threads: [], tlocs: new Map(), regions: [],
} satisfies Partial<SessionState>;

export function stopOf(m: any): Stop {
  return {
    line: m.line ?? 0, path: m.path ?? "", tid: m.tid ?? -1,
    reason: m.reason ?? "", description: m.description ?? "", atMain: m.atMain === true,
    scopeRef: m.scopeRef || 0, registersRef: m.registersRef || 0,
    frames: m.frames || [], locals: m.locals || [],
  };
}

export function sessionReducer(s: SessionState, m: SessionAction): SessionState {
  switch (m.type) {
    case "hello": {
      // A different sessionId is a genuinely new session (newSession, or a server
      // restart): drop the old one's stop. A same-session rejoin keeps it, and
      // the replay that follows re-sends it anyway.
      const fresh = !!m.sessionId && m.sessionId !== s.sessionId;
      let phase: Phase = fresh ? "idle" : s.phase;
      if (m.phase === "running") phase = "running";
      return {
        ...s,
        ...(fresh ? { ...NO_STOP, sessionId: m.sessionId, exitCode: undefined, hasRegisters: false } : {}),
        program: m.program ?? "", sourcePath: m.sourcePath || "",
        adapterCmd: m.adapterCmd || "", adapterId: m.adapterId || "debugger",
        config: m.config || {}, history: m.history || [], configError: "",
        replay: m.replay || "", ...(m.replay ? {} : { rr: noReplayPos }),
        // The bp set and the files are re-sent after every hello (bpSync, source),
        // so these start empty rather than merging into a stale copy.
        bps: new Map(), files: new Map(),
        stopPath: "",
        phase,
      };
    }
    // Any peer's breakpoint change, including our own echo.
    case "breakpoint": {
      if (!m.path) return s;
      const bps = new Map(s.bps);
      if (m.set) bps.set(bpKey(m.path, m.line), bpMetaOf(m));
      else bps.delete(bpKey(m.path, m.line));
      return { ...s, bps };
    }
    case "dataBreakpoints":
      return { ...s, dataBps: m.list || [], dataBpsDropped: m.dropped || 0 };
    case "bpSync":
      return { ...s, bps: new Map(s.bps).set(bpKey(m.path, m.line), bpMetaOf(m)) };
    case "historyChanged":
      return { ...s, history: m.history || [] };
    case "configError":
      return { ...s, configError: m.error };
    case "capabilities":
      // A new adapter launch: whether it has registers is learned again at its first stop.
      try { return { ...s, caps: JSON.parse(m.raw).body || {}, hasRegisters: false }; } catch { return s; }
    case "source":
      return m.path ? { ...s, files: new Map(s.files).set(m.path, m.content) } : s;
    case "threads":
      return { ...s, threads: m.threads || [], curTid: m.current ?? -1, tlocs: new Map() };
    case "stopped": {
      const stop = stopOf(m);
      return {
        ...s, stop, stopSeq: s.stopSeq + 1, phase: "stopped",
        hasRegisters: s.hasRegisters || stop.registersRef > 0,
        curTid: stop.tid, frames: stop.frames, selFrame: 0,
        stopLine: stop.line, stopPath: stop.frames[0]?.path || stop.path,
        locals: stop.locals, scopeRef: stop.scopeRef,
      };
    }
    case "regions":
      return { ...s, regions: m.regions || [] };
    case "replayState":
      return {
        ...s, rr: {
          at: m.at ?? 0, stops: m.stops ?? 0, prev: m.prev ?? 0, seekedTo: m.seekedTo ?? 0, lastMs: m.lastMs ?? 0,
          rewinding: m.rewinding || "", target: m.target ?? 0, mode: m.mode || "",
        },
      };
    case "terminated":
      return {
        ...s, ...NO_STOP, phase: "done",
        exitCode: typeof m.exitCode === "number" ? m.exitCode : undefined,
      };

    case "local/resumed":
      return { ...s, phase: "running", stopLine: 0 };
    case "local/config":
      return { ...s, config: m.config };
    case "local/configError":
      return { ...s, configError: m.error };
    case "local/selectFrame": {
      const f = s.frames[m.i];
      if (s.phase !== "stopped" || !f) return s;
      return { ...s, selFrame: m.i, stopLine: f.line, stopPath: f.path };
    }
    case "local/frameLocals":
      return { ...s, locals: m.vars, scopeRef: m.scopeRef };
    case "local/selectThread":
      return { ...s, curTid: m.tid };
    case "local/threadFrames": {
      const f0: Frame | undefined = m.frames[0];
      if (!f0) return { ...s, frames: m.frames, selFrame: 0, locals: [] };
      return { ...s, frames: m.frames, selFrame: 0, stopLine: f0.line, stopPath: f0.path };
    }
    case "local/tloc":
      return { ...s, tlocs: new Map(s.tlocs).set(m.tid, { label: m.label, pc: m.pc }) };
  }
  return s;
}

// DAP stopped.reason → the pill's "why". Unknown reasons (adapters add their
// own) still show, verbatim, rather than collapsing to a bare "paused".
const STOP_WHY: Record<string, string> = {
  step: "paused after step", breakpoint: "paused on breakpoint", exception: "paused on exception",
  entry: "paused on entry", goto: "paused after goto",
  "function breakpoint": "paused on function breakpoint", "data breakpoint": "paused on watchpoint",
  "instruction breakpoint": "paused on instruction breakpoint",
};
const stopWhy = (st: Stop) =>
  st.atMain ? "paused at main" : (STOP_WHY[st.reason] ?? (st.reason ? `paused (${st.reason})` : "paused"));

export type Status = { text: string; short: string; cls: string };

// The header pill for a stop: a short form, with the adapter's own description
// on hover.
export function stopStatus(st: Stop): Status {
  const f0 = st.frames[0];
  const sp = f0?.path || st.path;
  const where = hasSrc(sp) ? `${base(sp)}:${st.line}` : (f0?.name || "");
  const why = stopWhy(st);
  const short = where ? `${why} · ${where}` : why;
  return { text: st.description ? `${short}: ${st.description}` : short, short, cls: "stopped" };
}
