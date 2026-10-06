// The request gate: a dapweb port forwards `evaluate` to the debugger, so any
// request a web page or another machine can make is a shell for it. Checks the
// three things that keep those out, each from the side of the attacker:
//
//   * the listener is loopback only (another host cannot connect at all),
//   * Host must name loopback (a DNS-rebinding page arrives under its own name),
//   * Origin, when a browser sends one, must be the server's own (a cross-site
//     `text/plain` POST or WebSocket upgrade skips CORS preflight).
//
// Raw sockets, not fetch: fetch will not send a forged Host or Origin.
//
// Usage: bun tests/e2e-security.ts <port>

import { connect } from "node:net";
import { networkInterfaces } from "node:os";

const port = Number(process.argv[2] ?? 8080);

// Fail rather than hang if the server wedges.
setTimeout(() => { console.error("  FAIL suite timed out (server hung or dead)"); process.exit(1); }, 60_000).unref();

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 400) : ""); process.exit(1); }
}

// One raw request; resolves to the status line's code, or "refused".
function raw(host: string, req: string, addr = "127.0.0.1"): Promise<number | "refused"> {
  return new Promise((resolve) => {
    const s = connect({ host: addr, port, timeout: 2000 });
    let buf = "";
    s.on("connect", () => s.write(req));
    s.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
      if (m) { resolve(Number(m[1])); s.destroy(); }
    });
    s.on("error", () => resolve("refused"));
    // A server that dies mid-request closes the socket with no error event;
    // without this the suite hangs instead of failing.
    s.on("close", () => resolve("refused"));
    s.on("timeout", () => { resolve("refused"); s.destroy(); });
  });
}

const get = (path: string, host: string, origin?: string) =>
  raw(host, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${origin ? `Origin: ${origin}\r\n` : ""}Connection: close\r\n\r\n`);

// The request a hostile page can send with no preflight: text/plain POST.
function post(path: string, host: string, body: string, origin?: string) {
  return raw(host, `POST ${path} HTTP/1.1\r\nHost: ${host}\r\n${origin ? `Origin: ${origin}\r\n` : ""}` +
    `Content-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
}

const upgrade = (host: string, origin: string) =>
  raw(host, `GET /ws HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);

const self = `localhost:${port}`;
const evalCmd = JSON.stringify({ cmd: "evaluate", expr: "1" });

// ── loopback names are accepted ──
ok(await get("/api/state", self) === 200, "Host localhost:port → 200");
ok(await get("/api/state", `127.0.0.1:${port}`) === 200, "Host 127.0.0.1:port → 200");
ok(await get("/api/state", `[::1]:${port}`) === 200, "Host [::1]:port → 200");
ok(await get("/", self) === 200, "index from localhost → 200");

// ── DNS rebinding: right socket, foreign Host ──
ok(await get("/api/state", `evil.example:${port}`) === 403, "foreign Host → 403");
ok(await get("/api/state", `localhost.evil.example:${port}`) === 403, "Host with localhost prefix → 403");
ok(await get("/", `evil.example:${port}`) === 403, "index under foreign Host → 403");
ok(await raw("", `GET /api/state HTTP/1.1\r\nConnection: close\r\n\r\n`) === 403, "no Host → 403");

// ── cross-site browser requests ──
ok(await post("/api/cmd", self, evalCmd, "http://evil.example") === 403, "cross-site text/plain POST → 403");
ok(await post("/api/cmd", self, evalCmd, "null") === 403, "Origin null (sandboxed frame) → 403");
ok(await post("/api/cmd", self, evalCmd, `http://localhost:${port + 1}`) === 403, "other localhost port's Origin → 403");
ok(await upgrade(self, "http://evil.example") === 403, "cross-site WebSocket upgrade → 403");
ok(await upgrade(self, `http://${self}`) === 101, "same-origin WebSocket upgrade → 101");
// A peer that upgrades and vanishes while its replay frames are still queued:
// the writer task used to outlive the socket and write into a closed (or
// reused) fd, which killed the server on the next request.
for (let i = 0; i < 50; i++) await upgrade(self, `http://${self}`);
ok(await get("/api/state", self) === 200, "server alive after 50 upgrade-and-drop peers");
ok(await post("/api/cmd", self, evalCmd, `http://${self}`) !== 403, "same-origin POST passes the gate");
ok(await post("/api/cmd", self, evalCmd) !== 403, "Origin-less POST (dapweb api, curl) passes the gate");

// ── not reachable off this machine ──
const lan = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
if (lan) {
  ok(await raw(`${lan}:${port}`, `GET /api/state HTTP/1.1\r\nHost: localhost\r\n\r\n`, lan) === "refused",
    `connect via LAN address ${lan} refused`);
} else {
  console.log("  skip LAN bind check: no non-loopback IPv4 interface");
}

console.log(`e2e-security: ${pass} passed`);
process.exit(0);
