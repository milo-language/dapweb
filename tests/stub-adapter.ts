// A DAP adapter that debugs nothing. It exists so gates can assert what dapweb
// SENDS without needing a real debuggee or ptrace permission: attaching to a
// live process is blocked by kernel.yama.ptrace_scope on stock Ubuntu, so the
// attach path could not otherwise be covered in CI at all.
//
// Every request is appended to $STUB_LOG as one JSON line, verbatim.
// Usage (as a dapweb config): { "dapPath": "bun tests/stub-adapter.ts" }

import { appendFileSync } from "fs";

const log = process.env.STUB_LOG;

// process.stdout.write, not Bun.write(Bun.stdout): Bun.write is async and two
// in-flight writes can interleave, which splits a DAP frame down the middle.
//
// The header is spelled in lower case ON PURPOSE. LSP's base protocol, which DAP
// borrows wholesale, treats header field names as HTTP-style and therefore
// case-insensitive, so "content-length" is a conformant peer and not a malformed
// one. dapweb used to match the exact case and would hang on this stub forever.
function send(msg: any) {
  const body = JSON.stringify(msg);
  process.stdout.write(`content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

let seq = 0;
const event = (e: string, body?: any) => send({ seq: ++seq, type: "event", event: e, body });
const reply = (req: any, body?: any) =>
  send({ seq: ++seq, type: "response", request_seq: req.seq, success: true, command: req.command, body });

function handle(req: any) {
  if (log) appendFileSync(log, JSON.stringify(req) + "\n");
  switch (req.command) {
    case "initialize":
      reply(req, { supportsConfigurationDoneRequest: true, supportsFunctionBreakpoints: true });
      event("initialized");
      return;
    case "setFunctionBreakpoints":
    case "setBreakpoints": {
      const n = (req.arguments?.breakpoints ?? []).length;
      reply(req, { breakpoints: Array.from({ length: n }, (_, i) => ({ id: i + 1, verified: true, line: 1 })) });
      return;
    }
    case "configurationDone":
      reply(req);
      // The whole point of the stub: a stop that the test can wait on, so a run
      // that never stops fails as a timeout rather than hanging the suite.
      event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
      return;
    case "threads":
      reply(req, { threads: [{ id: 1, name: "stub" }] });
      return;
    case "stackTrace":
      reply(req, { stackFrames: [{ id: 1, name: "stub_frame", line: 1, column: 1 }], totalFrames: 1 });
      return;
    case "scopes":
      reply(req, { scopes: [] });
      return;
    case "disconnect":
    case "terminate":
      reply(req);
      event("terminated");
      setTimeout(() => process.exit(0), 50);
      return;
    default:
      reply(req, {});
  }
}

// Content-Length framing, byte-exact: the header counts bytes, not characters,
// so the buffer stays a Buffer until the body is sliced off.
let buf = Buffer.alloc(0);
for await (const chunk of Bun.stdin.stream()) {
  buf = Buffer.concat([buf, Buffer.from(chunk)]);
  for (;;) {
    const head = buf.indexOf("\r\n\r\n");
    if (head < 0) break;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, head).toString("utf8"));
    if (!m) { buf = buf.subarray(head + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < head + 4 + len) break;
    const body = buf.subarray(head + 4, head + 4 + len).toString("utf8");
    buf = buf.subarray(head + 4 + len);
    try { handle(JSON.parse(body)); } catch {}
  }
}
