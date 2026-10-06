// The one websocket to the server, and request/reply correlation over it. A
// request carries an id; the reply comes back with that id and routeReply hands
// it to the callback registered under it.
import type { Var } from "./session";

let ws: WebSocket | null = null;
// Set by App: send() lives at module scope but a dropped command needs to say
// so in the console, which only the component can reach.
let onSendWhileDead: (() => void) | null = null;

export function setSocket(s: WebSocket | null) { ws = s; }
export function setOnSendWhileDead(f: (() => void) | null) { onSendWhileDead = f; }

export function send(obj: any) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  else onSendWhileDead?.();
}

let seq = 0;
// id → the reply's callback. A timeout that finds its id still here deletes it,
// so a reply arriving after the caller gave up is dropped, not delivered twice.
export const pending = new Map<number, (m: any) => void>();

// Send `msg` with a fresh id; `done` gets the whole reply message.
export function request(msg: object, done: (m: any) => void): number {
  const id = ++seq;
  pending.set(id, done);
  send({ ...msg, id });
  return id;
}

// Gives up after `ms`: `fallback` resolves instead, and a late reply is dropped.
export function requestWithin<T>(msg: object, ms: number, fallback: T, done: (m: any) => T): Promise<T> {
  return new Promise((resolve) => {
    const id = request(msg, (m) => resolve(done(m)));
    setTimeout(() => { if (pending.delete(id)) resolve(fallback); }, ms);
  });
}

const REPLIES = new Set([
  "evalResult", "children", "frameLocals", "setVarResult", "disasm", "completions", "memory", "threadStack",
]);

// True when `m` is a reply (routed or, if nobody waits for it any more, dropped).
export function routeReply(m: any): boolean {
  if (!REPLIES.has(m.type)) return false;
  const done = pending.get(m.id);
  if (done) { pending.delete(m.id); done(m); }
  return true;
}

// A `memory` reply's bytes. 0x0 and unmapped pages come back from lldb-dap as
// success with no data, so null covers both that and an error.
export function memBytes(m: any): Uint8Array | null {
  if (m.error || !m.data) return null;
  const bin = atob(m.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Promise wrapper over the expand round-trip, for code that needs to chain
// several fetches (e.g. the register panel walking scope → groups → leaves).
export function expandRef(ref: number): Promise<Var[]> {
  return new Promise((resolve) => { request({ cmd: "expand", ref }, (m) => resolve(m.vars || [])); });
}

// Locals (args included: DAP's first scope) of any frame, not just the selected
// one. Used by the stack drawing to fill every frame box at once. Resolves []
// for frames the adapter can't scope (no debug info).
export const frameLocalsOf = (frameId: number): Promise<Var[]> =>
  requestWithin({ cmd: "frameScopes", frameId }, 3000, [] as Var[], (m) => m.vars || []);

// Read raw bytes at an address WITHOUT touching the main memory view: used to
// peek what a pointer targets (e.g. a const's string). Resolves null on failure.
export const readMemAt = (addr: string, count: number): Promise<Uint8Array | null> =>
  requestWithin({ cmd: "readMem", memoryReference: addr, count }, 3000, null, memBytes);
