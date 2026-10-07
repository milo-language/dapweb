// Records the landing page's GIFs from the real web UI. Two scenes:
//   agent      docs/images/agent-drives.gif, the hero: the UI following an agent
//              that drives the session over `dapweb api` (breakpoint, run, steps,
//              continue), with the follow-agent flash and the header's agent note.
//   backwards  docs/images/debug-backwards.gif: the replay demo run to its failed
//              check, a breakpoint on the add, then Reverse Continue back to the
//              order that was parsed wrong.
//
// Rerun after a UI change (macOS or Linux, needs Chrome, clang and ffmpeg; the
// backwards scene also needs the milo compiler, found as scripts/build.sh does):
//   scripts/build.sh && bun scripts/record-gif.ts [agent|backwards] [out.gif]
//
// How: a real `dapweb web` on a free port, headless Chrome driven over the
// DevTools protocol, one Page.captureScreenshot per tick while the agent's
// commands run, then ffmpeg turns the timestamped frames into a GIF with one
// shared palette (diff_mode keeps the size down: most of each frame is static).

import { freePort } from "../tests/freeport";

const root = import.meta.dir + "/..";
const scene = process.argv[2] === "backwards" ? "backwards" : "agent";
const out = process.argv[3] ?? `${root}/docs/images/${scene === "agent" ? "agent-drives" : "debug-backwards"}.gif`;
const work = `/tmp/dapweb_gif_${process.pid}`;
// Capture size (CSS px, DPR 1); narrow enough that UI text survives the page
// scaling it down. The backwards scene is wide enough for the header's middle
// tier (the Continue label) and tall enough for the Locals it is about.
const [W, H] = scene === "agent" ? [1100, 680] : [1240, 700];
const OUT_W = W;                    // GIF width: native, no resampling blur
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chromeBin = process.env.CHROME ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

await Bun.$`rm -rf ${work} && mkdir -p ${work}/frames ${work}/xdg ${work}/chrome`.quiet();
let target: string[];
if (scene === "agent") {
  await Bun.$`clang -g -O0 examples/nested/main.c examples/nested/shapes.c -o /tmp/dapweb_nested -lm`.cwd(root);
  target = ["--program", "/tmp/dapweb_nested", "--source", "examples/nested/main.c"];
} else {
  await Bun.$`sh examples/replay-demo/record.sh`.cwd(root).env({ ...process.env, OUT: `${work}/rr` }).quiet();
  target = ["--program", `${work}/rr/orders`, "--source", "examples/replay-demo/orders.milo", "--replay", `${work}/rr/orders.mrr`];
}

const port = await freePort();
const env = { ...process.env, DAPWEB_AGENT: "agent", DAPWEB_NO_OPEN: "1", DAPWEB_NO_UPDATE_CHECK: "1", XDG_STATE_HOME: `${work}/xdg` };
const server = Bun.spawn(["./dapweb", "web", "--port", String(port), "--quiet", "--no-journal", ...target],
  { cwd: root, env, stdout: "ignore", stderr: "inherit" });
for (let i = 0; i < 100; i++) {
  try { await fetch(`http://localhost:${port}/api/state`); break; } catch { await sleep(100); }
}

const cdpPort = await freePort();
const chrome = Bun.spawn([chromeBin, "--headless=new", `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${work}/chrome`, `--window-size=${W},${H}`, "--hide-scrollbars", "--no-first-run",
  "about:blank"], { stdout: "ignore", stderr: "ignore" });
let wsUrl = "";
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as any[];
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
  } catch { await sleep(100); }
}
if (!wsUrl) throw new Error("chrome did not come up");

