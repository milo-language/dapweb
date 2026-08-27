// The debug-target form's rules, tested where they are pure. The drawer itself
// needs a browser and monaco; the decisions worth guarding — which fields a
// config gets, which keys the form admits it does not know, and the JSONC
// dialect both ends must agree on — live in configSchema.ts and do not.
//
// What this is really protecting: the form derives its fields FROM the schema
// that drives autocomplete, so the two halves of the drawer cannot describe the
// same key differently. A test that listed the expected fields by hand would be
// a third list to drift; these assert the derivation instead.
//
// Usage: bun tests/configform.ts

import {
  SCHEMA, COMMON, stripJsonc, fieldsFor, unknownKeys, branchProps,
  histTarget, linesOf, toLines, envOf, toEnv, ATTACH_ONLY, LAUNCH_ONLY,
} from "../src/web/ui/src/configSchema";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}
const keys = (fs: { key: string }[]) => fs.map((f) => f.key);

// ── fields come from the schema, not from a second list ──

{
  const { primary, advanced } = fieldsFor({ type: "lldb" });
  const all = [...keys(primary), ...keys(advanced)];
  ok(all.includes("program") && all.includes("args"), "a launch config offers program and args", all);
  ok(all.includes("initCommands"), "and the lldb branch's own keys", all);
  ok(!all.includes("module"), "but not another dialect's", all);
  ok(keys(primary)[0] === "type", "type leads the primary fields", keys(primary));
  ok(advanced.length > 0 && !keys(advanced).some((k) => keys(primary).includes(k)),
     "advanced holds the rest, with no key in both", { primary: keys(primary), advanced: keys(advanced) });
}
{
  const all = keys(fieldsFor({ type: "python" }).advanced).concat(keys(fieldsFor({ type: "python" }).primary));
  ok(all.includes("justMyCode") && !all.includes("initCommands"),
     "switching type switches the dialect-specific fields", all);
}

// ── launch vs attach hides what makes no sense ──

{
  const attach = fieldsFor({ type: "lldb", request: "attach" });
  const all = [...keys(attach.primary), ...keys(attach.advanced)];
  ok(all.includes("pid"), "attach offers pid", all);
  ok(!all.includes("args"), "and drops args, which an attach cannot use", all);
  const launch = fieldsFor({ type: "lldb" });
  const lall = [...keys(launch.primary), ...keys(launch.advanced)];
  ok(!lall.includes("pid"), "launch drops pid", lall);
}
// The two sets are the UI's own judgement, so guard them against overlap: a key
// in both would vanish from every config, which is invisible until someone needs it.
{
  const both = [...ATTACH_ONLY].filter((k) => LAUNCH_ONLY.has(k));
  ok(both.length === 0, "no key is both attach-only and launch-only", both);
  const known = new Set([...Object.keys(COMMON), ...(SCHEMA.allOf as any[]).flatMap((b) => Object.keys(b.then?.properties ?? {}))]);
  const orphan = [...ATTACH_ONLY, ...LAUNCH_ONLY].filter((k) => !known.has(k));
  ok(orphan.length === 0, "every hidden key is a key the schema actually has", orphan);
}

// ── keys the form does not know are admitted, never hidden ──

{
  const cfg = { type: "lldb", program: "/x", someAdapterKey: 1, initCommands: [] };
  ok(unknownKeys(cfg).join() === "someAdapterKey", "an unenumerated key is reported", unknownKeys(cfg));
  ok(unknownKeys({ type: "lldb", lastRunAt: 1 }).length === 0,
     "the server's own history stamp is not reported as the user's key");
  // A key belonging to ANOTHER dialect is unknown here, which is the honest
  // answer: it will not be offered as a field either.
  ok(unknownKeys({ type: "lldb", justMyCode: true }).join() === "justMyCode",
     "a key from a different dialect counts as unknown");
}
{
  ok(Object.keys(branchProps("go")).includes("mode"), "branchProps finds the go branch");
  ok(Object.keys(branchProps("nosuch")).length === 0, "and an unknown type has no branch");
}

// ── the list/env editors round-trip ──

ok(linesOf(toLines("a\nb\n\n c ")) === "a\nb\nc", "a list round-trips through lines, blanks dropped");
ok(JSON.stringify(toEnv("A=1\nB=x=y")) === JSON.stringify({ A: "1", B: "x=y" }),
   "env splits on the FIRST = so a value may contain one", toEnv("A=1\nB=x=y"));
ok(envOf(toEnv("A=1\nB=2")) === "A=1\nB=2", "and round-trips");
ok(toEnv("novalue").A === undefined && Object.keys(toEnv("novalue")).length === 0,
   "a line with no = is dropped rather than becoming an empty var");

// ── the JSONC dialect the server also accepts ──

ok(JSON.parse(stripJsonc(`{"a":1,} // trailing`)).a === 1, "trailing commas and line comments strip");
ok(JSON.parse(stripJsonc(`{"a":"//not a comment"}`)).a === "//not a comment",
   "but not inside a string");
ok(JSON.parse(stripJsonc(`{/* block */"a":1}`)).a === 1, "block comments strip");

// ── history rows say what they would debug ──

ok(histTarget({ program: "/x", args: ["a"] }) === "/x a", "a launch row names program and args");
ok(histTarget({ request: "attach", pid: 42 }) === "attach pid 42", "an attach row names the pid");
ok(histTarget({ request: "attach", processId: 42 }) === "attach pid 42", "either spelling of it");
ok(histTarget({ request: "attach", connect: { host: "h", port: 1 } }) === "attach h:1",
   "and a remote attach names where it connects");

console.log(`\nconfigform: ${pass} assertions passed`);
