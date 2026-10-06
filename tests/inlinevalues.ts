// Inline values placement: pure, so tested without a browser.
// Usage: bun tests/inlinevalues.ts

import { inlineValues, functionStart, stripLine, truncate, nextChanged } from "../src/web/ui/src/inlineValues";

let pass = 0;
function ok(cond: any, label: string, detail?: any) {
  if (cond) { pass++; console.log(`  ok ${label}`); }
  else { console.error(`  FAIL ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ""); process.exit(1); }
}
// line → "a = 1, b = 2", for comparing whole placements at once.
const flat = (m: Map<number, { text: string }[]>) =>
  Object.fromEntries([...m].sort((a, b) => a[0] - b[0]).map(([ln, vs]) => [ln, vs.map((v) => v.text).join(", ")]));

// examples/nested/main.c, verbatim.
const nested = (await Bun.file(import.meta.dir + "/../examples/nested/main.c").text()).split("\n");

ok(functionStart(nested, 22) === 12, "main's header is found from inside its loop", functionStart(nested, 22));
ok(functionStart(nested, 8) === 5, "a static helper's header is found", functionStart(nested, 8));
ok(functionStart(nested, 12) === 12, "the header line itself starts its function");

{
  const locals = [
    { name: "shapes", value: "{...}" }, { name: "list", value: "0x600000c04040" },
    { name: "total", value: "0" }, { name: "i", value: "0" }, { name: "p", value: "3" },
    // Named only in push(), above main: must not be drawn there.
    { name: "n", value: "9" },
  ];
  const got = flat(inlineValues(nested, 22, locals, "cpp"));
  // list: 18 (the `list = push(list, ...)` loop, not its declaration on 17);
  // total: 20; p, shapes and i all on the stop line 22, in the order they appear.
  ok(got[18] === "list = 0x600000c04040", "the last line that names a local wins over its declaration", got);
  ok(got[20] === "total = 0", "a local last named above the stop shows there", got);
  ok(got[22] === "p = 3, shapes = {...}, i = 0", "several on one line read left to right", got);
  ok(!got[15] && !got[17], "an earlier mention draws nothing once a later one exists", got);
  ok(Object.keys(got).length === 3, "nothing below the stop line, nothing outside main", got);
}

{
  const src = [
    "int f(int n) {",
    "    int x = n; // x is not this one",
    "    printf(\"x=%d n\", x);",
    "    /* n and x",
    "       still a comment n */ int y = 2;",
    "    s.x = 3; q->n = 4;",
    "    return y;",
    "}",
  ];
  const got = flat(inlineValues(src, 7, [{ name: "x", value: "1" }, { name: "n", value: "5" }, { name: "y", value: "2" }], "cpp"));
  ok(got[3] === "x = 1", "a name in a string or comment does not move its value", got);
  ok(got[2] === "n = 5", "a member access (.n / ->n) is not the local n", got);
  ok(got[7] === "y = 2" && !got[5], "a block comment spans lines and code after it still counts", got);
}

{
  const py = ["def area(w, h):", "    # w is width", "    a = w * h", "    s = 'h'", "    return a"];
  const got = flat(inlineValues(py, 5, [{ name: "w", value: "2" }, { name: "h", value: "3" }, { name: "a", value: "6" }], "python"));
  ok(got[3] === "w = 2, h = 3" && got[5] === "a = 6", "python: # comments and quotes are skipped", got);
}

{
  const src = ["int main() {", "  char *s = buf;", "}"];
  const long = "0x16fdfe8a8 \"" + "a".repeat(80) + "\"";
  const v = inlineValues(src, 2, [{ name: "s", value: long }], "cpp").get(2)![0];
  ok(v.text.length <= "s = ".length + 40 && v.text.endsWith("…"), "a long value is cut at 40 characters", v.text);
  ok(v.full === long, "the full value is kept for the hover", v.full);
  ok(truncate("a\n  b") === "a b", "a multi-line value is drawn on one line");
}

{
  const src = ["int main() {", "  int i = 0;", "  i++;", "}"];
  const got = inlineValues(src, 3, [{ name: "i", value: "2" }, { name: "i", value: "9" }, { name: "[0]", value: "x" }], "cpp", new Set(["i"]));
  ok(got.get(3)?.length === 1 && got.get(3)![0].text === "i = 2", "a shadowed name is drawn once, first value", flat(got));
  ok(got.get(3)![0].changed, "a changed name is flagged");
  ok(inlineValues(src, 0, [{ name: "i", value: "1" }], "cpp").size === 0, "no stop line, no values");
}

{
  const L = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
  let st = nextChanged(new Map(), new Set(), "main", L({ i: "0", n: "5" }));
  ok(st.marks.size === 0, "the first stop marks nothing");
  st = nextChanged(st.prev, st.marks, "main", L({ i: "1", n: "5" }));
  ok(st.marks.has("i") && !st.marks.has("n"), "a value that moved is marked, one that did not is not", [...st.marks]);
  st = nextChanged(st.prev, st.marks, "main", L({ i: "1", n: "5" }));
  ok(st.marks.has("i"), "a duplicate stop with identical values keeps the marks", [...st.marks]);
  st = nextChanged(st.prev, st.marks, "helper", L({ i: "7" }));
  ok(st.marks.size === 0, "another function's i is not compared with main's", [...st.marks]);
}

ok(stripLine("#include <stdio.h>", false, false).code === "", "a preprocessor line is not code");

console.log(`\n${pass} passed`);