// Minimal CDP client: one socket, request ids matched to replies.
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
};
const cdp = (method: string, params: any = {}) => new Promise<any>((res) => {
  const id = nextId++;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp("Page.enable");
await cdp("Page.navigate", { url: `http://localhost:${port}/` });
if (scene === "backwards") {
  // Run goes straight to the failure, as in the README's walk-through.
  await sleep(1000);
  await cdp("Runtime.evaluate", { expression: `localStorage.setItem("dapweb.stopAtMain", "0")` });
  await cdp("Page.reload");
}
await sleep(2500); // bundle + hello + source

// Capture continuously until told to stop; each frame keeps its own timestamp
// so the GIF plays at the speed things actually happened.
// A rewind re-runs the recording behind a status that holds still for a second
// or so; the backwards GIF plays those frames (and the run's, and the moment
// before the status changes, while the controls are already locked) at 5x.
const frames: { file: string; t: number; fast: boolean }[] = [];
const js = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value;
let capturing = true;
const capture = (async () => {
  while (capturing) {
    const t = Date.now();
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    const file = `${work}/frames/f${String(frames.length).padStart(4, "0")}.png`;
    await Bun.write(file, Buffer.from(shot.data, "base64"));
    const fast = scene === "backwards" && !!(await js(`!!document.querySelector(".status.rewinding, .status.running, .toolbar button.primary:disabled")`));
    frames.push({ file, t, fast });
    await sleep(Math.max(0, 100 - (Date.now() - t))); // ~10 fps
  }
})();

const api = async (...args: string[]) => {
  await Bun.spawn(["./dapweb", "api", "--port", String(port), ...args], { cwd: root, env, stdout: "ignore" }).exited;
};

// A failed scene must not leave the server holding this script's stderr open.
try {
  if (scene === "agent") {
    await sleep(400);
    await api("break", "--line", "22");
    await sleep(1100);
    await api("request", "--await", "stopped", JSON.stringify({ cmd: "run", stopAtMain: false }));
    await sleep(1500);
    await api("step");
    await sleep(1100);
    await api("step");
    await sleep(1100);
    await api("continue");
    await sleep(1600);
  } else {
    // Driven through the page as a person would: real mouse events at the
    // controls' positions, each followed by a wait for the stop it causes.
    const click = async (sel: string) => {
      const r = await js(`(() => { const e = ${sel}; if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
      if (!r) throw new Error(`nothing to click: ${sel}`);
      for (const type of ["mousePressed", "mouseReleased"])
        await cdp("Input.dispatchMouseEvent", { type, x: r[0], y: r[1], button: "left", clickCount: 1 });
      // Off the control again, or its tooltip sits over the source for the rest of the scene.
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: W / 2, y: H - 20 });
    };
    const settled = async () => {
      for (let i = 0; i < 150; i++) {
        await sleep(100);
        const st = await (await fetch(`http://localhost:${port}/api/state`)).json();
        if (st.phase === "stopped" && !st.replay?.rewinding && !(await js(`!!document.querySelector(".status.rewinding, .status.running, .toolbar button.primary:disabled")`))) return;
      }
      throw new Error("the program never stopped");
    };
    // cents and order are last in Locals, under the panel's fold: keep it scrolled down.
    const showLocals = () => js(`(() => { const b = document.querySelector('.aside .panel .body'); if (b) b.scrollTop = b.scrollHeight; })()`);
    const ADD = (await Bun.file(`${root}/examples/replay-demo/orders.milo`).text()).split("\n")
      .findIndex((l) => l.includes("total = total + cents")) + 1;
    await sleep(500);
    await click(`document.querySelector('.toolbar button.primary')`);
    await settled();
    await sleep(600);
    // The failure stops inside abort(): go up to main, where the source is.
    await click(`[...document.querySelectorAll('.frame')].find((e) => / main:/.test(e.textContent))`);
    await sleep(600);
    await click(`[...document.querySelectorAll('.line-numbers')].find((e) => e.textContent.trim() === '${ADD}')`);
    await sleep(700);
    // From the failure: orders 1008, 1007, 1006, 1005, then 1004.
    for (let k = 0; k < 5; k++) {
      await click(`document.querySelector('.toolbar.reverse button')`);
      await settled();
      await showLocals();
      await sleep(k < 4 ? 350 : 1800);
    }
  }
} catch (e) {
  console.error(e);
  chrome.kill(); server.kill();
  process.exit(1);
}

capturing = false;
await capture;
ws.close();
chrome.kill();
server.kill();

// concat demuxer: each frame shown until the next one was taken.
let list = "", secs = 0;
for (let i = 0; i < frames.length; i++) {
  const d = (i + 1 < frames.length ? (frames[i + 1].t - frames[i].t) / 1000 : scene === "agent" ? 1.0 : 0.1) * (frames[i].fast ? 0.2 : 1);
  secs += d;
  list += `file '${frames[i].file}'\nduration ${d.toFixed(3)}\n`;
}
list += `file '${frames[frames.length - 1].file}'\n`;
await Bun.write(`${work}/list.txt`, list);
const vf = `fps=10,scale=${OUT_W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
await Bun.$`ffmpeg -y -loglevel error -f concat -safe 0 -i ${work}/list.txt -vf ${vf} -loop 0 ${out}`;
console.log(`${out}: ${frames.length} frames, ${secs.toFixed(1)}s, ${(Bun.file(out).size / 1e6).toFixed(2)} MB`);
await Bun.$`rm -rf ${work}`.quiet();
