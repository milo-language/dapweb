// E2E for attribution (F4 follow-the-agent) and the stop timeline (F3): every
// stop, breakpoint change and peer-requested source says whether an agent or a
// person caused it, the late-join snapshot keeps that, and the journal answers
// "this session's stops, in order, and who caused each" through /api/log.
//
// Self-spawns its server on a throwaway $XDG_STATE_HOME, so the journal it
// reads holds only this run's events.
// Usage: bun tests/e2e-timeline.ts [binary]   (needs /tmp/dapweb_nested built)

import { freePort } from "./freeport";
import { parseStopRows } from "../src/web/ui/src/recordedStops";
const bin = process.argv[2] ?? "./dapweb";
const root = import.meta.dir + "/..";
const xdg = `/tmp/dapweb_timeline_test_${process.pid}`;
const SRC = `${root}/examples/nested/main.c`.replace("/tests/..", "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else {
    console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : "");
    cleanup();
    process.exit(1);
  }
}

// A browser peer: bare /ws, so the server files it as kind "browser".
class Peer {
  ws!: WebSocket;
  queue: any[] = [];
  waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  async connect(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(m);
      else this.queue.push(m);
    };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
  }
  send(o: any) { this.ws.send(JSON.stringify(o)); }
  wait(pred: (m: any) => boolean, ms = 20000): Promise<any> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return Promise.race([
      new Promise<any>((resolve) => this.waiters.push({ pred, resolve })),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting ${ms}ms`)), ms)),
    ]);
  }
  drain() { this.queue = []; }
}

let srv: any = null;
const peers: Peer[] = [];
function cleanup() {
  for (const p of peers) try { p.ws.close(); } catch {}
  try { srv?.kill(); } catch {}
  try { require("fs").rmSync(xdg, { recursive: true, force: true }); } catch {}
}

try {
  const port = await freePort();
  srv = Bun.spawn([bin, "web", "--program", "/tmp/dapweb_nested", "--source", "examples/nested/main.c",
                   "--port", String(port), "--quiet"], {
    cwd: root, env: { ...process.env, DAPWEB_NO_OPEN: "1", XDG_STATE_HOME: xdg }, stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/state`)).ok) break; } catch {}
    await sleep(100);
  }
  const base = `http://localhost:${port}`;
  // An agent: /api/cmd labelled the way `dapweb api` labels itself.
  const agent = (body: any, awaitType = "") =>
    fetch(`${base}/api/cmd?agent=testbot&pid=4242${awaitType ? `&await=${awaitType}&timeout=20000` : ""}`,
          { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

  const tab = new Peer(); peers.push(tab);
  await tab.connect(port);
  await tab.wait((m) => m.type === "hello");

  // ── F4: what a following tab is told ──
  // Stop 1 (agent): run to main.
  await agent({ cmd: "run", stopAtMain: true }, "stopped");
  const s1 = await tab.wait((m) => m.type === "stopped");
  ok(s1.by === "agent", "a stop an agent's run caused says by:agent", s1);
  ok(s1.who === "testbot (pid 4242)", "and names the agent", s1.who);

  tab.drain();
  await agent({ cmd: "setBreakpoint", path: SRC, line: 23 });
  const bp = await tab.wait((m) => m.type === "breakpoint");
  ok(bp.by === "agent" && bp.line === 23 && bp.set === true, "an agent's breakpoint arrives attributed", bp);

  await agent({ cmd: "openSource", path: SRC });
  const src = await tab.wait((m) => m.type === "source" && m.path === SRC);
  ok(src.by === "agent", "a source an agent opened arrives attributed", { by: src.by, who: src.who });

  // A browser's own commands are the user's: following must not fire on them.
  tab.send({ cmd: "clearBreakpoint", path: SRC, line: 23 });
  const bp2 = await tab.wait((m) => m.type === "breakpoint" && m.set === false);
  ok(bp2.by === "user", "a browser's breakpoint change says by:user", bp2);

  // Stop 2 (user): the browser steps.
  tab.drain();
  tab.send({ cmd: "stepOver", tid: s1.tid });
  const s2 = await tab.wait((m) => m.type === "stopped");
  ok(s2.by === "user", "a stop the browser's step caused says by:user", s2);

  // Stop 3 (agent): the agent steps.
  tab.drain();
  const s3reply = await agent({ cmd: "stepOver", tid: s2.tid }, "stopped");
  ok(s3reply.by === "agent", "the api's own awaited reply carries the attribution", s3reply);
  const s3 = await tab.wait((m) => m.type === "stopped");
  ok(s3.by === "agent" && s3.line === s3reply.line, "an agent's step is broadcast by:agent", s3);

  // Late join: the snapshot's stop is rendered by the same stoppedMsg, so a tab
  // joining now must hear the same attribution a live tab heard.
  const late = new Peer(); peers.push(late);
  await late.connect(port);
  const ls = await late.wait((m) => m.type === "stopped");
  ok(ls.by === "agent" && ls.who === s3.who, "the late-join snapshot keeps the stop's attribution", ls);
  const st = await (await fetch(`${base}/api/state`)).json();
  ok(st.stopped?.by === "agent", "/api/state agrees", st.stopped);

  // ── F3: the timeline query ──
  const q = await (await fetch(`${base}/api/log?kind=stopped&dir=out&limit=200`)).json();
  ok(q.ok && q.rows.length === 3, "this session's log holds exactly the three stops", q.rows?.map((r: any) => r.kind));
  const seqs = q.rows.map((r: any) => r.seq);
  ok(seqs[0] < seqs[1] && seqs[1] < seqs[2], "oldest first, in the order they happened", seqs);
  ok(q.rows.map((r: any) => r.peer).join(",") === "agent,user,agent",
     "each row's peer column says who caused it", q.rows.map((r: any) => [r.peer, r.who]));
  ok(q.rows[0].who === "testbot (pid 4242)", "an agent row names the agent", q.rows[0].who);
  ok(q.rows[2].line === s3.line && q.rows[2].path === s3.path, "the newest row is the current stop", q.rows[2]);
  ok(!q.rows.some((r: any) => r.truncatedFrom), "a stop is stored whole", q.rows.map((r: any) => r.truncatedFrom));

  // What the Timeline tab renders from that same query: newest first, with
  // frames and locals recovered from the stored broadcast.
  const tl = parseStopRows(q.rows);
  ok(tl.map((t) => t.by).join(",") === "agent,user,agent".split(",").reverse().join(","),
     "parsed newest first", tl.map((t) => t.by));
  ok(tl[0].frames !== null && tl[0].frames.length > 0 && tl[0].frames[0].name.includes("main"),
     "a recorded stop's frames come back", tl[0].frames);
  ok(tl[0].locals !== null && tl[0].locals.some((v) => v.name === "shapes"),
     "and its locals", tl[0].locals?.map((v) => v.name));

  console.log(`\ne2e-timeline: ${pass} checks passed`);
  cleanup();
  process.exit(0);
} catch (e) {
  console.error("  FAIL e2e-timeline:", e);
  cleanup();
  process.exit(1);
}
