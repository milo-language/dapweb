// The parts of the debug-target config that are pure data: the launch.json
// schema, the JSONC dialect it is written in, and the rules deciding which
// fields a given config gets. Split out of ConfigDrawer so it carries no monaco
// import — the drawer cannot be loaded outside a browser, and these rules are
// exactly the ones worth a test.

// The config IS a VS Code launch-configuration object: program + any launch.json
// keys (type/request/name/args/env/cwd/...) pass through verbatim to the adapter.
export type DebugConfig = { type?: string; request?: string; program?: string; source?: string; dapPath?: string; [k: string]: any };

// Per-type schema (allOf + if/then keyed on `type`) so Monaco autocompletes the
// keys each adapter actually understands. additionalProperties stays true: any
// adapter-specific key we didn't enumerate is warned (below) but still valid and
// passed verbatim to the DAP body — matches how VS Code treats launch.json.
export const COMMON = {
  type: { type: "string", enum: ["lldb", "python", "go", "java", "node"], description: "debugger dialect (inferred from program when unset)" },
  request: { type: "string", enum: ["launch", "attach"], description: "launch a program (default) or attach to a running one" },
  name: { type: "string", description: "optional label — shown in history" },
  program: { type: "string", description: "launch: path to the debuggee binary/script" },
  args: { type: "array", items: { type: "string" }, description: "command-line arguments to the debuggee" },
  cwd: { type: "string", description: "working directory for the debuggee" },
  env: { type: "object", additionalProperties: { type: "string" }, description: "environment variables" },
  stopOnEntry: { type: "boolean", description: "break at the program's entry point" },
  stopAtMain: { type: "boolean", description: "dapweb: break at main / first user line on launch" },
  // ── dapweb transport envelope (stripped before the DAP request) ──
  dapPath: { type: "string", description: 'DAP adapter command for stdio, e.g. "lldb-dap", "dlv dap", "python3 -m debugpy.adapter" (else probed from type)' },
  port: { type: "integer", description: "connect to a DAP adapter over TCP on this port instead of spawning one" },
  host: { type: "string", description: "TCP host for `port` (default 127.0.0.1)" },
  source: { type: "string", description: "main source file (optional — auto-detected from the first stop)" },
};

export const SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: COMMON,
  required: ["type"],
  allOf: [
    {
      if: { properties: { type: { const: "lldb" } } },
      then: { properties: {
        initCommands: { type: "array", items: { type: "string" }, description: "lldb commands run before the target is created" },
        preRunCommands: { type: "array", items: { type: "string" }, description: "lldb commands run after the target is created, before launch" },
        stopCommands: { type: "array", items: { type: "string" }, description: "lldb commands run each time the program stops" },
        exitCommands: { type: "array", items: { type: "string" }, description: "lldb commands run when the program exits" },
        launchCommands: { type: "array", items: { type: "string" }, description: "custom lldb commands to launch (replaces the default launch)" },
        attachCommands: { type: "array", items: { type: "string" }, description: "custom lldb commands to attach" },
        disableASLR: { type: "boolean", description: "disable address-space layout randomization" },
        pid: { type: "integer", description: "attach: process id to attach to" },
        waitFor: { type: "boolean", description: "attach: wait for the next process named like `program` to launch" },
      } },
    },
    {
      if: { properties: { type: { const: "python" } } },
      then: { properties: {
        module: { type: "string", description: "run a module (python -m) instead of a program file" },
        python: { type: "string", description: "python interpreter path" },
        justMyCode: { type: "boolean", description: "restrict debugging to user-written code" },
        console: { type: "string", enum: ["integratedTerminal", "internalConsole", "externalTerminal"], description: "where the debuggee's stdio goes" },
        subProcess: { type: "boolean", description: "follow child processes" },
        processId: { type: "integer", description: "attach: process id to attach to" },
        connect: { type: "object", properties: { host: { type: "string" }, port: { type: "integer" } }, description: "attach: connect to a running debugpy server" },
      } },
    },
    {
      if: { properties: { type: { const: "go" } } },
      then: { properties: {
        mode: { type: "string", enum: ["debug", "exec", "test"], description: "delve launch mode" },
        buildFlags: { type: "string", description: "flags passed to `go build`" },
        processId: { type: "integer", description: "attach: process id to attach to" },
      } },
    },
    {
      if: { properties: { type: { const: "node" } } },
      then: { properties: {
        runtimeExecutable: { type: "string", description: "node/deno/etc executable" },
        runtimeArgs: { type: "array", items: { type: "string" } },
        skipFiles: { type: "array", items: { type: "string" }, description: "glob patterns to skip while stepping" },
        outFiles: { type: "array", items: { type: "string" }, description: "generated-JS glob patterns for source-map lookup" },
      } },
    },
  ],
};

