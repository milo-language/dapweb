// What an address lands in: the memory map classified into stack / heap / code
// / const / data. One classifier is shared by Registers and Memory so a hue
// means the same thing in both.
import type { Region } from "./session";

export type RegionType = "stack" | "heap" | "code" | "const" | "data";
// A region with numeric bounds + its classified type — the shared substrate for
// both the addr→type classifier and the birds-eye region map.
type RegionSpan = { s: number; e: number; type: RegionType | null; name: string; perms: string };

// Classify each mapped region into a type, in map order. The stack is whichever
// writable region holds sp (only the client knows sp). Heuristics, honest but
// coarse: executable→code, __DATA_CONST/__LINKEDIT/ro→const, __DATA→data,
// writable-anon→heap.
export function classifyRegions(regions: Region[], spHex: string): RegionSpan[] {
  const sp = spHex ? parseInt(spHex, 16) : NaN;
  const bounds = regions.map((r) => ({ s: parseInt(r.s, 16), e: parseInt(r.e, 16), r }));
  const spIdx = bounds.findIndex((b) => !isNaN(sp) && sp >= b.s && sp < b.e);
  return bounds.map((b, i) => {
    const r = b.r;
    let type: RegionType | null;
    if (r.p.includes("x")) type = "code";
    else if (r.n === "__DATA_CONST" || r.n === "__LINKEDIT") type = "const";
    else if (r.n.startsWith("__DATA")) type = "data";
    else if (r.p.includes("w")) type = i === spIdx ? "stack" : (r.n === "" ? "heap" : "data");
    else if (r.p === "r--") type = "const";
    else type = null;   // "---" unmapped, or read-only anon
    return { s: b.s, e: b.e, type, name: r.n, perms: r.p };
  });
}

// Build a classifier addr→RegionType over the current memory map.
export function buildRegionClassifier(regions: Region[], spHex: string): (addr: string) => RegionType | null {
  const spans = classifyRegions(regions, spHex);
  return (addr: string) => {
    const a = parseInt(addr, 16);
    if (isNaN(a)) return null;
    for (const s of spans) if (a >= s.s && a < s.e) return s.type;
    return null;
  };
}

// Plain-English tooltip per region type — the color legend is meaningless
// without knowing what "const" or "__TEXT" actually is.
export const REGION_HELP: Record<RegionType, string> = {
  stack: "stack — local variables & call frames (grows per function call)",
  heap:  "heap — dynamically allocated memory (malloc / new)",
  code:  "code — executable machine instructions (the program itself, __TEXT)",
  const: "const — read-only data: string literals, constants, linker tables",
  data:  "data — global & static variables (__DATA)",
};
