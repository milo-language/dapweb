// Pure decisions behind the target dialog: which debugger a config means, what
// the binary summary says and which of its facts deserve a warning, and how
// recent targets collapse. Kept out of the component so they are unit-tested
// (tests/targetinfo.ts) without a browser.
import type { DebugConfig } from "./configSchema";

// lldb spells it `pid`; debugpy, js-debug and delve spell it `processId`. The UI
// writes the dialect's own key rather than having the server translate, because
// the config is meant to be a verbatim launch.json.
export const pidKeyFor = (t?: string) => (t === "python" || t === "go" || t === "node") ? "processId" : "pid";

// The selector's value for a config. "auto" whenever the config's type is what
// inference would pick anyway: the server echoes the resolved type into every
// config, so an absent type cannot be what marks Auto.
export function debuggerChoice(cfg: DebugConfig, inferred: string): string {
  if (cfg.dapPath) return "custom";
  if (!cfg.type || cfg.type === inferred) return "auto";
  return String(cfg.type);
}

// Recent targets as the dialog lists them: one row per (program, args, type),
// the most recent kept (history is newest first). Server history dedups on a
// wider identity (an attach target, env), which still leaves rows that read
// identically here. Entries with no program (attaches by pid) are not
// launchable from this list.
export function dedupeRecent(hist: DebugConfig[]): DebugConfig[] {
  const seen = new Set<string>();
  const out: DebugConfig[] = [];
  for (const h of hist) {
    if (!h.program) continue;
    const key = JSON.stringify([h.program, (h.args as string[]) || [], h.type || ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// One line, e.g. "Mach-O · arm64 executable · 34 KB · debug info: DWARF (.dSYM) · opt: -O0".
export function binSummary(b: any): string {
  if (!b || b.exists === false) return "";
  const parts: string[] = [];
  if (b.format && b.format !== "unknown") parts.push(b.format);
  const kind = [b.arch, b.fileType].filter(Boolean).join(" ");
  if (kind) parts.push(kind);
  if (typeof b.size === "number") parts.push(fmtSize(b.size));
  if (b.format && b.format !== "unknown") {
    parts.push(b.hasDebugInfo ? `debug info: ${b.debugInfo}` : "no debug info");
    // A flag-shaped level ("-O2", "-N -l") reads as one with the label; the
    // worded ones ("optimized", "not optimized") stand alone.
    const opt = b.opt || "unknown";
    parts.push(opt.startsWith("-") || opt === "unknown" ? `opt: ${opt}` : opt);
  }
  return parts.join(" · ");
}

export type BinWarning = { level: "warn" | "info"; text: string };

// What the summary should call out, most blocking first. `kind` is the debugger
// that will run (inferred or chosen); script debuggers take a source file, so
// the native-binary checks do not apply to them.
export function binWarnings(b: any, hostArch: string, kind: string): BinWarning[] {
  const out: BinWarning[] = [];
  if (!b) return out;
  if (b.exists === false) {
    out.push({ level: "warn", text: "file not found: check the path" });
    return out;
  }
  if (kind === "python" || kind === "node" || kind === "java") return out;
  if (b.goBuildInfo) {
    out.push(kind === "go"
      ? { level: "info", text: "Go binary, so Delve is used" }
      : { level: "warn", text: "Go binary: pick Delve (or Auto) to see goroutines and Go types" });
  }
  const native = b.format && b.format !== "unknown" && b.format !== "universal";
  if (!native) return out;
  if (b.fileType && b.fileType !== "executable") {
    out.push({ level: "warn", text: `not an executable (${b.fileType}): link it into a program to run it` });
  }
  if (b.arch && hostArch && b.arch !== hostArch) {
    out.push({ level: "warn", text: `built for ${b.arch}, this machine is ${hostArch}: rebuild for ${hostArch}` });
  }
  if (!b.hasDebugInfo) {
    out.push({ level: "warn", text: "no debug info: breakpoints won't bind: rebuild with -g" });
  } else if (b.optimized) {
    out.push({ level: "warn", text: "optimized build: some locals will show as optimized out and stepping may jump; rebuild with -O0 -g to debug" });
  }
  return out;
}
