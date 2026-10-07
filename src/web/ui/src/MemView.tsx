import React, { useEffect, useMemo, useState } from "react";
import type { Frame, Var } from "./session";
import { expandRef, readMemAt } from "./rpc";
import { RegionType, REGION_HELP } from "./regions";
import { Val } from "./Val";
import { CtxMenu } from "./CtxMenu";

// Printable-ASCII prefix of a byte buffer, up to the first NUL. Returns "" if it
// doesn't start with a decent (≥2 char) run — i.e. probably not a C string.
function decodeCStr(bytes: Uint8Array | null): string {
  if (!bytes) return "";
  let s = "";
  for (const b of bytes) {
    if (b === 0) break;
    if (b < 0x20 || b > 0x7e) return "";           // non-printable → not a string
    s += String.fromCharCode(b);
    if (s.length >= 40) { s += "…"; break; }
  }
  return s.length >= 2 ? s : "";
}

// Heap text is usually not NUL-terminated (a string's bytes sit in a buffer with
// a length elsewhere), so accept a printable run that stops at anything else.
// Three characters minimum: two printable bytes are common in pointer data.
function decodeTextPrefix(bytes: Uint8Array | null): string {
  if (!bytes) return "";
  let s = "";
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) break;
    s += String.fromCharCode(b);
    if (s.length >= 40) { s += "…"; break; }
  }
  return s.length >= 3 ? s : "";
}

// A per-slot annotation for an 8-byte group: what this word *is* — a typed
// local (from DWARF), a saved frame pointer / return address, or a pointer into
// a named region. `follow` (present on typed pointers) opens the struct view.
type Anno = { text: string; full?: string; cls?: string; follow?: { ref: number; name: string; type: string; target: string } };