// Comments + trailing commas → strict JSON (string-aware; mirrors the server's
// jsonStripJsonc so both ends accept the same dialect).
export function stripJsonc(s: string): string {
  let out = "", i = 0, inStr = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; }
    else if (c === "/" && s[i + 1] === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; }
    else out += s[i++];
  }
  // trailing commas: `,` directly before a closing bracket (whitespace between ok)
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// ── The form half ───────────────────────────────────────────────────────────
//
// Fields are READ OUT OF SCHEMA rather than listed again here: SCHEMA.properties
// is the common set, and each allOf branch's if/then is the per-dialect set. A
// key added to the schema for autocomplete therefore shows up in the form too,
// and the label and help text are the schema's own `description`, so the two
// halves of the drawer cannot describe the same key differently.

export type Field = { key: string; schema: any };

// Which keys make sense for launch vs attach. The schema branches on `type`
// only, because that is all a JSON validator can usefully say — "args is
// meaningless when attaching" is a UI judgement, not a validity one, and a
// config carrying both still passes and still runs.
export const ATTACH_ONLY = new Set(["pid", "processId", "connect", "waitFor", "attachCommands"]);
export const LAUNCH_ONLY = new Set(["args", "cwd", "console", "mode", "buildFlags", "module",
                             "runtimeExecutable", "runtimeArgs", "launchCommands", "stopOnEntry"]);

// The handful worth seeing before anything else: what to debug, and how to
// name it. Everything else lands under Advanced, because a form that opens with
// thirty inputs is the sidebar we are trying to stop shipping.
export const PRIMARY = ["type", "request", "program", "pid", "processId", "args", "source", "name", "stopAtMain"];

export function branchProps(type: string | undefined): Record<string, any> {
  for (const b of SCHEMA.allOf as any[]) {
    if (b.if?.properties?.type?.const === type) return b.then?.properties ?? {};
  }
  return {};
}

export function fieldsFor(cfg: DebugConfig): { primary: Field[]; advanced: Field[] } {
  const all: Record<string, any> = { ...COMMON, ...branchProps(cfg.type) };
  const attach = cfg.request === "attach";
  const keep = Object.keys(all).filter((k) => (attach ? !LAUNCH_ONLY.has(k) : !ATTACH_ONLY.has(k)));
  const primary: Field[] = [];
  for (const k of PRIMARY) if (keep.includes(k)) primary.push({ key: k, schema: all[k] });
  const seen = new Set(primary.map((f) => f.key));
  const advanced = keep.filter((k) => !seen.has(k)).sort().map((k) => ({ key: k, schema: all[k] }));
  return { primary, advanced };
}

// Keys the user wrote that the schema has never heard of. They are valid and go
// to the adapter verbatim (additionalProperties stays true), so the form has to
// admit they exist — silently not rendering them is how a form convinces someone
// their config is smaller than it is.
export function unknownKeys(cfg: DebugConfig): string[] {
  const known = new Set([...Object.keys(COMMON), ...Object.keys(branchProps(cfg.type)), "lastRunAt"]);
  return Object.keys(cfg).filter((k) => !known.has(k));
}

// An array of strings edits as one entry per line: `args` is almost always a
// short list, and a line is the shape people already have in their shell history.
export const linesOf = (v: any): string => Array.isArray(v) ? v.join("\n") : "";
export const toLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
// env edits as KEY=value per line, for the same reason.
export const envOf = (v: any): string =>
  v && typeof v === "object" ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join("\n") : "";
export const toEnv = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of toLines(s)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
};

// What a history row is FOR. An attach config has no `program` — its target is a
// pid — so the old `{h.program}` left an attach row as a bare type chip with
// nothing next to it, which is unreadable as soon as there are two of them.
export function histTarget(h: any): string {
  if (h.request === "attach") {
    const pid = h.pid ?? h.processId;
    if (pid != null) return `attach pid ${pid}`;
    if (h.connect) return `attach ${h.connect.host ?? "127.0.0.1"}:${h.connect.port ?? "?"}`;
    if (h.program) return `attach ${h.program}`;
    return "attach";
  }
  const args = (h.args as string[]) || [];
  return h.program + (args.length ? " " + args.join(" ") : "");
}
