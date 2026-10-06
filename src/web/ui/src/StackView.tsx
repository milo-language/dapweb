import React, { useEffect, useState } from "react";
import { Frame, Var, hasSrc } from "./session";
import { frameLocalsOf, readMemAt } from "./rpc";

// One box in the stack drawing: a call frame spanning `lo`..`hi`, tied to DAP
// frame index `fi`. `fp` is null for a frameless frame — a leaf whose prologue
// clang elided, so it pushed no (fp, lr) pair and owns no chain link.
type FrameBox = {
  fi: number; name: string; lo: bigint; hi: bigint;
  fp: bigint | null; savedFp: bigint; savedLr: bigint;
  sized: boolean;   // false when the span is a guess (frameless, from locals)
};
// A local placed on the stack: its address, and which frame scoped it.
type Slot = Var & { at: bigint; owner: number };
// One link of the fp chain, before we know which frame it belongs to.
type Link = { fp: bigint; savedFp: bigint; savedLr: bigint };

const biOf = (s: string): bigint | null => { try { return s ? BigInt(s) : null; } catch { return null; } };
const le64 = (b: Uint8Array, off: number) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
};
const hex = (v: bigint) => "0x" + v.toString(16);

// Stack drawing: high addresses on top, the stack growing down the page just as
// it grows down in memory. Frames come from walking the AArch64 fp chain —
// [fp] = caller's fp, [fp+8] = return address — rather than from the adapter's
// stackTrace, because only the chain gives us the actual byte boundaries. The
// adapter's frame names are laid over it (chain depth i ↔ frame i).
export function StackView({ enabled, regFrame, frames, stopSeq, onAddr }: {
  enabled: boolean;
  regFrame: { sp: string; fp: string; lr: string };
  frames: Frame[]; stopSeq: number;
  onAddr: (a: string) => void;
}) {
  const [boxes, setBoxes] = useState<FrameBox[]>([]);
  // Every frame's locals, tagged with the frame they were scoped in. Placement
  // is by address, not by owner: a struct returned by value lives in the
  // *caller's* frame (sret), and the drawing should show it where it is.
  const [vars, setVars] = useState<Slot[]>([]);
  const sp = biOf(regFrame.sp);

  useEffect(() => {
    const fp0 = biOf(regFrame.fp);
    if (!enabled || fp0 === null || fp0 === 0n || !frames.length) { setBoxes([]); setVars([]); return; }
    let live = true;
    (async () => {
      // 1. Walk the chain. 24 levels is plenty for a screenful; a corrupt link
      // (a smashed frame) is cut off by the checks below, never looped on.
      const links: Link[] = [];
      let fp = fp0;
      for (let i = 0; i < 24; i++) {
        const b = await readMemAt(hex(fp), 16);
        if (!live) return;
        if (!b || b.length < 16) break;
        links.push({ fp, savedFp: le64(b, 0), savedLr: le64(b, 8) });
        // Chain ends at 0 (the outermost frame parks it there); a non-increasing
        // fp means we're not looking at a real frame link anymore.
        if (links[i].savedFp === 0n || links[i].savedFp <= fp) break;
        fp = links[i].savedFp;
      }

      // 2. Which DAP frame does each link belong to? Not simply "link k ↔ frame
      // k": a leaf whose prologue clang elided (no calls, few locals) pushes no
      // (fp, lr) pair, so the fp register still holds its *caller's* fp and the
      // leaf owns no link. Identify a link by its saved lr, which is the return
      // address into the caller — exactly the pc DAP reports for that caller's
      // frame. Link with savedLr == frames[j].ipRef therefore belongs to frame
      // j-1. Frames that no link claims are frameless.
      const ipToFrame = new Map<string, number>();
      frames.forEach((f, j) => { const a = biOf(f.ipRef); if (a !== null && j > 0) ipToFrame.set(a.toString(), j); });
      const fiOf = new Map<number, number>();      // link index → dap frame index
      let fallback = 0;
      links.forEach((l, k) => {
        const j = ipToFrame.get(l.savedLr.toString());
        const fi = j !== undefined ? j - 1 : fallback;
        fiOf.set(k, fi);
        fallback = fi + 1;
      });
      const linkOfFrame = new Map<number, Link>();
      fiOf.forEach((fi, k) => linkOfFrame.set(fi, links[k]));

      // 3. Locals for every drawn frame — one scopes+variables round-trip each,
      // issued strictly in sequence. Overlapping them drops a frame's variables
      // (lldb-dap serves one request at a time and answers the later `scopes`
      // against the earlier frame), so the concurrency would buy nothing anyway.
      // Address-less locals live in registers, not on the stack — skip them.
      // Dedupe by address: an sret buffer is named in both frames that see it.
      const depth = Math.min(frames.length, Math.max(links.length, [...fiOf.values()].reduce((a, b) => Math.max(a, b), 0) + 1));
      const slots: Slot[] = [];
      const seen = new Set<string>();
      for (let fi = 0; fi < depth; fi++) {
        const vs = await frameLocalsOf(frames[fi].id);
        if (!live) return;
        for (const v of vs) {
          const a = biOf(v.mref || "");
          if (a === null || seen.has(a.toString())) continue;
          seen.add(a.toString());
          slots.push({ ...v, at: a, owner: fi });
        }
      }

      // 4. Bounds, innermost frame first: each frame starts where the frame it
      // called ended (the innermost starts at sp) and ends past its saved pair.
      // A frameless frame has no saved pair to end at, so its extent is inferred
      // from its highest local — a guess, flagged as one.
      const out: FrameBox[] = [];
      let prevHi = sp ?? fp0;
      for (let fi = 0; fi < depth; fi++) {
        const l = linkOfFrame.get(fi);
        const lo = prevHi;
        let hi: bigint, sized = true;
        if (l) hi = l.fp + 16n;
        else {
          const mine = slots.filter((v) => v.owner === fi);
          hi = mine.length ? mine.reduce((m, v) => (v.at > m ? v.at : m), lo) + 8n : lo;
          sized = false;
        }
        out.push({
          fi, name: frames[fi]?.name ?? "…", lo, hi, sized,
          fp: l?.fp ?? null, savedFp: l?.savedFp ?? 0n, savedLr: l?.savedLr ?? 0n,
        });
        prevHi = hi;
      }
      setBoxes(out);
      setVars(slots);
    })();
    return () => { live = false; };
  }, [enabled, regFrame.fp, regFrame.sp, stopSeq, frames]);

  if (!enabled) return <div className="stackview"><span className="hint">stop the program to draw the stack</span></div>;
  if (!boxes.length) return <div className="stackview"><span className="hint">no frame pointer — nothing to unwind</span></div>;

  const deep = boxes[boxes.length - 1].hi - (sp ?? boxes[0].lo);
  // Locals belong to the frame lldb scoped them in — that's authoritative, and
  // an address alone can't tell you (a by-value return buffer sits in the
  // caller's frame). High→low so rows read in the drawing's direction.
  const localsIn = (b: FrameBox) =>
    vars.filter((v) => v.owner === b.fi).sort((p, q) => (q.at > p.at ? 1 : -1));

  return (
    <div className="stackview">
      <div className="stackhd">
        <span>call stack · {boxes.length} frame{boxes.length > 1 ? "s" : ""} · {deep.toString()} B</span>
        <span className="stackgrow" title="the stack pointer moves toward lower addresses on every call">
          high addr ↑ · grows ↓
        </span>
      </div>
      {/* Outermost (oldest, highest address) first — matches memory top-down. */}
      {[...boxes].reverse().map((b) => {
        const callee = boxes[b.fi - 1];             // the frame this one called
        const caller = boxes[b.fi + 1];             // the frame that called this
        const mine = localsIn(b);
        return (
          <div key={b.fi} className={"sframe" + (b.fi === 0 ? " sframe-cur" : "")}>
            <div className="sf-hd">
              <span className="sf-idx">#{b.fi}</span>
              <span className="sf-name">{b.name}</span>
              {!b.fp && <span className="sf-frameless" title="leaf function — clang elided the prologue, so this frame pushed no (fp, lr) pair and its extent is inferred from its locals">frameless</span>}
              <span className="sf-size">{b.sized ? "" : "~"}{(b.hi - b.lo).toString()} B</span>
              {b.fi === 0 && <span className="sf-badge">executing</span>}
            </div>
            <div className="sf-slots">
              {/* fp+8 and fp: the saved pair every non-leaf prologue pushes. */}
              {b.fp !== null && <>
                <div className="sf-slot" onClick={() => onAddr(hex(b.fp! + 8n))}>
                  <span className="sf-a">{hex(b.fp + 8n)}</span>
                  <span className="sf-k">saved lr</span>
                  <span className="sf-v t-code">→ {caller ? caller.name : hex(b.savedLr)}</span>
                </div>
                <div className="sf-slot" onClick={() => onAddr(hex(b.fp!))}>
                  <span className="sf-a">{hex(b.fp)}</span>
                  <span className="sf-k">saved fp</span>
                  <span className="sf-v t-stack">→ {b.savedFp ? hex(b.savedFp) : "0 (chain end)"}</span>
                </div>
              </>}
              {mine.length > 0
                ? mine.map((v) => (
                    <div key={v.name} className="sf-slot sf-local" onClick={() => onAddr(hex(v.at))}>
                      <span className="sf-a">{hex(v.at)}</span>
                      <span className="sf-k">{v.name}</span>
                      <span className="sf-v">
                        {v.type ? <em>{v.type} </em> : null}= {v.value}
                        {/* A local scoped here but living above this frame is a
                            by-value return buffer the caller allocated for us. */}
                        {v.at >= b.hi &&
                          <span className="sf-sret" title={`${v.name} lives in ${caller?.name ?? "the caller"}'s frame — a struct returned by value is written straight into the caller's buffer (sret)`}>
                            {" "}· sret, in {caller?.name ?? "caller"}'s frame
                          </span>}
                      </span>
                    </div>
                  ))
                : <div className="sf-slot sf-empty">
                    <span className="sf-a">{hex(b.lo)}</span>
                    <span className="sf-k">no locals</span>
                    <span className="sf-v">
                      {(b.hi - b.lo - (b.fp !== null ? 16n : 0n)).toString()} B — saved regs, spills{frames[b.fi] && !hasSrc(frames[b.fi].path) ? ", no debug info" : ""}
                    </span>
                  </div>}
            </div>
            {b.fi === 0 && sp !== null && (
              <div className="sf-sp" onClick={() => onAddr(hex(sp))}>
                <span className="sf-a">{hex(sp)}</span>
                <span className="sf-k">sp</span>
                <span className="sf-v">top of stack — next push lands below</span>
              </div>
            )}
            {callee && <div className="sf-link">↑ {callee.name} returns here</div>}
          </div>
        );
      })}
      <div className="stackfoot">↓ unallocated — the stack grows this way</div>
    </div>
  );
}