// hex/dec/bin dump with ASCII column, 16 bytes per row. Slots are annotated
// with DWARF/frame knowledge and typed pointers can be followed into their struct.
export function MemView({ mem, addr, setAddr, err, enabled, onLoad, classify, locals, frames, regFrame, onWatch }: {
  mem: { addr: string; bytes: Uint8Array } | null;
  addr: string; setAddr: (a: string) => void; err: string;
  enabled: boolean; onLoad: (a: string) => void;
  classify: ((a: string) => RegionType | null) | null;
  locals: Var[]; frames: Frame[];
  regFrame: { sp: string; fp: string; lr: string };
  // Right-click a word: break when it changes. Absent when the adapter cannot
  // watch a raw address or nothing is stopped.
  onWatch?: (addr: string, size: number) => void;
}) {
  const [radix, setRadix] = useState<16 | 10 | 2>(16);
  // Element size in bytes (8/16/32/64-bit). Bytes group into little-endian
  // values of this width. Pointer chase + annotations still key off the 8-byte
  // word (a multiple of every stride), so they keep working at any stride.
  const [stride, setStride] = useState<1 | 2 | 4 | 8>(8);   // default 64-bit words
  // DWARF struct-follow panel: a typed pointer expanded into its members.
  const [follow, setFollow] = useState<{ name: string; type: string; target: string; rows: Var[] } | null>(null);
  // Peeked target previews: pointer-target hex → decoded C-string ("" = fetched,
  // no string). Const/data pointers are auto-peeked so literals show inline.
  const [peeks, setPeeks] = useState<Map<string, string>>(new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; addr: string; size: number } | null>(null);
  // Digits per element by radix×stride; dec padded to the max value's width.
  const decLen: Record<number, number> = { 1: 3, 2: 5, 4: 10, 8: 20 };
  const elemChars = radix === 16 ? 2 * stride : radix === 2 ? 8 * stride : decLen[stride];
  const elemsPerWord = 8 / stride;
  const page = (dir: number) => {
    if (!mem) return;
    try { onLoad("0x" + (BigInt(mem.addr) + BigInt(dir * 256)).toString(16)); } catch {}
  };
  const doFollow = (f: NonNullable<Anno["follow"]>) =>
    expandRef(f.ref).then((rows) => setFollow({ name: f.name, type: f.type, target: f.target, rows }));
  // A new window invalidates the follow panel (its slot is no longer on screen).
  useEffect(() => { setFollow(null); }, [mem?.addr]);

  // Read-only pointers in the current window whose targets we peek for an inline
  // string preview. const/data hold literals & constants; on macOS C string
  // literals live in __TEXT (classified code), so include code too — but skip
  // return addresses (frame pcs), which are instructions, never strings.
  const peekTargets = useMemo(() => {
    const s = new Set<string>();
    if (!mem) return s;
    const ips = new Set(frames.map((f) => { try { return BigInt(f.ipRef).toString(); } catch { return ""; } }));
    for (let off = 0; off + 8 <= mem.bytes.length; off += 8) {
      let ptr = 0n;
      for (let i = 7; i >= 0; i--) ptr = (ptr << 8n) | BigInt(mem.bytes[off + i]);
      if (ptr < 0x10000n || ptr >= 0x800000000000n) continue;
      const preg = classify ? classify("0x" + ptr.toString(16)) : null;
      if ((preg === "const" || preg === "data" || preg === "code" || preg === "heap") && !ips.has(ptr.toString()))
        s.add("0x" + ptr.toString(16));
    }
    return s;
  }, [mem, classify, frames]);
  // Fetch the strings for any not-yet-seen targets (bounded per window).
  useEffect(() => {
    let live = true;
    const missing = [...peekTargets].filter((t) => !peeks.has(t)).slice(0, 24);
    if (!missing.length) return;
    Promise.all(missing.map(async (t) => {
      const bytes = await readMemAt(t, 48);
      const heap = classify ? classify(t) === "heap" : false;
      return [t, heap ? decodeTextPrefix(bytes) : decodeCStr(bytes)] as const;
    }))
      .then((pairs) => {
        if (!live) return;
        setPeeks((prev) => { const n = new Map(prev); for (const [t, str] of pairs) n.set(t, str); return n; });
      });
    return () => { live = false; };
  }, [peekTargets]);

  // Precompute annotation sources. Addresses are parsed to BigInt once.
  const bi = (s: string): bigint | null => { try { return s ? BigInt(s) : null; } catch { return null; } };
  const localByAddr = new Map<string, Var>();
  for (const v of locals) { const a = bi(v.mref || ""); if (a !== null) localByAddr.set(a.toString(), v); }
  const fpN = bi(regFrame.fp), lrN = bi(regFrame.lr), spN = bi(regFrame.sp);
  const frameIps = frames.map((f) => ({ ip: bi(f.ipRef), name: f.name })).filter((f) => f.ip !== null);

  // What is the 8-byte word at `slotAddr` (value `ptr`)? Most specific first.
  const annotate = (slotAddr: bigint, ptr: bigint, looksPtr: boolean): Anno | null => {
    const preg = looksPtr && classify ? classify("0x" + ptr.toString(16)) : null;
    const local = localByAddr.get(slotAddr.toString());
    if (local) {
      const isPtr = !!local.type && (local.type.includes("*") || (looksPtr && !!preg));
      if (isPtr && looksPtr) {
        const follow = local.ref > 0
          ? { ref: local.ref, name: local.name, type: local.type || "?", target: "0x" + ptr.toString(16) }
          : undefined;
        const str = peeks.get("0x" + ptr.toString(16));
        return { text: `${local.name}${preg ? ` → ${preg}` : ""}`,
                 full: `${local.name} ${local.type || ""} → 0x${ptr.toString(16)}${preg ? ` (${preg})` : ""}${str ? `  ${JSON.stringify(str)}` : ""}`,
                 cls: preg ? "t-" + preg : undefined, follow };
      }
      return { text: `${local.name} = ${local.value}`,
               full: `${local.name} ${local.type ? local.type + " " : ""}= ${local.value}` };
    }
    // Frame anatomy: fp points at the saved (fp, lr) pair; sp at the stack top.
    if (fpN !== null && slotAddr === fpN)
      return { text: "saved fp", full: "saved fp · x29 → caller frame", cls: "t-stack" };
    if (fpN !== null && slotAddr === fpN + 8n)
      return { text: "return addr", full: `saved lr · return address${preg ? ` into ${preg}` : ""}`,
               cls: preg ? "t-" + preg : "t-code" };
    if (spN !== null && slotAddr === spN) return { text: "sp", full: "sp · top of stack", cls: "t-stack" };
    if (!looksPtr) return null;
    // A word whose value is a known frame's pc — a return address into that fn.
    const fr = frameIps.find((f) => f.ip === ptr);
    if (fr) return { text: `→ ${fr.name}`, full: `→ ${fr.name} (code)`, cls: "t-code" };
    if (preg) {
      const str = peeks.get("0x" + ptr.toString(16));
      // The address itself is already in the row above, tinted by region — the
      // label repeats only what the row cannot show: the region, or the string.
      return { text: str ? `→ ${JSON.stringify(str)}` : `→ ${preg}`,
               full: `→ 0x${ptr.toString(16)} (${preg})${str ? `  ${JSON.stringify(str)}` : ""}`, cls: "t-" + preg };
    }
    return null;
  };

  const rows: React.ReactNode[] = [];
  if (mem) {
    let baseAddr = 0n;
    try { baseAddr = BigInt(mem.addr); } catch {}
    for (let off = 0; off < mem.bytes.length; off += 16) {
      const chunk = mem.bytes.slice(off, off + 16);
      // 8-byte aligned groups; a group whose little-endian value lands in the
      // user-space address range is clickable — pointer chasing (list->next)
      // without reversing byte order by hand.
      const groups: React.ReactNode[] = [];
      const annos: (Anno | null)[] = [];
      for (let g = 0; g < chunk.length; g += 8) {
        const sub = chunk.slice(g, g + 8);
        // Render the word as `elemsPerWord` little-endian elements of `stride` bytes.
        // Each element is its own span so a right-click knows which word (and
        // how wide) to watch: the stride the user picked is the size they mean.
        const els: React.ReactNode[] = [];
        for (let k = 0; k + stride <= sub.length; k += stride) {
          let v = 0n;
          for (let i = stride - 1; i >= 0; i--) v = (v << 8n) | BigInt(sub[k + i]);
          const at = "0x" + (baseAddr + BigInt(off + g + k)).toString(16);
          if (k > 0) els.push(" ");
          els.push(
            <span key={k} className={menu?.addr === at ? "memsel" : undefined}
                  onContextMenu={onWatch ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, addr: at, size: stride }); } : undefined}>
              {v.toString(radix).padStart(elemChars, "0")}
            </span>);
        }
        const text = els;
        let ptr = 0n;
        for (let i = sub.length - 1; i >= 0; i--) ptr = (ptr << 8n) | BigInt(sub[i]);
        const looksPtr = sub.length === 8 && ptr >= 0x10000n && ptr < 0x800000000000n;
        if (g > 0) groups.push(<span key={`gap${g}`}>{"  "}</span>);
        // A detected pointer is tinted by the region it targets — so you can see
        // "this 8-byte slot points into the stack / heap / code" at a glance.
        const preg = looksPtr && classify ? classify("0x" + ptr.toString(16)) : null;
        groups.push(looksPtr
          ? <span key={g} className={"memptr" + (preg ? " t-" + preg : "")}
                  title={preg ? `follow 0x${ptr.toString(16)}  →  ${REGION_HELP[preg]}` : `follow 0x${ptr.toString(16)}`}
                  onClick={() => onLoad("0x" + ptr.toString(16))}>{text}</span>
          : <span key={g}>{text}</span>);
        annos.push(sub.length === 8 ? annotate(baseAddr + BigInt(off + g), ptr, looksPtr) : null);
      }
      const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "·")).join("");
      // Annotations sit in a fixed-width column at the end of the row, one cell
      // per 8-byte word in word order, each clipped with the full text on hover.
      // Lines under the dump made rows two or one lines tall, and the dump
      // stopped reading as a grid.
      rows.push(
        <div key={off} className="memrow">
          <span className="memaddr">0x{(baseAddr + BigInt(off)).toString(16).padStart(12, "0")}</span>
          <span className="membytes">{groups}</span>
          <span className="memascii">{ascii}</span>
          {/* One column, not one cell per word: a cell per word put a right-hand
              word's label far out at the edge and the column read as a zigzag.
              With both words labelled, each says which it is (+0 / +8). */}
          <span className="memannos">
            {annos.map((a, wi) => a && (
              <span key={wi} className="annocell"
                    title={a.follow ? `follow ${a.follow.name} → ${a.follow.target}  (typed as ${a.follow.type})` : (a.full || a.text)}>
                {annos.filter(Boolean).length > 1 && <span className="annoff">+{wi * 8}</span>}
                <span className={"anno" + (a.cls ? " " + a.cls : "") + (a.follow ? " annofollow" : "")}
                      onClick={a.follow ? () => doFollow(a.follow!) : undefined}>{a.text}</span>
              </span>
            ))}
          </span>
        </div>
      );
    }
  }
  return (
    <div className="memview">
      <div className="memctl">
        <input value={addr} placeholder="0x… address" spellCheck={false}
               onChange={(e) => setAddr(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && enabled && addr && onLoad(addr)} />
        <button disabled={!enabled || !addr} onClick={() => onLoad(addr)}>Go</button>
        <button disabled={!mem} onClick={() => page(-1)}>◀</button>
        <button disabled={!mem} onClick={() => page(1)}>▶</button>
        {([16, 10, 2] as const).map((r) => (
          <button key={r} className={radix === r ? "radix-on" : ""} onClick={() => setRadix(r)}>
            {r === 16 ? "hex" : r === 10 ? "dec" : "bin"}
          </button>
        ))}
        <span className="memctl-sep" />
        {([8, 16, 32, 64] as const).map((bits) => {
          const s = (bits / 8) as 1 | 2 | 4 | 8;
          return (
            <button key={bits} className={stride === s ? "radix-on" : ""} title={`${bits}-bit elements`}
                    onClick={() => setStride(s)}>{bits}</button>
          );
        })}
        {!enabled && <span className="hint">stop the program to read memory</span>}
      </div>
      {mem && (() => {
        // The window's own region is shown by lighting up its legend entry — no
        // banner sentence. Hover a swatch for the plain-English explanation.
        const reg = classify ? classify(mem.addr) : null;
        return (
          <div className="membanner">
            <span className="memlegend">
              {(["stack", "heap", "code", "const", "data"] as RegionType[]).map((t) => (
                <span key={t} className={"memleg" + (t === reg ? " memleg-on" : "")} title={REGION_HELP[t]}>
                  <span className={"rdot b-" + t} />{t}
                </span>
              ))}
            </span>
          </div>
        );
      })()}
      <div className="memdump">
        {err
          ? <span className="mem-err">{err}</span>
          : rows.length ? rows
          : <span className="hint">click ⌗ next to a variable, a 0x… address in Locals/Watch, or enter one above</span>}
      </div>
      {menu && onWatch && (
        <CtxMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
                 items={[{ label: "Break when value changes", hint: `${menu.size * 8}-bit at ${menu.addr}`,
                           onClick: () => onWatch(menu.addr, menu.size) }]} />
      )}
      {follow && (
        <div className="followpanel">
          <div className="follow-hd">
            follow <b>{follow.name}</b> → {follow.target} · typed as <b>{follow.type}</b> (DWARF)
            <span className="follow-x" onClick={() => setFollow(null)}>✕</span>
          </div>
          {follow.rows.length
            ? follow.rows.map((v, i) => (
                <div key={i} className="follow-row">
                  <span className="follow-name">{v.name}</span>
                  <span className="follow-type">{v.type || ""}</span>
                  <span className="follow-val"><Val text={v.value} onAddr={onLoad} /></span>
                </div>
              ))
            : <div className="hint">no members</div>}
        </div>
      )}
    </div>
  );
}
