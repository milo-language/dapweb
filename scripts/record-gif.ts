// Records docs/images/agent-drives.gif, the landing page's hero: the real web UI
// following an agent that drives the session over `dapweb api` (breakpoint,
// run, steps, continue), with the follow-agent flash and the header's agent note.
//
// Rerun after a UI change (macOS or Linux, needs Chrome, clang and ffmpeg):
//   scripts/build.sh && bun scripts/record-gif.ts [out.gif]
//
// How: a real `dapweb web` on a free port, headless Chrome driven over the
// DevTools protocol, one Page.captureScreenshot per tick while the agent's
// commands run, then ffmpeg turns the timestamped frames into a GIF with one
// shared palette (diff_mode keeps the size down: most of each frame is static).

import { freePort } from "../tests/freeport";

const root = import.meta.dir + "/..";
const out = process.argv[2] ?? `${root}/docs/images/agent-drives.gif`;
const work = `/tmp/dapweb_gif_${process.pid}`;
const W = 1100, H = 680;            // capture size (CSS px, DPR 1); narrow enough that UI text survives the page scaling it down
const OUT_W = 1100;                 // GIF width: native, no resampling blur
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chromeBin = process.env.CHROME ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

await Bun.$`rm -rf ${work} && mkdir -p ${work}/frames ${work}/xdg ${work}/chrome`.quiet();
await Bun.$`clang -g -O0 examples/nested/main.c examples/nested/shapes.c -o /tmp/dapweb_nested -lm`.cwd(root);

const port = await freePort();
const env = { ...process.env, DAPWEB_AGENT: "agent", DAPWEB_NO_OPEN: "1", DAPWEB_NO_UPDATE_CHECK: "1", XDG_STATE_HOME: `${work}/xdg` };
const server = Bun.spawn(["./dapweb", "web", "--port", String(port), "--quiet", "--no-journal",
  "--program", "/tmp/dapweb_nested", "--source", "examples/nested/main.c"], { cwd: root, env, stdout: "ignore", stderr: "inherit" });
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
await sleep(2500); // bundle + hello + source

// Capture continuously until told to stop; each frame keeps its own timestamp
// so the GIF plays at the speed things actually happened.
const frames: { file: string; t: number }[] = [];
let capturing = true;
const capture = (async () => {
  while (capturing) {
    const t = Date.now();
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    const file = `${work}/frames/f${String(frames.length).padStart(4, "0")}.png`;
    await Bun.write(file, Buffer.from(shot.data, "base64"));
    frames.push({ file, t });
    await sleep(Math.max(0, 100 - (Date.now() - t))); // ~10 fps
  }
})();

const api = async (...args: string[]) => {
  await Bun.spawn(["./dapweb", "api", "--port", String(port), ...args], { cwd: root, env, stdout: "ignore" }).exited;
};

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

capturing = false;
await capture;
ws.close();
chrome.kill();
server.kill();

// concat demuxer: each frame shown until the next one was taken.
let list = "";
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? (frames[i + 1].t - frames[i].t) / 1000 : 1.0;
  list += `file '${frames[i].file}'\nduration ${d.toFixed(3)}\n`;
}
list += `file '${frames[frames.length - 1].file}'\n`;
await Bun.write(`${work}/list.txt`, list);
const vf = `fps=10,scale=${OUT_W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
await Bun.$`ffmpeg -y -loglevel error -f concat -safe 0 -i ${work}/list.txt -vf ${vf} -loop 0 ${out}`;
const secs = (frames[frames.length - 1].t - frames[0].t) / 1000 + 1.0;
console.log(`${out}: ${frames.length} frames, ${secs.toFixed(1)}s, ${(Bun.file(out).size / 1e6).toFixed(2)} MB`);
await Bun.$`rm -rf ${work}`.quiet();
