// Dapweb web UI — React + xterm.js. Talks WS protocol v2 (see docs/design.md).
import React, { useEffect, useMemo, useReducer, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import SourceView, { langFor, BpMeta, BpPopover, HoverVar } from "./SourceView";
import ConfigDrawer, { stripJsonc } from "./ConfigDrawer";
import { tabLabels } from "./tabLabels";
import { primaryAction, exitLabel } from "./primary";
import { threadLabel } from "./threadLabel";
import {
  Frame, Thread, Var, sessionReducer, initialSession, base, hasSrc, bpKey, stopOf, stopStatus,
} from "./session";
import { send, request, requestWithin, pending, routeReply, memBytes, setSocket, setOnSendWhileDead, expandRef } from "./rpc";
import { buildRegionClassifier } from "./regions";
import {
  TermKind, termHidden, termPut, termRedraw, termClear, writeTagged, writeOutput, setDbgTag, SGR, XTermView,
} from "./terminal";
import { Mark } from "./Mark";
import { Panel } from "./Panel";
import { Val } from "./Val";
import { VarList, isSpecialVar } from "./VarList";
import { RegistersPanel } from "./RegistersPanel";
import { BpList } from "./BpList";
import { DebugConsole } from "./DebugConsole";
import { StackView } from "./StackView";
import { MemView } from "./MemView";
import { BinInfoView } from "./BinInfoView";
import { DragBar, AsideDrag } from "./Drag";

type Insn = { addr: string; text: string; sym: string; line: number };
type Watch = { expr: string; value: string | null };
// Enriched hover payload: the evaluated value plus, for aggregates/pointers,
// one level of expanded members (name/type/value) rendered in the tooltip.
type HoverInfo = { value: string; children?: HoverVar[] };

// Whether a config names something to debug, mirroring the server's own rule
// (resolveConfig): a launch needs a program, an attach needs a pid, a connect{},
// or waitFor+program. Testing `program` alone reports every attach as "no
// target", which is how attaching by pid ended up looking unconfigured.
function hasTarget(c: any, program?: string): boolean {
  if (!c) return !!program;
  return c.request === "attach"
    ? (c.pid != null || c.processId != null || c.connect != null || (!!c.waitFor && !!c.program))
    : !!(program ?? c.program);
}

const EMPTY_BPS = new Map<number, any>();
const noop = () => {};

// Split a target bar's text into argv the way a shell would for the cases that
// actually come up here: quoted paths and quoted arguments. Not a shell parser
// (no expansion, no escapes beyond the quote pair) and deliberately so, since
// anything more elaborate belongs in the launch config's own "args" array.
function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "", q = "";
  for (const ch of s.trim()) {
    if (q) { if (ch === q) q = ""; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === " " || ch === "\t") { if (cur) { out.push(cur); cur = ""; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

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

export default function App() {
  // The header is one row and the target bar has first claim on it, so the state
  // readout is a short pill (`short`) with the full sentence on hover (`text`).
  // Anything that is guidance rather than state belongs in the console, where it
  // scrolls with the session instead of holding a strip of chrome forever.
  const [status, setStatus] = useState({ text: "connecting to the session…", short: "connecting", cls: "" });
  // Offline gets more than the status pill: a banner, because every control in
  // the app is a silent no-op until the socket comes back.
  const [offline, setOffline] = useState(false);
  // Everything the server pushes, folded by one pure reducer (session.ts).
  const [S, dispatch] = useReducer(sessionReducer, initialSession);
  const { program, sourcePath: srcPath, files, bps, stopLine, stopPath, frames, threads, tlocs,
          curTid, locals, phase, config: cfg, history: cfgHist, caps, selFrame, scopeRef,
          stopSeq, regions, adapterCmd, adapterId: dbgLabel, configError: configErr } = S;
  const registersRef = S.stop?.registersRef ?? 0;
  const [viewPath, setViewPath] = useState(""); // file currently displayed
  const [tabs, setTabs] = useState<string[]>([]);
  const tabLabel = useMemo(() => tabLabels(tabs), [tabs]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [tab, setTab] = useState<"term" | "mem" | "stack" | "regs" | "bin">("term");
  const [termShown, setTermShown] = useState<Set<TermKind>>(() => new Set<TermKind>(["prog", "repl"]));
  const toggleTerm = (k: TermKind) => {
    if (termHidden.has(k)) termHidden.delete(k); else termHidden.add(k);
    termRedraw(termRef.current);
    setTermShown(new Set<TermKind>((["prog", "adapter", "repl"] as TermKind[]).filter((x) => !termHidden.has(x))));
  };
  const [bottomH, setBottomH] = useState(240);
  const [asideW, setAsideW] = useState(340);
  // Opens only when there is nothing to run; a resolvable target goes straight to
  // the debug view. The gear reopens it.
  const [showConfig, setShowConfig] = useState(false);
  // Last thing another peer said it was doing, shown briefly in the toolbar.
  const [agentNote, setAgentNote] = useState<{ text: string; at: number } | null>(null);
  // Target bar: the toolbar's editable projection of config.program + config.args.
  const [targetText, setTargetText] = useState("");
  const [targetOpen, setTargetOpen] = useState(false);
  const targetFocused = useRef(false);
  const [binInfo, setBinInfo] = useState<any | null>(null);
  const [procs, setProcs] = useState<{ pid: number; name: string; cmd: string }[] | null>(null);
  const [procErr, setProcErr] = useState("");
  const [showInfo, setShowInfo] = useState(false);    // adapter + capabilities popover
  const [showMenu, setShowMenu] = useState(false);     // the header's "session ▾" menu
  const [stopMain, setStopMain] = useState(() => localStorage.getItem("dapweb.stopAtMain") !== "0");
  // Monotonic counters so re-clicking the same line still reveals it.
  const [jump, setJump] = useState({ line: 0, n: 0 });
  const [disasm, setDisasm] = useState<{ lines: Insn[]; pc: string } | null>(null);
  // Frame registers reported up from RegistersPanel — sp drives stack detection,
  // fp/lr let the memory view annotate saved-frame / return-address slots.
  const [regFrame, setRegFrame] = useState<{ sp: string; fp: string; lr: string }>({ sp: "", fp: "", lr: "" });
  const regSp = regFrame.sp;
  // Shared region classifier — one map+sp, used by both Registers and Memory so
  // a value's hue means the same thing in both. null until a map arrives.
  const classifyRegion = useMemo(
    () => (regions.length ? buildRegionClassifier(regions, regSp) : null),
    [regions, regSp]);
  const [bpEdit, setBpEdit] = useState<{ path: string; line: number; x: number; y: number } | null>(null);  // panel ✎ editor
  const [excSel, setExcSel] = useState<Set<string>>(new Set());
  const [excInit, setExcInit] = useState(false);
  const [mem, setMem] = useState<{ addr: string; bytes: Uint8Array } | null>(null);
  const [memAddr, setMemAddr] = useState("");
  const [memErr, setMemErr] = useState("");   // shown in the Memory pane, not the terminal

  const tidRef = useRef(-1);
  const sidRef = useRef("");      // current sessionId — a change means "new session, wipe state"
  // True only right after a fresh/new-session hello (terminal was cleared), so
  // replayed output history renders once; a same-session reconnect keeps its own
  // scrollback and drops the replay to avoid duplicating it.
  const acceptReplayRef = useRef(false);
  const frame0Ref = useRef(-1);   // frameId evals run in — follows the selected frame
  const frameReqRef = useRef(0);  // latest frameScopes id; stale frameLocals replies are dropped
  // Last banner state announced into the terminal ("none" | "nosrc" | "ok"), so a
  // repeated hello re-announces only when something actually changed.
  const announcedRef = useRef<string>("");
  const phaseRef = useRef(phase);
  const pendingRestart = useRef(false);           // kill+rerun fallback in flight
  const runRef = useRef<() => void>(() => {});    // ws handler needs a fresh run()
  // Live text of the drawer's config editor — THE config Run launches. Seeded
  // from hello.config, updated by every drawer edit; parsed only on Run.
  const cfgTextRef = useRef("");
  phaseRef.current = phase;
  const termRef = useRef<Terminal | null>(null);
  const watchesRef = useRef<Watch[]>([]);
  watchesRef.current = watches;
  const viewPathRef = useRef("");
  viewPathRef.current = viewPath;
  const bpsRef = useRef<Map<string, BpMeta>>(new Map());
  const srcPathRef = useRef("");   // ws handler ([] deps) needs the live source path on terminate
  srcPathRef.current = srcPath;
  const filesRef = useRef(files);
  filesRef.current = files;
  const capsRef = useRef(caps);
  capsRef.current = caps;
  const disasmOpenRef = useRef(false);
  disasmOpenRef.current = disasm !== null;
  // Cross-file jump lands once the file's source arrives.
  const pendJumpRef = useRef<{ path: string; line: number } | null>(null);

  // Debugger-side text into the merged terminal: REPL echo/results and adapter
  // failures. "in" = the echoed command (dim), "err" = failure (red), else the
  // REPL result (cyan). Program output takes the untagged path (pty / output).
  const consoleAppend = useCallback((text: string, cls = "") => {
    const t = termRef.current;
    if (cls === "err") writeTagged(t, "err", text, SGR.err, "");
    else if (cls === "in") writeTagged(t, "cmd", text, SGR.cmd, "");
    // Deliberately tagged and coloured unlike anything the debuggee or the
    // debugger prints: the whole point is that you can tell at a glance the
    // session moved because someone else moved it.
    else if (cls === "agent") writeTagged(t, "agent", text, SGR.agent, "◆ ");
    else writeTagged(t, "dbg", text, SGR.dbg, "");
  }, []);

  // Monaco hover → DAP evaluate(context:"hover") while stopped.
  // Hover → evaluate; if the result is an aggregate/pointer (ref>0), expand one
  // level so the tooltip can show its members instead of a bare "Shape[2]".
  // Expand one level, then expand each aggregate child in parallel, so a struct
  // of structs (or an array of them) arrives as a tree instead of a row of
  // `{…}` placeholders. Two levels only: the round trips are what a hover can
  // afford, and past that the Locals tree is the right tool.
  const HOVER_KID_BUDGET = 8;
  const expandTree = useCallback(async (ref: number, depth: number): Promise<HoverVar[]> => {
    const all: Var[] = await expandRef(ref).catch(() => []);
    const kids = all.filter((k) => !isSpecialVar(k.name));
    if (depth <= 0) return kids;
    const grand = await Promise.all(kids.slice(0, HOVER_KID_BUDGET).map((k) =>
      k.ref > 0 ? expandTree(k.ref, depth - 1).catch(() => []) : Promise.resolve([])));
    return kids.map((k, i) => (grand[i]?.length ? { ...k, children: grand[i] } : k));
  }, []);

  const evalHover = useCallback((expr: string) => new Promise<HoverInfo | null>((resolve) => {
    if (phaseRef.current !== "stopped") return resolve(null);
    const id = request({ cmd: "evaluate", expr, context: "hover", frameId: frame0Ref.current }, (m) => {
      if (m.error || m.value == null) return resolve(null);
      if (m.ref > 0) expandTree(m.ref, 1).then(
        (kids) => resolve({ value: m.value, children: kids }),
        () => resolve({ value: m.value }));
      else resolve({ value: m.value });
    });
    // Two levels of expansion is more round trips than one, so the tooltip gets
    // longer to arrive; Monaco simply shows nothing if we miss the window.
    setTimeout(() => { if (pending.delete(id)) resolve(null); }, 3500);
  }), [expandTree]);

  const fetchDisasm = useCallback((pc: string) => {
    request({ cmd: "disassemble", memoryReference: pc }, (m) => {
      if (m.instructions?.length) setDisasm({ lines: m.instructions, pc });
    });
  }, []);
  // fetch a disassembly window around a frame's pc.
  const requestDisasm = useCallback((f: Frame) => {
    const c = capsRef.current;
    if (Object.keys(c).length > 0 && !c.supportsDisassembleRequest) return;
    if (!f.ipRef) return;
    fetchDisasm(f.ipRef);
  }, []);

  const evalWatch = useCallback((expr: string) => {
    request({ cmd: "evaluate", expr, context: "watch", frameId: frame0Ref.current }, (m) =>
      setWatches((wsx) => wsx.map((w) => (w.expr === expr ? { ...w, value: m.value } : w))));
  }, []);
  const evalWatches = useCallback(() => { watchesRef.current.forEach((w) => evalWatch(w.expr)); }, []);

  // edit a variable; resolves with the adapter's formatted new value, or
  // null on failure/timeout (the node reverts). Watches re-evaluate on success.
  const setVar = useCallback((parentRef: number, name: string, value: string) =>
    requestWithin({ cmd: "setVar", ref: parentRef, name, value }, 3000, null, (m) => {
      if (m.error) consoleAppend(`setVariable failed: ${m.value}\n`, "err");
      return m.error ? null : m;
    }).then((r) => { if (r) evalWatches(); return r; }), [evalWatches]);

  // fetch + show a memory window in the Memory tab.
  const viewMemory = useCallback((addr: string) => {
    setMemAddr(addr);
    setMemErr("");
    setTab("mem");
    request({ cmd: "readMem", memoryReference: addr, count: 256 }, (m) => {
      const bytes = memBytes(m);
      // 0x0 / unmapped pages: lldb-dap replies success-but-empty (no error
      // field, no data). Report it in the Memory pane: the user is looking
      // there, not at the terminal.
      if (!bytes) {
        setMemErr(`can't read memory at ${addr}${m.error ? `: ${m.error}` : " — no readable bytes (unmapped?)"}`);
      } else {
        setMemErr("");
        setMem({ addr: m.address || addr, bytes });
      }
    });
  }, []);
  const memLinks = !!caps.supportsReadMemoryRequest;

  // switch to (and lazily load) a file tab.
  const openFile = useCallback((path: string, jumpLine?: number) => {
    if (jumpLine) pendJumpRef.current = { path, line: jumpLine };
    if (filesRef.current.has(path)) {
      setViewPath(path);
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      if (jumpLine) { setJump((j) => ({ line: jumpLine, n: j.n + 1 })); pendJumpRef.current = null; }
    } else {
      send({ cmd: "openSource", path });
    }
  }, []);

  useEffect(() => {
    let gone = false;   // effect torn down — don't reconnect after unmount
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | null = null;
    const connect = () => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    setSocket(ws);
    ws.onopen = () => {
      if (retries > 0) consoleAppend("reconnected to the dapweb server\n");
      retries = 0; setOffline(false);
      setStatus({ text: "ready — set breakpoints, then Run", short: "ready", cls: "" });
    };
    // The server session survives disconnects and replays full state on
    // rejoin, so a dropped socket is always worth retrying.
    ws.onclose = () => {
      if (gone) return;
      const delay = Math.min(500 * 2 ** retries, 5000);
      // Once per outage, not per retry: the banner covers the ongoing state.
      if (retries === 0) consoleAppend("lost connection to the dapweb server, reconnecting…\n", "err");
      retries++;
      setOffline(true);
      setStatus({ text: "disconnected — reconnecting…", short: "offline", cls: "offline" });
      timer = setTimeout(connect, delay);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      // Session state first; what follows is only what the reducer cannot do:
      // the terminal, the editor tabs, the URL, and routing RPC replies.
      dispatch(m);
      if (routeReply(m)) return;
      if (m.type === "hello") {
        setViewPath(m.sourcePath || "");
        setDbgTag(m.adapterId || "debugger");
        setTabs(m.sourcePath ? [m.sourcePath] : []);
        setDisasm(null);
        // seed the live run text so Run works even before the drawer editor mounts.
        if (!cfgTextRef.current) cfgTextRef.current = JSON.stringify(m.config || {}, null, 2);
        // A different sessionId is a genuinely new session (newSession command
        // or server restart): wipe everything a same-session reconnect would
        // have replayed. A rejoin replay repopulates via bpSync/stopped/etc.
        const fresh = !!m.sessionId && m.sessionId !== sidRef.current;
        acceptReplayRef.current = fresh;   // only a cleared terminal renders replay
        if (fresh) {
          sidRef.current = m.sessionId;
          setWatches([]);
          setMem(null); setMemAddr(""); setMemErr("");
          termClear(termRef.current);
          // The banner below only prints when the state CHANGES, and clearing the
          // terminal just erased whatever it last printed. Without this, a new
          // session that happens to land in the same state as the old one comes
          // up with an empty terminal and no explanation in it.
          announcedRef.current = "";
        }
        // Session identity in the URL: shareable, and a reload/reconnect can
        // tell "same session" from "server restarted" (state resets either way).
        if (m.sessionId) {
          const u = new URL(location.href);
          u.searchParams.set("s", m.sessionId);
          history.replaceState(null, "", u);
        }
        // joining a live shared session — a stopped replay may refine this.
        if (m.phase === "running") setStatus({ text: "joined a live session already in progress", short: "running", cls: "running" });
        // History is server-owned: run the one-shot localStorage → server
        // migration and retire the client-local store.
        try {
          const legacy = localStorage.getItem("dapweb.configHistory");
          if (legacy) {
            const entries = JSON.parse(legacy);
            if (Array.isArray(entries) && entries.length) send({ cmd: "importHistory", entries });
            localStorage.removeItem("dapweb.configHistory");
          }
        } catch {}
        // A hello now arrives on every target change, not only on connect, so
        // this announces the STATE and not the message: re-printing the same
        // banner into the terminal on each retarget is how one config edit
        // turned into three identical lines. Boot restore is server-side (it
        // stages history[0]), so an unconfigured session here really has
        // nothing to restore, and the sheet is the task.
        const cfgNow = m.config || {};
        const state = !hasTarget(cfgNow, m.program) ? "none" : (!m.sourcePath ? "nosrc" : "ok");
        if (state !== announcedRef.current) {
          announcedRef.current = state;
          if (state === "none") {
            setShowConfig(true);
            setStatus({ text: "no debug target configured", short: "no target", cls: "warn" });
            consoleAppend("no debug target yet — type a program in the bar at the top left, or open Session ▸ Configure target for the full launch config\n");
          } else if (state === "nosrc") {
            // An attach has no main to stop at, so it must not be promised one.
            const where = cfgNow.request === "attach" ? "stops on attach" : "stops at main";
            setStatus({ text: `no source configured — Run ${where} and loads it`, short: "no source", cls: "" });
            consoleAppend(`no source configured — Run ${where} and loads whatever file the first frame names\n`);
          }
        }
      }
      // Another peer (dapweb api, an agent) announced a command before running
      // it. Surface it in the console and flash it in the toolbar, so a stop the
      // user did not ask for is never unexplained.
      else if (m.type === "activity") {
        consoleAppend(`${m.text}\n`, "agent");
        setAgentNote({ text: m.text, at: Date.now() });
      }
      else if (m.type === "source") {
        if (m.path) {
          setTabs((t) => (t.includes(m.path) ? t : [...t, m.path]));
          setViewPath(m.path);
          const pj = pendJumpRef.current;
          if (pj && pj.path === m.path) {
            setJump((j) => ({ line: pj.line, n: j.n + 1 }));
            pendJumpRef.current = null;
          }
        }
      }
      else if (m.type === "threads") {
        // Top frame per thread for the panel (id-correlated fetches: they
        // don't touch the user's thread/frame selection).
        for (const t of m.threads || []) {
          request({ cmd: "threadStack", tid: t.id }, (r) => {
            const f = r.frames?.[0];
            if (f) dispatch({ type: "local/tloc", tid: t.id, label: `${f.name}:${f.line}`, pc: f.ipRef || "" });
          });
        }
      }
      else if (m.type === "stopped") {
        tidRef.current = m.tid;
        frame0Ref.current = m.frames?.[0]?.id ?? -1;
        const f0 = m.frames?.[0];
        const sp = (f0?.path || m.path || "");
        // The server's source-push dedup tracks only what *it* last sent; make
        // sure we have and show the stop file (real source only — pseudo-paths
        // get disassembly instead, and keep the last real file in the editor).
        if (hasSrc(sp)) {
          if (!filesRef.current.has(sp)) send({ cmd: "openSource", path: sp });
          else setViewPath(sp);
          setTabs((t) => (t.includes(sp) ? t : [...t, sp]));
        }
        setStatus(stopStatus(stopOf(m)));
        // Keep the asm pane live across steps; auto-open it for no-source frames.
        if (f0 && (!hasSrc(f0.path) || disasmOpenRef.current) && f0.ipRef) requestDisasm(f0);
        else setDisasm(null);
        evalWatches();
      } else if (m.type === "output") {
        // Replayed history: render only when we just cleared for a fresh
        // session; a same-session reconnect kept its scrollback → drop dupes.
        if (m.replay && !acceptReplayRef.current) return;
        writeOutput(termRef.current, m.category, m.text);
      }
      else if (m.type === "ptyData") termPut(termRef.current, "prog", m.data);
      else if (m.type === "restartFailed") {
        pendingRestart.current = true;
        send({ cmd: "kill" });
      }
      else if (m.type === "terminated") {
        setDisasm(null);
        // Return the pane to the program's source; leaving a dead no-source
        // (dyld/libc) frame in viewPath strands the "disassembling…" placeholder.
        // With no configured source (a bare `dapweb ./prog`), the file the run
        // stopped in is the best thing to show; a pseudo-path is not.
        setViewPath(srcPathRef.current || (hasSrc(viewPathRef.current) ? viewPathRef.current : ""));
        if (pendingRestart.current) {
          pendingRestart.current = false;
          runRef.current();
          return;
        }
        const code: number | undefined = typeof m.exitCode === "number" ? m.exitCode : undefined;
        const ex = exitLabel(code);
        setStatus({ text: `${ex}: press Run again to start it over`, short: ex, cls: code === 0 ? "done" : "" });
        termPut(termRef.current, "repl", "\r\n\x1b[2m[dapweb] session ended, press Run again to start over\x1b[0m\r\n");
      }
    };
    };
    connect();
    // Throttled: a burst of clicks (or hover evals) while down is one line.
    let lastDrop = 0;
    setOnSendWhileDead(() => {
      const now = Date.now();
      if (now - lastDrop < 2000) return;
      lastDrop = now;
      consoleAppend("offline: command not sent, still reconnecting…\n", "err");
    });
    return () => { gone = true; clearTimeout(timer); setOnSendWhileDead(null); ws?.close(); };
  }, []);

  // Default exception filters on once when capabilities first arrive.
  useEffect(() => {
    const filters = caps.exceptionBreakpointFilters;
    if (!excInit && Array.isArray(filters) && filters.length) {
      const def = new Set<string>(filters.filter((f: any) => f.default).map((f: any) => f.filter));
      setExcSel(def);
      setExcInit(true);
      send({ cmd: "setExceptions", filters: [...def] });
    }
  }, [caps, excInit]);

  // None of these touch `bps` — the server's echo is the only writer. It
  // canonicalises the path (cwd-relative → absolute, "." / ".." collapsed) and
  // every peer keys on that spelling, so an optimistic insert under the path we
  // happened to be viewing made one gutter click two identical rows in the
  // panel, and no ack could ever remove the stray one. The echo is one local
  // websocket hop away.
  const toggleBp = (ln: number) => {
    const path = viewPathRef.current;
    if (bpsRef.current.has(bpKey(path, ln))) send({ cmd: "clearBreakpoint", path, line: ln });
    else send({ cmd: "setBreakpoint", path, line: ln });
  };

  // upsert a breakpoint with condition/hitCondition/logMessage (server
  // treats setBreakpoint on an existing line as a replace).
  const setBpMetaAt = (path: string, ln: number, meta: BpMeta) =>
    send({ cmd: "setBreakpoint", path, line: ln, ...meta });
  const setBpMeta = (ln: number, meta: BpMeta) => setBpMetaAt(viewPathRef.current, ln, meta);

  const removeBp = (path: string, ln: number) => send({ cmd: "clearBreakpoint", path, line: ln });

  // Enable/disable keeps the bp in the list; the server omits disabled ones
  // from the DAP request (absent = enabled, DAP has no per-bp enable).
  const setBpEnabled = (path: string, ln: number, meta: BpMeta) => {
    const nm: BpMeta = { ...meta };
    if (nm.enabled === false) delete nm.enabled; else nm.enabled = false;
    send({ cmd: "setBreakpoint", path, line: ln, ...nm });
  };
  const bpEntries = () => [...bps.entries()].map(([k, m]) => {
    const i = k.indexOf("\n");
    return { path: k.slice(0, i), line: Number(k.slice(i + 1)), meta: m };
  });
  bpsRef.current = bps;
  const anyBpEnabled = [...bps.values()].some((m) => m.enabled !== false);
  const toggleAllBps = () => {
    for (const { path, line, meta } of bpEntries()) {
      if ((meta.enabled !== false) === anyBpEnabled) setBpEnabled(path, line, meta);
    }
  };
  const clearAllBps = () => { for (const { path, line } of bpEntries()) removeBp(path, line); };

  // Locals of the selected frame. Clicking frames quickly races their replies,
  // so only the latest request may land.
  const loadFrameLocals = (frameId: number) => {
    const id = request({ cmd: "frameScopes", frameId }, (m) => {
      if (frameReqRef.current === id)
        dispatch({ type: "local/frameLocals", vars: m.vars || [], scopeRef: m.scopeRef || 0 });
    });
    frameReqRef.current = id;
  };

  // click a stack frame → show its file+line, scope locals and evals to it.
  const selectFrame = (i: number) => {
    if (phaseRef.current !== "stopped") return;
    const f = frames[i];
    if (!f) return;
    dispatch({ type: "local/selectFrame", i });
    frame0Ref.current = f.id;
    if (hasSrc(f.path)) openFile(f.path);
    if (!hasSrc(f.path) || disasmOpenRef.current) requestDisasm(f); else setDisasm(null);
    loadFrameLocals(f.id);
    evalWatches();
  };

  // click a thread → show its stack, retarget stepping/evals to it.
  // The frames reply drives the same frame-0 selection flow selectFrame uses.
  const selectThread = (t: Thread) => {
    if (phaseRef.current !== "stopped" || t.id === curTid) return;
    tidRef.current = t.id;
    dispatch({ type: "local/selectThread", tid: t.id });
    request({ cmd: "threadStack", tid: t.id }, (m) => {
      const fs: Frame[] = m.frames || [];
      dispatch({ type: "local/threadFrames", frames: fs });
      const f0 = fs[0];
      if (!f0) return;
      frame0Ref.current = f0.id;
      if (hasSrc(f0.path)) openFile(f0.path, f0.line);
      if (!hasSrc(f0.path) || disasmOpenRef.current) requestDisasm(f0); else setDisasm(null);
      loadFrameLocals(f0.id);
      evalWatches();
    });
  };

  // Run = parse the drawer's live JSON and launch it. A live session asks for
  // confirmation, then force-kills and relaunches (server tears down first).
  // The bar is a projection of the config, so the config wins except while the
  // user is mid-edit; clobbering someone's half-typed path would be maddening.
  // "attach" is a mode of the same bar, not a separate screen: the config's own
  // `request` key is the state, so flipping the chip and editing the JSON by hand
  // can never disagree.
  const attachMode = cfg.request === "attach";
  // lldb spells it `pid`, debugpy and delve spell it `processId`. The UI writes
  // the dialect's own key rather than having the server translate, because the
  // config is meant to be a verbatim launch.json: what you read in the sheet has
  // to be exactly what goes to the adapter.
  const pidKeyFor = (t?: string) => (t === "python" || t === "go" || t === "node") ? "processId" : "pid";
  const targetLabel = attachMode
    ? String(cfg[pidKeyFor(cfg.type)] ?? cfg.program ?? "")
    : [cfg.program || "", ...((cfg.args as string[]) || [])].join(" ").trim();
  useEffect(() => { if (!targetFocused.current) setTargetText(targetLabel); }, [targetLabel]);

  // Editing the bar edits program+args inside the launch config; every other key
  // the user set in the Advanced sheet survives untouched.
  const readCfg = (): any => {
    try { return JSON.parse(stripJsonc(cfgTextRef.current) || "{}"); } catch { return { ...cfg }; }
  };
  // A committed target is server state, not browser state. Pushing it is what
  // puts it in the other peers' bars and in history, so a target you configured
  // and never got around to running is still there on the next boot instead of
  // being lost with the tab. Idle-only, mirroring the server (retargeting a live
  // session needs a force-Run), and only once the config actually names a target:
  // the server rejects a half-built one, and flipping the attach chip should not
  // raise an error about the pid you have not typed yet.
  const pushCfg = (c: any) => {
    const live = phaseRef.current === "running" || phaseRef.current === "stopped";
    // hasTarget mirrors the server's validity rule, so flipping the attach chip
    // — which keeps the program and drops the pid — stays silent instead of
    // pushing something the server answers with "attach needs a target".
    if (!live && hasTarget(c)) send({ cmd: "setConfig", ...c });
  };
  const writeCfg = (c: any) => { cfgTextRef.current = JSON.stringify(c, null, 2); dispatch({ type: "local/config", config: c }); pushCfg(c); };

  const applyTarget = (text: string) => {
    const c = readCfg();
    if (attachMode) {
      const t = text.trim();
      if (!t) return;
      // Drop every spelling first: switching `type` must not leave a stale pid
      // key behind for the adapter to trip over.
      delete c.pid; delete c.processId;
      if (/^[0-9]+$/.test(t)) c[pidKeyFor(c.type)] = Number(t);
      else c.program = t;   // lldb attaches to a running process by name
      writeCfg(c);
      return;
    }
    const parts = shellSplit(text);
    if (!parts.length) return;
    c.program = parts[0];
    if (parts.length > 1) c.args = parts.slice(1); else delete c.args;
    writeCfg(c);
  };

  const setMode = (attach: boolean) => {
    const c = readCfg();
    if (attach) { c.request = "attach"; delete c.args; }
    else { delete c.request; delete c.pid; delete c.processId; }
    writeCfg(c);
    setTargetText("");
    // The chip preventDefaults mousedown so the input keeps focus, which means
    // focus never fires again and the picker would sit on its placeholder
    // forever. Kick the load from here instead of relying on onFocus.
    if (attach) { setProcs(null); loadProcs(); setTargetOpen(true); }
    else { setProcs(null); setProcErr(""); setTargetOpen(false); }
  };

  const loadProcs = () => {
    setProcErr("");
    fetch("/api/processes").then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404
        ? "this server cannot list processes (built before /api/processes) — type a pid"
        : `server returned ${r.status}`);
      return r.json();
    }).then((d) => setProcs(d.processes || []))
      .catch((e) => { setProcs([]); setProcErr(e.message || String(e)); });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setShowConfig(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The toast is a nudge, not a log: the console keeps every line permanently.
  useEffect(() => {
    if (!agentNote) return;
    const t = setTimeout(() => setAgentNote(null), 6000);
    return () => clearTimeout(t);
  }, [agentNote]);

  const loadBinInfo = useCallback(() => {
    setBinInfo(null);
    // A server too old for this endpoint answers a plain-text 404, so check the
    // status before parsing: a raw SyntaxError in the pane explains nothing.
    fetch("/api/binfo").then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404
        ? "this server does not support binary inspection (built before /api/binfo)"
        : `server returned ${r.status}`);
      return r.json();
    }).then(setBinInfo).catch((e) => setBinInfo({ error: e.message || String(e) }));
  }, []);

  // Read whenever the target changes, not when the tab is opened: the answer
  // decides whether the tab is offered at all, and a rebuild between two runs is
  // exactly when "no debug info" starts or stops being true.
  useEffect(() => {
    if (program) loadBinInfo();
    else setBinInfo(null);
  }, [program, loadBinInfo]);

  // A python script or a jar is a file, not a native binary: binfo can only
  // answer "unknown format", and a permanent tab saying "rebuild with -g" about
  // a .py is worse than no tab. A file that is missing or unreadable still gets
  // one — that IS the diagnosis.
  const binTab = !!binInfo && (!!binInfo.error || binInfo.exists === false || binInfo.format !== "unknown");

  // A tab whose adapter can no longer serve it must not leave the pane blank:
  // retargeting from lldb to debugpy takes readMemory away mid-session.
  useEffect(() => {
    if (!memLinks && (tab === "mem" || tab === "stack")) setTab("term");
    if (!binTab && tab === "bin") setTab("term");
  }, [memLinks, binTab, tab]);

  const run = () => {
    let config: any = undefined;
    const text = stripJsonc(cfgTextRef.current).trim();  // config dialect is JSONC (launch.json)
    if (text) {
      try { config = JSON.parse(text); }
      catch (e: any) { dispatch({ type: "local/configError", error: `invalid JSON: ${e.message}` }); setShowConfig(true); return; }
    }
    const force = phaseRef.current === "running" || phaseRef.current === "stopped";
    // Retargeting is the destructive surprise: you meant to launch something else
    // and the running session goes with it. Re-running the SAME target is exactly
    // what Restart does without asking, so Run should not ask either.
    const retarget = force && !!config && (config.program ?? "") !== (cfg.program ?? "");
    if (retarget && !confirm(`Switch this session to ${config.program} ? The running program is killed first.`)) return;
    dispatch({ type: "local/configError", error: "" });
    dispatch({ type: "local/resumed" });
    setStatus({ text: force ? "restarting with the new target…" : "running…", short: "running", cls: "running" });
    send({ cmd: "run", stopAtMain: stopMain, ...(config ? { config } : {}), ...(force ? { force: true } : {}) });
    termRef.current?.focus();
  };
  runRef.current = run;
  // always try the native restart request (lldb-dap handles it but never
  // advertises supportsRestartRequest); a restartFailed reply triggers the
  // kill+rerun fallback (e.g. debugpy).
  const restart = () => {
    if (phase !== "running" && phase !== "stopped") return;
    dispatch({ type: "local/resumed" });
    setStatus({ text: "restarting…", short: "restarting", cls: "running" });
    send({ cmd: "restart" });
  };
  const resume = (cmd: string, granularity?: string) => {
    dispatch({ type: "local/resumed" });
    setStatus({ text: "running…", short: "running", cls: "running" });
    send({ cmd, tid: tidRef.current, ...(granularity ? { granularity } : {}) });
  };
  // VS Code's debug keys. Read through a ref so the one window listener always
  // sees this render's phase and actions.
  const debugKeyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  debugKeyRef.current = (e) => {
    const live = phase === "running" || phase === "stopped";
    const k = (e.shiftKey ? "S-" : "") + (e.ctrlKey || e.metaKey ? "C-" : "") + e.key;
    switch (k) {
      case "F5": if (phase === "stopped") resume("continue"); else if (!live) run(); else return false; return true;
      case "S-F5": if (live) send({ cmd: "kill" }); return live;
      case "S-C-F5": restart(); return live;
      case "F6": if (phase === "running") send({ cmd: "pause", tid: tidRef.current }); return phase === "running";
      case "F10": if (phase === "stopped") resume("stepOver"); return phase === "stopped";
      case "F11": if (phase === "stopped") resume("stepIn"); return phase === "stopped";
      case "S-F11": if (phase === "stopped") resume("stepOut"); return phase === "stopped";
    }
    return false;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // A text field or the terminal owns its keys (a program reading stdin may
      // want F5). The source view is a read-only monaco whose hidden textarea
      // holds focus after any click in it, so it is exempt, as in VS Code.
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "SELECT" ||
                (t.tagName === "TEXTAREA" && !t.closest(".source-wrap")))) return;
      if (debugKeyRef.current(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const stopped = phase === "stopped";
  const asm = useMemo(() => (disasm ? buildAsm(disasm) : null), [disasm]);
  // Inline-asm mode: render each source line's instructions under it (view zones
  // in the main SourceView) instead of the side-by-side pane.
  const [inlineAsm, setInlineAsm] = useState(false);
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
  const excFilters: any[] = Array.isArray(caps.exceptionBreakpointFilters) ? caps.exceptionBreakpointFilters : [];
  const srcText = files.get(viewPath) ?? "";
  const viewBps = useMemo(() => {
    const out = new Map<number, BpMeta>();
    bps.forEach((meta, k) => {
      const [p, ln] = [k.slice(0, k.indexOf("\n")), Number(k.slice(k.indexOf("\n") + 1))];
      if (p === viewPath) out.set(ln, meta);
    });
    return out;
  }, [bps, viewPath]);
  const canInstrStep = stopped && !!caps.supportsSteppingGranularity && !!asm;
  const targetSet = hasTarget(cfg, program || undefined);
  const primary = primaryAction({ phase, hasTarget: targetSet, attach: attachMode });

  return (
    <div className="app">
      <header>
        {/* The wordmark goes to the other screen. Sending it off to GitHub would
            make the one always-present, always-clickable thing in the app a way
            to leave the app. */}
        <a className="logo" href="/sessions" data-tip="All live dapweb sessions">
          <Mark /><span>dapweb</span>
        </a>
        <span className="targetbar">
          <select className={"mode-select" + (attachMode ? " attach" : "")} value={cfg.request || "launch"}
                  data-tip={attachMode ? "Attaching to a process that is already running"
                                    : "Launching a program from a path"}
                  onChange={(e) => setMode(e.target.value === "attach")}>
            <option value="launch">launch</option>
            <option value="attach">attach</option>
          </select>
          <input className="target-input" value={targetText} spellCheck={false}
                 placeholder={attachMode ? "pid, or a process name" : "path to a program, plus arguments"}
                 data-tip={cfg.port ? `tcp: ${cfg.host || "127.0.0.1"}:${cfg.port}` : (adapterCmd ? `adapter: ${adapterCmd}` : "")}
                 onChange={(e) => setTargetText(e.target.value)}
                 onFocus={() => { targetFocused.current = true; setTargetOpen(true); if (attachMode) loadProcs(); }}
                 onBlur={() => { targetFocused.current = false; setTimeout(() => setTargetOpen(false), 120); }}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") {
                     applyTarget(targetText); setTargetOpen(false);
                     (e.target as HTMLInputElement).blur();
                     runRef.current?.();
                   } else if (e.key === "Escape") {
                     setTargetText(targetLabel); (e.target as HTMLInputElement).blur();
                   }
                 }} />
          {targetOpen && attachMode && (
            <div className="target-menu">
              {procErr && <div className="target-note">{procErr}</div>}
              {!procs && !procErr && <div className="target-note">reading process list…</div>}
              {(procs || [])
                .filter((pr) => !targetText.trim() ||
                                String(pr.pid).startsWith(targetText.trim()) ||
                                (pr.cmd || pr.name || "").toLowerCase().includes(targetText.trim().toLowerCase()))
                .slice(0, 200)
                .map((pr) => (
                  <div key={pr.pid} className="target-item"
                       onMouseDown={(e) => { e.preventDefault(); setTargetText(String(pr.pid)); applyTarget(String(pr.pid)); setTargetOpen(false); }}>
                    <span className="proc-pid">{pr.pid}</span>{pr.cmd || pr.name}
                  </div>
                ))}
            </div>
          )}
          {targetOpen && !attachMode && cfgHist.length > 0 && (
            <div className="target-menu">
              {cfgHist.map((h, i) => {
                const label = [h.program || "", ...((h.args as string[]) || [])].join(" ").trim();
                return (
                  <div key={i} className="target-item"
                       onMouseDown={(e) => { e.preventDefault(); setTargetText(label); applyTarget(label); setTargetOpen(false); }}>
                    {h.type && <span className={"hist-type dt-" + h.type}>{h.type}</span>}{label}
                  </div>
                );
              })}
            </div>
          )}
        </span>
        <span className="toolbar">
          <button className="primary" disabled={primary.disabled} data-tip={primary.tip}
                  onClick={() => {
                    if (primary.kind === "continue") resume("continue");
                    else if (primary.kind === "pause") send({ cmd: "pause", tid: tidRef.current });
                    else run();
                  }}>
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
          <button disabled={!stopped || !caps.supportsDisassembleRequest}
                  className={asm && !inlineAsm ? "asm-on" : ""}
                  data-tip={stopped ? "Disassembly: show machine code beside the source"
                                 : "Disassembly (available while stopped, adapter must support it)"}
                  onClick={() => {
                    if (disasm) { setDisasm(null); setInlineAsm(false); }
                    else {
                      // Selected frame's pc, or the nearest frame that has one.
                      const f = frames[selFrame]?.ipRef ? frames[selFrame] : frames.find((x) => x.ipRef);
                      if (f) requestDisasm(f);
                    }
                  }}><Ico g={CI.chip} /></button>
          <button disabled={!stopped || !caps.supportsDisassembleRequest}
                  className={inlineAsm ? "asm-on" : ""}
                  data-tip="Inline disassembly: show each source line's machine code under it"
                  onClick={() => {
                    if (inlineAsm) { setInlineAsm(false); setDisasm(null); }
                    else {
                      setInlineAsm(true);
                      const f = frames[selFrame]?.ipRef ? frames[selFrame] : frames.find((x) => x.ipRef);
                      if (f) requestDisasm(f);
                    }
                  }}><Ico g={CI.chip} sub="s" /></button>
        </span>
        {/* One toggle, two honest names: attaching to a process that is already
            running cannot stop at main, so there it means "hold it where it is". */}
        <label className="stopmain" data-tip={attachMode
          ? "hold the process where it is on Attach, instead of resuming it"
          : "break at main (python: first user line) on Run"}>
          <input type="checkbox" checked={stopMain} onChange={(e) => {
            setStopMain(e.target.checked);
            localStorage.setItem("dapweb.stopAtMain", e.target.checked ? "1" : "0");
          }} /> {attachMode ? "stop on attach" : "stop at main"}
        </label>
        {agentNote && <span className="agent-note" data-tip={agentNote.text}>◆ {agentNote.text}</span>}
        <span className={"status " + status.cls} data-tip={status.text}>{status.short}</span>
        {/* Three unlabelled glyphs (ⓘ, +, ⚙) asked the reader to remember which
            was which. One labelled menu says what it opens, and has room for the
            things that had nowhere to live — like the list of other sessions. */}
        <span className="menu-wrap">
          <button className="menu-btn" onClick={() => setShowMenu((v) => !v)}>
            session <span className="menu-caret">▾</span>
          </button>
          {showMenu && (
            <>
              <div className="menu-backdrop" onClick={() => setShowMenu(false)} />
              <div className="menu-pop">
                <button className="menu-item" onClick={() => { setShowMenu(false); setShowConfig(true); }}>
                  Configure target… <span className="menu-hint">launch.json</span>
                </button>
                <button className="menu-item" onClick={() => { setShowMenu(false); setShowInfo(true); }}
                        disabled={Object.keys(caps).length === 0}>
                  Session info <span className="menu-hint">{dbgLabel || "—"}</span>
                </button>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => {
                  setShowMenu(false);
                  if ((phase === "running" || phase === "stopped") && !confirm("End the current debug session and start a new one?")) return;
                  send({ cmd: "newSession" });
                }}>New session <span className="menu-hint">keeps the target</span></button>
                <a className="menu-item" href="/sessions" onClick={() => setShowMenu(false)}>
                  All sessions… <span className="menu-hint">every live server</span>
                </a>
              </div>
            </>
          )}
        </span>
        {showInfo && (
          <>
            <div className="menu-backdrop" onClick={() => setShowInfo(false)} />
            <div className="info-pop">
              <div className="info-line"><span className="info-k">adapter</span> {dbgLabel}{adapterCmd ? ` — ${adapterCmd}` : ""}</div>
              <div className="info-line"><span className="info-k">session</span> {sidRef.current || "—"}</div>
              <details>
                <summary>capabilities</summary>
                <div className="caps-list">
                  {Object.keys(caps).filter((k) => caps[k] === true).sort()
                    .map((k) => <span key={k} className="cap">{k.replace(/^supports/, "")}</span>)}
                </div>
              </details>
            </div>
          </>
        )}
      </header>
      {offline && <div className="offline-banner">disconnected from the dapweb server: nothing you click will reach the session until it reconnects</div>}
      {/* main + the terminal are one workspace, and the target sheet overlays the
          whole of it. Living inside <main> it was capped at whatever height the
          terminal left over — about 360px — which is two form fields and a
          scrollbar. */}
      <div className="workspace">
      <main>
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
                if (!targetSet) return (
                  <div className="src-empty">
                    <div className="src-empty-title">Nothing to debug yet</div>
                    <div>Type a program path in the target bar above and press Enter,</div>
                    <div>or start dapweb with one: <code>dapweb /path/to/binary</code></div>
                  </div>
                );
                return (
                  <div className="src-hint">
                    {stopped ? (caps.supportsDisassembleRequest ? "disassembling…" : "no source available for this frame")
                      : attachMode ? "Run attaches and opens the source where the process stops"
                      : stopMain ? "Run stops at main and opens its source here"
                      : "no source configured: tick stop at main and Run to open it here"}
                  </div>
                );
              }
              return (
                <>
                  <SourceView text={srcText} lang={langFor(viewPath)} bps={viewBps}
                              stopLine={viewPath === stopPath ? stopLine : 0}
                              onToggle={toggleBp} onSetMeta={setBpMeta} onHoverEval={evalHover}
                              caps={caps} jump={jump}
                              asmByLine={inlineAsm && viewPath === stopPath ? asmByLine : undefined}
                              asmPc={disasm?.pc} />
                  {asm && !inlineAsm && asmPane}
                </>
              );
            })()}
          </div>
        </div>
        <AsideDrag onResize={(w) => setAsideW(w)} />
        <div className="aside" style={{ width: asideW }}>
          {/* Ordered by how often a stop sends you there: the values first, then
              where you are, then what you asked to see. */}
          <Panel title="Locals" persist="dapweb.localsCollapsed">
            <VarList vars={locals} disabled={!stopped} parentRef={scopeRef}
                     empty={stopped ? "no locals in this frame" : "run to a breakpoint to see local variables"}
                     onSetVar={caps.supportsSetVariable ? setVar : undefined}
                     onAddr={memLinks ? viewMemory : undefined} />
          </Panel>
          <Panel title="Call Stack" persist="dapweb.stackCollapsed" badge={frames.length || null}>
            {frames.length
              ? frames.map((f, i) => (
                  <div key={i} className={"frame" + (i === selFrame ? " top" : "")}
                       title={f.path || "no source"} onClick={() => selectFrame(i)}>
                    #{i} {f.name}:{f.line}
                  </div>
                ))
              : <span className="hint">{stopped ? "no frames" : "run to a breakpoint to see the call stack"}</span>}
          </Panel>
          <Panel title="Watch" persist="dapweb.watchCollapsed" badge={watches.length || null} action={<button className="addbtn" onClick={() => {
            const expr = prompt("watch expression:");
            if (!expr) return;
            setWatches((w) => [...w, { expr, value: null }]);
            if (stopped) setTimeout(() => evalWatch(expr));
          }}>+</button>}>
            {watches.length
              ? watches.map((w, i) => (
                  <div key={i} className="wrow">
                    <span className="expr">{w.expr}</span>
                    <span className="wval"><Val text={w.value ?? "—"} onAddr={memLinks ? viewMemory : undefined} /></span>
                    <span className="rm" onClick={() => setWatches((x) => x.filter((_, j) => j !== i))}>✕</span>
                  </div>
                ))
              : <span className="hint">no expressions: + adds one, evaluated at every stop</span>}
          </Panel>
          <Panel title="Breakpoints" persist="dapweb.bpsCollapsed" badge={bps.size || null} action={bps.size > 0 && (
            <span className="bpacts">
              <button className="addbtn" title={anyBpEnabled ? "disable all" : "enable all"}
                      onClick={toggleAllBps}>⊘</button>
              <button className="addbtn" title="remove all" onClick={clearAllBps}>✕</button>
            </span>
          )}>
            <BpList bps={bps} files={files} onJump={(p, ln) => openFile(p, ln)} onRemove={removeBp} onToggle={setBpEnabled}
                    onEdit={(path, line, x, y) => setBpEdit({ path, line, x, y })} />
          </Panel>
          {threads.length > 0 && (
            // One thread has nothing to choose between, so it starts folded to its
            // count; Panel reads the default only on mount, which is each new stop
            // after a run ends (threads empties on terminate).
            <Panel title="Threads" persist="dapweb.threadsCollapsed"
                   defaultCollapsed={threads.length === 1} badge={threads.length}>
              {threads.map((t) => {
                const loc = tlocs.get(t.id);
                const tl = threadLabel(t.name, t.id);
                return (
                  <div key={t.id} className={"frame" + (t.id === curTid ? " top" : "")}
                       title={tl.tip} onClick={() => selectThread(t)}>
                    <span className="tname">{tl.label}</span>
                    {loc && <span className="tloc">
                      {loc.label}
                      {loc.pc && memLinks && (
                        <span className="addr" title="view memory at pc"
                              onClick={(e) => { e.stopPropagation(); viewMemory(loc.pc); }}> {loc.pc}</span>
                      )}
                    </span>}
                  </div>
                );
              })}
            </Panel>
          )}
          {/* Registers moved to their own bottom-panel tab (next to Memory) —
              they're tall and noisy beside LOCALS, and pair with the memory view. */}
          {/* Rarely touched per-session — lives at the bottom on purpose. */}
          {excFilters.length > 0 && (
            // lldb-dap offers C++ and Objective-C filters to every program, a C
            // one included, so the list starts folded down to its count.
            <Panel title="Exceptions" persist="dapweb.excCollapsed" defaultCollapsed
                   badge={`${excFilters.filter((f: any) => excSel.has(f.filter)).length} on`}>
              {excFilters.map((f: any) => (
                <label key={f.filter} className="excrow">
                  <input type="checkbox" checked={excSel.has(f.filter)} onChange={(e) => {
                    const next = new Set(excSel);
                    e.target.checked ? next.add(f.filter) : next.delete(f.filter);
                    setExcSel(next);
                    send({ cmd: "setExceptions", filters: [...next] });
                  }} /> {f.label || f.filter}
                </label>
              ))}
            </Panel>
          )}
        </div>
        {bpEdit && (
          <BpPopover
            line={bpEdit.line} x={bpEdit.x} y={bpEdit.y}
            meta={bps.get(bpKey(bpEdit.path, bpEdit.line)) ?? {}}
            exists={bps.has(bpKey(bpEdit.path, bpEdit.line))}
            caps={caps}
            onApply={(meta) => { setBpMetaAt(bpEdit.path, bpEdit.line, meta); setBpEdit(null); }}
            onRemove={() => { removeBp(bpEdit.path, bpEdit.line); setBpEdit(null); }}
            onClose={() => setBpEdit(null)}
          />
        )}
      </main>
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
          {S.hasRegisters && (
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
          <DebugConsole append={consoleAppend} frame0Ref={frame0Ref}
                        canComplete={!!caps.supportsCompletionsRequest} />
        </div>
        <div className="tabpane" style={{ display: tab === "mem" && memLinks ? "flex" : "none" }}>
          <MemView mem={mem} addr={memAddr} setAddr={setMemAddr} err={memErr}
                   enabled={memLinks && stopped} onLoad={viewMemory} classify={classifyRegion}
                   locals={locals} frames={frames} regFrame={regFrame} />
        </div>
        {/* Always mounted (display-toggled): RegistersPanel reports sp/fp/lr up via
            onFrame, which the Memory and Stack views depend on regardless of tab. */}
        {S.hasRegisters && (
          <div className="tabpane regpane" style={{ display: tab === "regs" ? "flex" : "none" }}>
            <RegistersPanel regRef={registersRef} stopSeq={stopSeq} disabled={!stopped}
                            classify={classifyRegion} onFrame={setRegFrame}
                            onSetVar={caps.supportsSetVariable ? setVar : undefined}
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
      {showConfig ? (
        <>
          <div className="drawer-backdrop" onClick={() => setShowConfig(false)} />
          <ConfigDrawer
            config={cfg}
            sessionActive={phase === "running" || phase === "stopped"}
            error={configErr}
            history={cfgHist}
            onChange={(text: string) => { cfgTextRef.current = text; }}
            onRun={run}
            onClose={() => setShowConfig(false)}
          />
        </>
      ) : null}
      </div>
    </div>
  );
}
