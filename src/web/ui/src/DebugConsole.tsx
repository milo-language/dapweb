import React, { useRef, useState } from "react";
import { pending, request } from "./rpc";

// REPL input for the merged terminal — output (echo + results) is written into
// the shared xterm scrollback via `append`, not a separate log pane.
export function DebugConsole({ append, frame0Ref, canComplete }: {
  append: (t: string, c?: string) => void;
  frame0Ref: React.MutableRefObject<number>;
  canComplete: boolean;
}) {
  const [input, setInput] = useState("");
  const [comps, setComps] = useState<{ label: string; text: string }[] | null>(null);
  const [sel, setSel] = useState(0);
  // Submitted commands, newest-first; histPos walks them (-1 = live input).
  const hist = useRef<string[]>([]);
  const histPos = useRef(-1);
  const submit = () => {
    const expr = input.trim();
    if (!expr) return;
    hist.current = [expr, ...hist.current.filter((h) => h !== expr)].slice(0, 200);
    histPos.current = -1;
    setInput("");
    setComps(null);
    append("› " + expr + "\n", "in");
    request({ cmd: "evaluate", expr, context: "repl", frameId: frame0Ref.current },
            (m) => append(m.value + "\n", m.error ? "err" : ""));
  };
  // Replace the token being completed. DAP targets may carry start/length; the
  // lldb ones usually don't, so fall back to swapping the last word.
  const apply = (t: { text: string }) => {
    setComps(null);
    setInput((cur) => cur.replace(/[A-Za-z_$][\w$]*$/, "") + t.text);
  };
  const complete = () => {
    const id = request({ cmd: "complete", text: input, column: input.length + 1, frameId: frame0Ref.current }, (m) => {
      const targets: any[] = m.targets || [];
      if (!targets.length) return;
      if (targets.length === 1) apply(targets[0]);
      else { setComps(targets.slice(0, 20)); setSel(0); }
    });
    setTimeout(() => pending.delete(id), 2000);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (comps) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % comps.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s + comps.length - 1) % comps.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); apply(comps[sel]); return; }
      if (e.key === "Escape") { setComps(null); return; }
    }
    if (e.key === "Enter") submit();
    else if (e.key === "Tab" && canComplete) { e.preventDefault(); complete(); }
    // Shell-style history: ↑ older, ↓ newer (↓ past newest → back to live input).
    else if (e.key === "ArrowUp") {
      if (!hist.current.length) return;
      e.preventDefault();
      histPos.current = Math.min(histPos.current + 1, hist.current.length - 1);
      setInput(hist.current[histPos.current]);
    } else if (e.key === "ArrowDown") {
      if (histPos.current < 0) return;
      e.preventDefault();
      histPos.current -= 1;
      setInput(histPos.current < 0 ? "" : hist.current[histPos.current]);
    }
  };
  return (
    <div className="console-input">
      {comps && (
        <div className="comps">
          {comps.map((c, i) => (
            <div key={i} className={"comp" + (i === sel ? " sel" : "")}
                 onMouseDown={(e) => { e.preventDefault(); apply(c); }}>{c.label}</div>
          ))}
        </div>
      )}
      <span className="prompt">›</span>
      <input value={input} onChange={(e) => { setInput(e.target.value); setComps(null); histPos.current = -1; }}
             onKeyDown={onKey}
             placeholder={canComplete ? "expression or debugger command… (Tab completes)" : "expression or debugger command…"} />
    </div>
  );
}
