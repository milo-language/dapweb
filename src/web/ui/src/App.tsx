// Dapweb web UI — React + xterm.js. Talks WS protocol v2 (see docs/design.md).
import React, { useEffect, useReducer, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { BpMeta, BpPopover, HoverVar } from "./SourceView";
import ConfigDrawer, { stripJsonc } from "./ConfigDrawer";
import { primaryAction, exitLabel } from "./primary";
import { Frame, Thread, Var, sessionReducer, initialSession, hasSrc, bpKey, stopOf, stopStatus } from "./session";
import { send, request, requestWithin, pending, routeReply, memBytes, setSocket, setOnSendWhileDead, expandRef } from "./rpc";
import { termPut, termClear, writeTagged, writeOutput, setDbgTag, SGR } from "./terminal";
import { Mark } from "./Mark";
import { Panel } from "./Panel";
import { VarList, isSpecialVar } from "./VarList";
import { BpList } from "./BpList";
import { useBinInfo } from "./BinInfoView";
import { AsideDrag } from "./Drag";
import { TargetBar } from "./TargetBar";
import { Transport } from "./Transport";
import { SessionMenu } from "./SessionMenu";
import { EditorPane, Disasm } from "./EditorPane";
import { WatchPanel, Watch } from "./WatchPanel";
import { ThreadsPanel } from "./ThreadsPanel";
import { ExceptionsPanel } from "./ExceptionsPanel";
import { BottomPanel, BottomTab } from "./BottomPanel";
import { followTarget, loadFollow, saveFollow } from "./follow";
import type { Flash } from "./SourceView";

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

export default function App() {
  // The header is one row and the target bar has first claim on it, so the state
  // readout is a short pill (`short`) with the full sentence on hover (`text`).
  // Anything that is guidance rather than state belongs in the console, where it
  // scrolls with the session instead of holding a strip of chrome forever.
  const [status, setStatus] = useState({ text: "connecting to the session…", short: "connecting", cls: "" });
  // A step usually stops again within a few tens of ms. Showing "running" (and
  // dropping the stop line, locals and inline values) for that blink made the
  // whole screen flicker on every step, so the running state is shown only if
  // no stop has arrived after a short grace. `busy` disables the controls at once
  // so the grace cannot be used to send a second step.
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false);
  const settle = () => {
    if (resumeTimer.current) { clearTimeout(resumeTimer.current); resumeTimer.current = null; }
    setBusy(false);
  };
  const resumeSoon = (st: { text: string; short: string; cls: string }) => {
    settle();
    setBusy(true);
    resumeTimer.current = setTimeout(() => {
      resumeTimer.current = null;
      dispatch({ type: "local/resumed" });
      setStatus(st);
      setBusy(false);
    }, 300);
  };
  // Offline gets more than the status pill: a banner, because every control in
  // the app is a silent no-op until the socket comes back.
  const [offline, setOffline] = useState(false);
  // This server's build ("dev" for a local build) and, when a newer release
  // exists, the notice line naming the command. Dismissal is remembered per
  // notice, so the next release brings the banner back.
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState("");
  const [updateDismissed, setUpdateDismissed] = useState(() => {
    try { return localStorage.getItem("dapweb.updateDismissed") || ""; } catch { return ""; }
  });
  // Everything the server pushes, folded by one pure reducer (session.ts).
  const [S, dispatch] = useReducer(sessionReducer, initialSession);
  const { program, sourcePath: srcPath, files, bps, stopLine, stopPath, frames, threads, tlocs,
          curTid, locals, phase, config: cfg, history: cfgHist, caps, selFrame, scopeRef,
          stopSeq, regions, adapterCmd, adapterId: dbgLabel, configError: configErr } = S;
  const registersRef = S.stop?.registersRef ?? 0;
  const [viewPath, setViewPath] = useState(""); // file currently displayed
  const [tabs, setTabs] = useState<string[]>([]);
  const [watches, setWatches] = useState<Watch[]>([]);
  const [tab, setTab] = useState<BottomTab>("term");
  const [asideW, setAsideW] = useState(340);
  // Opens only when there is nothing to run; a resolvable target goes straight to
  // the debug view. The gear reopens it.
  const [showConfig, setShowConfig] = useState(false);
  // Last thing another peer said it was doing, shown briefly in the toolbar.
  const [agentNote, setAgentNote] = useState<{ text: string; at: number } | null>(null);
  // Follow the agent: an agent's stop, breakpoint or opened file is brought into
  // view and flashed. Per tab, so one watcher can follow while another reads.
  const [follow, setFollow] = useState(loadFollow);
  const followRef = useRef(follow);
  followRef.current = follow;
  const [flash, setFlash] = useState<(Flash & { path: string }) | undefined>(undefined);
  const [stopMain, setStopMain] = useState(() => localStorage.getItem("dapweb.stopAtMain") !== "0");
  // Monotonic counters so re-clicking the same line still reveals it.
  const [jump, setJump] = useState({ line: 0, n: 0 });
  const [disasm, setDisasm] = useState<Disasm | null>(null);
  const [bpEdit, setBpEdit] = useState<{ path: string; line: number; x: number; y: number } | null>(null);  // panel ✎ editor
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
      const ft = followTarget(m, followRef.current);
      if (ft?.flash) setFlash((f) => ({ path: ft.path, line: ft.line, n: (f?.n ?? 0) + 1, at: Date.now() }));
      // A stop and a source already switch the editor below; a breakpoint never
      // did, so following one is the only reason to open its file.
      if (ft && m.type === "breakpoint") openFile(ft.path);
      if (m.type === "update") setUpdate(m.text || "");
      if (m.type === "hello") {
        setVersion(m.version || "");
        setUpdate(m.update || "");
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
          // An agent opening a file is the agent reading, not the user: with
          // follow off it waits as a tab instead of replacing what is on screen.
          if (m.by !== "agent" || followRef.current) setViewPath(m.path);
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
        settle();
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
      // A command the server accepted but could not carry out (a goto the
      // adapter refused): say why where the user is looking for output.
      else if (m.type === "cmdError") {
        consoleAppend(`${m.cmd}: ${m.error}\n`, "err");
        // A refused step back never stops; the controls must not stay locked.
        if (m.cmd === "stepBack" || m.cmd === "reverseContinue" || m.cmd === "seek") settle();
      }
      // A rewind relaunches the program and replays it to an earlier stop; the
      // output it prints on the way is the output up to that stop, so the
      // terminal starts over with it.
      else if (m.type === "rewind") {
        if (m.clear) termClear(termRef.current);
        // A fresh process: the asm pane a no-source stop (the abort) opened
        // would otherwise stay over the source the rewind lands in.
        setDisasm(null);
      }
      else if (m.type === "replayState") {
        if (m.rewinding) {
          const what = m.rewinding === "seek" ? "seeking" : m.mode === "count" ? "counting breakpoint hits" : `rewinding to stop ${m.target}`;
          setStatus({ text: `${what}: re-running the recording`, short: "rewinding…", cls: "running rewinding" });
        }
      }
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
        settle();
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

  // Data breakpoints: the server answers every peer with the new list, and a
  // refusal arrives as a cmdError in the console.
  const watchVar = (ref: number, name: string) => send({ cmd: "setDataBreakpoint", ref, name });
  const watchAddr = (address: string, size: number) => send({ cmd: "setDataBreakpoint", address, size });
  const removeDataBp = (dataId: string) => send({ cmd: "clearDataBreakpoint", dataId });

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
  const clearAllBps = () => {
    for (const { path, line } of bpEntries()) removeBp(path, line);
    for (const d of S.dataBps) removeDataBp(d.dataId);
  };

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

  const { binInfo, binTab } = useBinInfo(program);

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
    resumeSoon({ text: "running…", short: "running", cls: "running" });
    send({ cmd, tid: tidRef.current, ...(granularity ? { granularity } : {}) });
  };
  // The editor's line actions. Stable, so the editor's action set is not rebuilt per render.
  const runToLine = useCallback((path: string, line: number) => {
    resumeSoon({ text: `running to line ${line}…`, short: "running", cls: "running" });
    send({ cmd: "runToCursor", path, line, tid: tidRef.current });
  }, []);
  const gotoLine = useCallback((path: string, line: number) => {
    send({ cmd: "setNextStatement", path, line, tid: tidRef.current });
  }, []);
  // VS Code's debug keys. Read through a ref so the one window listener always
  // sees this render's phase and actions.
  const debugKeyRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  debugKeyRef.current = (e) => {
    const live = phase === "running" || phase === "stopped";
    const k = (e.altKey ? "A-" : "") + (e.shiftKey ? "S-" : "") + (e.ctrlKey || e.metaKey ? "C-" : "") + e.key;
    switch (k) {
      case "F5": if (phase === "stopped") resume("continue"); else if (!live) run(); else return false; return true;
      case "S-F5": if (live) send({ cmd: "kill" }); return live;
      case "S-C-F5": restart(); return live;
      case "F6": if (phase === "running") send({ cmd: "pause", tid: tidRef.current }); return phase === "running";
      case "F10": if (phase === "stopped") resume("stepOver"); return phase === "stopped";
      case "F11": if (phase === "stopped") resume("stepIn"); return phase === "stopped";
      case "S-F11": if (phase === "stopped") resume("stepOut"); return phase === "stopped";
      // Backwards is the forward key with Alt. Shift+F10 would have mirrored F10,
      // but browsers on Windows and Linux open the context menu on it.
      case "A-F10": if (reverse?.canStepBack) reverse.onStepBack(); return !!reverse;
      case "A-F5": if (reverse?.canReverse) reverse.onReverse(); return !!reverse;
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
  // Inline-asm mode: render each source line's instructions under it (view zones
  // in the main SourceView) instead of the side-by-side pane.
  const [inlineAsm, setInlineAsm] = useState(false);
  // Selected frame's pc, or the nearest frame that has one.
  const asmFrame = () => (frames[selFrame]?.ipRef ? frames[selFrame] : frames.find((x) => x.ipRef));
  const toggleDisasm = () => {
    if (disasm) { setDisasm(null); setInlineAsm(false); }
    else { const f = asmFrame(); if (f) requestDisasm(f); }
  };
  const toggleInlineAsm = () => {
    if (inlineAsm) { setInlineAsm(false); setDisasm(null); }
    else { setInlineAsm(true); const f = asmFrame(); if (f) requestDisasm(f); }
  };
  const canInstrStep = stopped && !!caps.supportsSteppingGranularity && !!disasm;
  // Replay sessions only. A run that has ended can still be stepped back into.
  const rr = S.rr;
  const backPhase = (phase === "stopped" || phase === "done") && !busy && !rr.rewinding;
  const goBack = (cmd: string, what: string) => {
    resumeSoon({ text: `${what}: re-running the recording…`, short: "rewinding…", cls: "running rewinding" });
    send({ cmd });
  };
  const reverse = S.replay ? {
    canStepBack: backPhase && rr.prev > 0,
    canReverse: backPhase && rr.stops > 0,
    rewinding: !!rr.rewinding,
    onStepBack: () => goBack("stepBack", "stepping back"),
    onReverse: () => goBack("reverseContinue", "reverse continue"),
  } : undefined;
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
        <TargetBar cfg={cfg} history={cfgHist} readCfg={readCfg} writeCfg={writeCfg}
                   onEnter={() => runRef.current?.()} />
        <Transport primary={busy ? { ...primary, disabled: true } : primary} phase={busy ? "running" : phase} asm={!!disasm} inlineAsm={inlineAsm}
                   canInstrStep={canInstrStep} canDisasm={stopped && !!caps.supportsDisassembleRequest}
                   onPrimary={() => {
                     if (primary.kind === "continue") resume("continue");
                     else if (primary.kind === "pause") send({ cmd: "pause", tid: tidRef.current });
                     else run();
                   }}
                   resume={resume} restart={restart} onDisasm={toggleDisasm} onInlineAsm={toggleInlineAsm} reverse={reverse} />
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
        <span className={"termchip follow-chip" + (follow ? " on" : "")} role="switch" aria-checked={follow}
              data-tip="Follow agent: when an agent stops the program, sets a breakpoint or opens a file, show that line here and flash it"
              onClick={() => { setFollow(!follow); saveFollow(!follow); }}>follow agent</span>
        <span className="agent-note" data-tip={agentNote?.text}>{agentNote ? "◆ " + agentNote.text : ""}</span>
        <span className={"status " + status.cls} data-tip={status.text}><span className="status-text">{status.short}</span></span>
        {/* Three unlabelled glyphs (ⓘ, +, ⚙) asked the reader to remember which
            was which. One labelled menu says what it opens, and has room for the
            things that had nowhere to live — like the list of other sessions. */}
        <SessionMenu caps={caps} dbgLabel={dbgLabel} adapterCmd={adapterCmd} sessionId={S.sessionId} version={version}
                     live={phase === "running" || phase === "stopped"} onConfigure={() => setShowConfig(true)} />
      </header>
      {update && update !== updateDismissed && (
        <div className="update-banner">
          <span>{update}</span>
          <button className="update-x" aria-label="dismiss" onClick={() => {
            setUpdateDismissed(update);
            try { localStorage.setItem("dapweb.updateDismissed", update); } catch {}
          }}>×</button>
        </div>
      )}
      {offline && <div className="offline-banner">disconnected from the dapweb server: nothing you click will reach the session until it reconnects</div>}
      {/* main + the terminal are one workspace, and the target sheet overlays the
          whole of it. Living inside <main> it was capped at whatever height the
          terminal left over — about 360px — which is two form fields and a
          scrollbar. */}
      <div className="workspace">
      <main>
        <EditorPane tabs={tabs} viewPath={viewPath} openFile={openFile} files={files} bps={bps}
                    stopPath={stopPath} stopLine={stopLine} caps={caps} jump={jump}
                    disasm={disasm} inlineAsm={inlineAsm} fetchDisasm={fetchDisasm}
                    onToggleBp={toggleBp} onSetBpMeta={setBpMeta} onHoverEval={evalHover}
                    stop={S.stop} stopSeq={stopSeq} onRunToLine={runToLine} onGotoLine={gotoLine} flash={flash}
                    emptyHint={!targetSet ? "none"
                      : stopped ? (caps.supportsDisassembleRequest ? "disassembling…" : "no source available for this frame")
                      : attachMode ? "Run attaches and opens the source where the process stops"
                      : stopMain ? "Run stops at main and opens its source here"
                      : "no source configured: tick stop at main and Run to open it here"} />
        <AsideDrag onResize={(w) => setAsideW(w)} />
        <div className="aside" style={{ width: asideW }}>
          {/* Ordered by how often a stop sends you there: the values first, then
              where you are, then what you asked to see. */}
          <Panel title="Locals" persist="dapweb.localsCollapsed">
            <VarList vars={locals} disabled={!stopped} parentRef={scopeRef}
                     empty={stopped ? "no locals in this frame" : "run to a breakpoint to see local variables"}
                     onSetVar={caps.supportsSetVariable ? setVar : undefined}
                     onWatch={caps.supportsDataBreakpoints ? watchVar : undefined}
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
          <WatchPanel watches={watches} setWatches={setWatches} stopped={stopped} evalWatch={evalWatch}
                      onAddr={memLinks ? viewMemory : undefined} />
          <Panel title="Breakpoints" persist="dapweb.bpsCollapsed" badge={bps.size + S.dataBps.length || null} action={bps.size + S.dataBps.length > 0 && (
            <span className="bpacts">
              <button className="addbtn" title={anyBpEnabled ? "disable all" : "enable all"}
                      onClick={toggleAllBps}>⊘</button>
              <button className="addbtn" title="remove all" onClick={clearAllBps}>✕</button>
            </span>
          )}>
            <BpList bps={bps} dataBps={S.dataBps} dataBpsDropped={S.dataBpsDropped} onRemoveData={removeDataBp}
                    files={files} onJump={(p, ln) => openFile(p, ln)} onRemove={removeBp} onToggle={setBpEnabled}
                    onEdit={(path, line, x, y) => setBpEdit({ path, line, x, y })} />
          </Panel>
          <ThreadsPanel threads={threads} tlocs={tlocs} curTid={curTid} onSelect={selectThread}
                        onAddr={memLinks ? viewMemory : undefined} />
          {/* Registers moved to their own bottom-panel tab (next to Memory) —
              they're tall and noisy beside LOCALS, and pair with the memory view. */}
          {/* Rarely touched per-session — lives at the bottom on purpose. */}
          <ExceptionsPanel caps={caps} />
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
      <BottomPanel sessionId={S.sessionId} openFile={openFile} tab={tab} setTab={setTab} memLinks={memLinks} hasRegisters={S.hasRegisters} binTab={binTab}
                   binInfo={binInfo} dbgLabel={dbgLabel} termRef={termRef} consoleAppend={consoleAppend}
                   frame0Ref={frame0Ref} caps={caps} stopped={stopped} locals={locals} frames={frames}
                   stopSeq={stopSeq} registersRef={registersRef} setVar={setVar} viewMemory={viewMemory}
                   watchAddr={caps.supportsDataBreakpoints && caps.supportsDataBreakpointBytes ? watchAddr : undefined}
                   mem={mem} memAddr={memAddr} setMemAddr={setMemAddr} memErr={memErr} regions={regions} />
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
