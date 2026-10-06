// The target dialog's pure decisions: debugger choice, recent-target dedupe,
// binary summary and its warnings.
// Usage: bun tests/targetinfo.ts

import { debuggerChoice, dedupeRecent, binSummary, binWarnings, pidKeyFor } from "../src/web/ui/src/targetInfo";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}

// ── debugger choice ──
ok(debuggerChoice({ program: "/a" }, "lldb") === "auto", "no type is Auto");
ok(debuggerChoice({ program: "/a", type: "lldb" }, "lldb") === "auto", "the type inference would pick is Auto");
ok(debuggerChoice({ program: "/a", type: "lldb" }, "go") === "lldb", "a type that overrides inference is shown as itself");
ok(debuggerChoice({ program: "/a", type: "lldb", dapPath: "/x/lldb-dap" }, "lldb") === "custom", "a dapPath is Custom");
ok(pidKeyFor("node") === "processId" && pidKeyFor("python") === "processId" && pidKeyFor("go") === "processId"
   && pidKeyFor("lldb") === "pid" && pidKeyFor(undefined) === "pid", "pid key per dialect");

// ── recent targets ──
{
  const hist = [
    { program: "/bin/a", args: ["1"], type: "lldb", env: { X: "2" } },
    { program: "/bin/a", args: ["1"], type: "lldb", env: { X: "1" } },
    { program: "/bin/a", args: ["2"], type: "lldb" },
    { program: "/bin/a", args: ["1"], type: "go" },
    { type: "lldb", request: "attach", pid: 42 },
    { program: "/bin/a", args: ["1"], type: "lldb" },
  ];
  const d = dedupeRecent(hist as any);
  ok(d.length === 3, "identical program+args+type collapse to one row", d);
  ok((d[0] as any).env?.X === "2", "the most recent of the duplicates is kept", d[0]);
  ok(d.some((h) => h.type === "go"), "a different type is a different row", d);
  ok(!d.some((h) => !h.program), "attach-by-pid entries are not launch rows", d);
}

// ── binary summary ──
const mach = { exists: true, format: "Mach-O", arch: "arm64", fileType: "executable", size: 34 * 1024,
               hasDebugInfo: true, debugInfo: "DWARF (.dSYM)", opt: "-O0", optimized: false, goBuildInfo: false };
ok(binSummary(mach) === "Mach-O · arm64 executable · 34 KB · debug info: DWARF (.dSYM) · opt: -O0", "summary line", binSummary(mach));
ok(binSummary({ ...mach, opt: "optimized" }).endsWith("· optimized"), "a worded level stands alone");
ok(binSummary({ ...mach, opt: "unknown" }).endsWith("· opt: unknown"), "unknown says what is unknown");
ok(binSummary({ exists: false }) === "", "nothing to summarise for a missing file");

// ── warnings ──
const texts = (w: any[]) => w.map((x) => x.level + ":" + x.text);
ok(binWarnings(mach, "arm64", "lldb").length === 0, "a clean -O0 -g native build has no warnings", binWarnings(mach, "arm64", "lldb"));
ok(texts(binWarnings({ exists: false }, "arm64", "lldb"))[0] === "warn:file not found: check the path", "missing file");
ok(texts(binWarnings({ ...mach, hasDebugInfo: false }, "arm64", "lldb")).some((t) => t.includes("breakpoints won't bind: rebuild with -g")), "no debug info");
ok(texts(binWarnings({ ...mach, fileType: "object" }, "arm64", "lldb")).some((t) => t.startsWith("warn:not an executable")), "not an executable");
ok(texts(binWarnings({ ...mach, arch: "x86-64" }, "arm64", "lldb")).some((t) => t.includes("built for x86-64, this machine is arm64")), "wrong architecture");
ok(binWarnings({ ...mach, arch: "x86-64" }, "", "lldb").length === 0, "unknown host arch: no arch warning");
const opt = binWarnings({ ...mach, opt: "-O2", optimized: true }, "arm64", "lldb");
ok(texts(opt).some((t) => t === "warn:optimized build: some locals will show as optimized out and stepping may jump; rebuild with -O0 -g to debug"), "optimized build", opt);
ok(binWarnings({ ...mach, opt: "unknown", optimized: false }, "arm64", "lldb").length === 0, "unknown optimization is not a warning");
ok(texts(binWarnings({ ...mach, goBuildInfo: true }, "arm64", "go"))[0] === "info:Go binary, so Delve is used", "Go binary under Delve is a note");
ok(binWarnings({ ...mach, goBuildInfo: true }, "arm64", "lldb")[0].level === "warn", "Go binary under lldb is a warning");
ok(binWarnings({ exists: true, format: "unknown", size: 10 }, "arm64", "python").length === 0, "a script under its interpreter's debugger is not judged as a binary");

console.log(`\ntargetinfo: ${pass} assertions passed`);
