// Inline values: where in the source each local's value is drawn while stopped.
// Pure, so tested without a browser (tests/inlinevalues.ts).
//
// This is a word scan, not a parse. It looks at the stopped function's lines
// from its header down to the stop line and puts each local on the LAST line it
// appears on, which is where the reader's eye already is when they ask "what is
// x now". Comments and string literals are blanked first so a name mentioned
// in either does not pull its value onto that line.

export type InlineVal = { name: string; text: string; full: string; changed: boolean };

export const INLINE_MAX = 40;

export function truncate(v: string, max = INLINE_MAX): string {
  const one = v.replace(/\s*\n\s*/g, " ");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

const HEADER_KW = /^\s*(?:(?:pub|export|async|static)\s+)*(?:def|fn|func|function)\b/;

// First line (1-based) of the function containing `stopLine`. C-family code is
// assumed to put a definition's header at column 0 and its closing brace there
// too, which holds for nearly all real code and costs nothing to check. Python,
// Go, JS and milo headers are found by keyword at any indent.
export function functionStart(lines: string[], stopLine: number): number {
  const lo = Math.max(1, stopLine - 400);
  for (let ln = stopLine; ln >= lo; ln--) {
    const s = lines[ln - 1] ?? "";
    if (HEADER_KW.test(s)) return ln;
    if (ln < stopLine && /^}/.test(s)) return ln + 1;
    if (/^[A-Za-z_]/.test(s) && s.includes("(") && !/^\s*#/.test(s)) return ln;
  }
  return lo;
}

// One line with comments and string/char literals replaced by spaces, so
// columns still line up. `inBlock` carries a C block comment across lines.
export function stripLine(s: string, hashComments: boolean, inBlock: boolean): { code: string; inBlock: boolean } {
  let out = "";
  let i = 0;
  // A C preprocessor line is not code the program runs.
  if (!hashComments && !inBlock && /^\s*#/.test(s)) return { code: "", inBlock };
  while (i < s.length) {
    if (inBlock) {
      const end = s.indexOf("*/", i);
      if (end < 0) { out += " ".repeat(s.length - i); i = s.length; break; }
      out += " ".repeat(end + 2 - i); i = end + 2; inBlock = false;
      continue;
    }
    const c = s[i], d = s[i + 1];
    if (c === "/" && d === "/") break;
    if (hashComments && c === "#") break;
    if (c === "/" && d === "*") { inBlock = true; out += "  "; i += 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1;
      out += " ".repeat(Math.min(j + 1, s.length) - i); i = j + 1;
      continue;
    }
    out += c; i++;
  }
  return { code: out, inBlock };
}

const IDENT = /^[A-Za-z_]\w*$/;

// Source line (1-based) → the values to draw at its end, in the order the names
// appear on that line. `changed` names are flagged for the changed style.
export function inlineValues(lines: string[], stopLine: number,
                             locals: { name: string; value: string }[],
                             lang: string, changed: Set<string> = new Set()): Map<number, InlineVal[]> {
  const out = new Map<number, InlineVal[]>();
  if (stopLine < 1 || stopLine > lines.length) return out;
  // A name the adapter lists twice (a shadowed variable) is drawn once, with the
  // first value: lldb lists the innermost scope first.
  const val = new Map<string, string>();
  for (const v of locals) if (IDENT.test(v.name) && !val.has(v.name)) val.set(v.name, v.value);
  if (val.size === 0) return out;

  const hash = lang === "python";
  const start = functionStart(lines, stopLine);
  // name → [line, column of its first use on that line]
  const last = new Map<string, [number, number]>();
  let inBlock = false;
  for (let ln = start; ln <= stopLine; ln++) {
    const r = stripLine(lines[ln - 1], hash, inBlock);
    inBlock = r.inBlock;
    const seen = new Set<string>();
    for (const m of r.code.matchAll(/[A-Za-z_]\w*/g)) {
      const name = m[0];
      if (!val.has(name) || seen.has(name)) continue;
      // `p.x` or `p->x`: the x there is a member, not the local named x.
      const before = r.code.slice(0, m.index).trimEnd();
      if (before.endsWith(".") || before.endsWith("->")) continue;
      seen.add(name);
      last.set(name, [ln, m.index!]);
    }
  }
  const byLine = new Map<number, [number, string][]>();
  for (const [name, [ln, col]] of last) (byLine.get(ln) ?? byLine.set(ln, []).get(ln)!).push([col, name]);
  for (const [ln, names] of byLine) {
    names.sort((a, b) => a[0] - b[0]);
    out.set(ln, names.map(([, name]) => {
      const full = val.get(name)!;
      return { name, text: `${name} = ${truncate(full)}`, full, changed: changed.has(name) };
    }));
  }
  return out;
}

// Which locals changed since the previous stop, carried across stops the way
// RegistersPanel carries register changes. Keys include the function, so a step
// into another function does not compare its `i` with the caller's. A stop that
// repeats the previous values exactly (lldb can report one step as two stops)
// keeps the previous marks instead of clearing them.
export function nextChanged(prev: Map<string, string>, marks: Set<string>, fn: string,
                            locals: { name: string; value: string }[]): { prev: Map<string, string>; marks: Set<string> } {
  const key = (n: string) => `${fn}\n${n}`;
  const anyDiff = locals.some((v) => prev.get(key(v.name)) !== v.value);
  if (!anyDiff) return { prev, marks };
  const next = new Map(prev);
  const m = new Set<string>();
  for (const v of locals) {
    const p = prev.get(key(v.name));
    if (p !== undefined && p !== v.value) m.add(v.name);
    next.set(key(v.name), v.value);
  }
  return { prev: next, marks: m };
}
